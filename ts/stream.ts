import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  type VoiceConnection,
  VoiceConnectionDisconnectReason,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from "@discordjs/voice";
import {
  ChannelType,
  Client,
  DiscordAPIError,
  Events,
  GatewayIntentBits,
  type GuildBasedChannel,
  PermissionFlagsBits,
} from "discord.js";
import type { Settings } from "./cli.ts";
import { debug, describeError, error, info, isDebugEnabled, warn } from "./log.ts";
import {
  type PreparedAudioSource,
  createFfmpegOpusStream,
  createPulseMonitorSource,
  createSpotifySource,
  createSwitchingStdinStream,
  createWindowsDshowSource,
} from "./sources.ts";

const VOICE_READY_TIMEOUT_MS = 30_000;
const VOICE_RECONNECT_GRACE_MS = 5_000;
const VOICE_RECONNECT_INITIAL_DELAY_MS = 1_000;
const VOICE_RECONNECT_MAX_DELAY_MS = 30_000;
const INITIAL_PLAYBACK_TIMEOUT_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

/** Delay before reconnect attempt `attempt` (1-based): immediate, then exponential backoff. */
export function reconnectDelayMs(attempt: number): number {
  if (attempt <= 1) {
    return 0;
  }

  return Math.min(VOICE_RECONNECT_INITIAL_DELAY_MS * 2 ** (attempt - 2), VOICE_RECONNECT_MAX_DELAY_MS);
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

type VoiceTargetChannel = GuildBasedChannel & {
  type: ChannelType.GuildVoice | ChannelType.GuildStageVoice;
};

function isVoiceTargetChannel(channel: unknown): channel is VoiceTargetChannel {
  if (!channel || typeof channel !== "object" || !("type" in channel)) {
    return false;
  }

  return channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice;
}

export function createAudioSource(settings: Settings): PreparedAudioSource {
  switch (settings.audioSource) {
    case "spotify":
      return createSpotifySource(settings);
    case "pulse-monitor":
      return createPulseMonitorSource(settings);
    case "windows-dshow":
      return createWindowsDshowSource(settings);
    case "stdin":
      return createSwitchingStdinStream(settings.inputFormat);
  }
}

async function waitForReady(client: Client): Promise<void> {
  if (client.isReady()) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const onReady = (): void => {
      cleanup();
      resolve();
    };

    const onError = (clientError: Error): void => {
      cleanup();
      reject(clientError);
    };

    const cleanup = (): void => {
      client.off(Events.ClientReady, onReady);
      client.off(Events.Error, onError);
    };

    client.once(Events.ClientReady, onReady);
    client.once(Events.Error, onError);
  });
}

async function fetchVoiceChannel(client: Client, voiceChannelId: string): Promise<VoiceTargetChannel> {
  let channel: unknown;
  try {
    channel = await client.channels.fetch(voiceChannelId);
  } catch (fetchError) {
    if (fetchError instanceof DiscordAPIError && (fetchError.code === 10003 || fetchError.code === 50001)) {
      throw new Error(
        `cannot access channel ${voiceChannelId}: ${fetchError.message}. Check the ID and make sure the bot was added to that server and can view the channel.`,
      );
    }

    throw fetchError;
  }

  if (!channel) {
    throw new Error(`failed to find voice channel ${voiceChannelId}`);
  }

  if (!isVoiceTargetChannel(channel)) {
    throw new Error(`channel ${voiceChannelId} is not a voice or stage channel`);
  }

  const me = await channel.guild.members.fetchMe();
  const permissions = channel.permissionsFor(me);
  const missing = (
    [
      ["View Channel", PermissionFlagsBits.ViewChannel],
      ["Connect", PermissionFlagsBits.Connect],
      ["Speak", PermissionFlagsBits.Speak],
    ] as const
  )
    .filter(([, flag]) => !permissions.has(flag))
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`the bot is missing permissions in channel ${channel.name}: ${missing.join(", ")}`);
  }

  if (channel.full && !permissions.has(PermissionFlagsBits.MoveMembers)) {
    throw new Error(`channel ${channel.name} is full`);
  }

  return channel;
}

async function promoteStageSpeaker(channel: GuildBasedChannel): Promise<void> {
  if (channel.type !== ChannelType.GuildStageVoice) {
    return;
  }

  const me = await channel.guild.members.fetchMe();

  try {
    await me.voice.setSuppressed(false);
    info("unsuppressed bot in stage channel");
  } catch (unsuppressError) {
    warn(`failed to unsuppress the bot in the stage channel: ${describeError(unsuppressError)}. trying request-to-speak instead`);

    try {
      await me.voice.setRequestToSpeak(true);
      info("requested to speak in stage channel");
    } catch (requestError) {
      warn(`failed to request speaking privileges in the stage channel: ${describeError(requestError)}`);
    }
  }
}

function describeVoiceDisconnectedState(connection: VoiceConnection): string {
  const state = connection.state;
  if (state.status !== VoiceConnectionStatus.Disconnected) {
    return state.status;
  }

  switch (state.reason) {
    case VoiceConnectionDisconnectReason.WebSocketClose:
      return `websocket close ${state.closeCode}`;
    case VoiceConnectionDisconnectReason.AdapterUnavailable:
      return "adapter unavailable";
    case VoiceConnectionDisconnectReason.EndpointRemoved:
      return "endpoint removed";
    case VoiceConnectionDisconnectReason.Manual:
      return "manual disconnect";
  }

  return "unknown disconnect";
}

/**
 * Joins the configured voice channel and streams the selected audio source
 * until the source ends, a fatal error occurs, or the process is signalled.
 * Never returns normally: the process exits via shutdown().
 */
export async function runStream(settings: Settings): Promise<void> {
  const audioSourceHandle = createAudioSource(settings);

  let connection: VoiceConnection | undefined;
  let stopTranscoder: (() => void) | undefined;
  let playbackStarted = false;
  let shuttingDown = false;

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });

  const shutdown = async (code: number): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    // Don't let a hung Discord teardown keep the process alive.
    setTimeout(() => process.exit(code), SHUTDOWN_TIMEOUT_MS).unref();

    try {
      connection?.destroy();
    } catch (connectionError) {
      debug(`failed to destroy voice connection cleanly: ${describeError(connectionError)}`);
    }

    try {
      stopTranscoder?.();
    } catch (transcoderError) {
      debug(`failed to stop ffmpeg transcoder cleanly: ${describeError(transcoderError)}`);
    }

    try {
      audioSourceHandle.stop();
    } catch (sourceError) {
      debug(`failed to stop audio source cleanly: ${describeError(sourceError)}`);
    }

    try {
      await client.destroy();
    } catch (clientError) {
      debug(`failed to destroy Discord client cleanly: ${describeError(clientError)}`);
    }

    process.exit(code);
  };

  const fail = (message: string): void => {
    if (shuttingDown) {
      return;
    }

    error(message);
    void shutdown(1);
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      warn(`received ${signal} again; exiting immediately`);
      process.exit(130);
    }

    info(`received ${signal}; shutting down`);
    void shutdown(0);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  client.on(Events.Error, (clientError) => {
    error(clientError.stack ?? String(clientError));
  });

  if (isDebugEnabled()) {
    client.on(Events.Debug, (message) => debug(`[gateway] ${message}`));
  }

  audioSourceHandle.stream.on("error", (sourceError) => {
    fail(`[source] ${sourceError.message}`);
  });

  try {
    info("logging into Discord");
    await client.login(settings.botToken);
    await waitForReady(client);

    if (!client.user) {
      throw new Error("discord client became ready without a user");
    }

    info(`discord bot is ready as ${client.user.tag}`);
    client.user.setActivity(settings.botActivity);

    const voiceChannel = await fetchVoiceChannel(client, settings.voiceChannelId);
    info(`found channel "${voiceChannel.name}" in guild "${voiceChannel.guild.name}", attempting to connect...`);

    const player = createAudioPlayer({
      behaviors: {
        // Keep live sources flowing during reconnect windows instead of backpressuring stdin/librespot.
        noSubscriber: NoSubscriberBehavior.Play,
        // Live sources have gaps (e.g. Spotify paused); keep sending silence instead of ending playback.
        // The player still goes idle once the stream really ends.
        maxMissedFrames: Number.POSITIVE_INFINITY,
      },
    });

    player.on("debug", (message) => debug(`[player] ${message}`));
    player.on("error", (playerError) => {
      fail(`[player] ${playerError.stack ?? playerError.message}`);
    });
    player.on(AudioPlayerStatus.Buffering, () => {
      info("audio player is buffering");
    });
    player.on(AudioPlayerStatus.Playing, () => {
      playbackStarted = true;
      info("piping successfully...");
    });
    player.on(AudioPlayerStatus.Paused, () => {
      warn("audio player is paused");
    });
    player.on(AudioPlayerStatus.AutoPaused, () => {
      warn("audio player is auto-paused");
    });
    player.on(AudioPlayerStatus.Idle, () => {
      if (shuttingDown) {
        return;
      }

      info(playbackStarted ? "audio input ended; disconnecting" : "audio input ended before playback started; disconnecting");
      void shutdown(0);
    });

    let reconnectingVoiceConnection: Promise<void> | undefined;
    const voiceConnectionHandlers = new WeakSet<VoiceConnection>();

    const createOrReuseVoiceConnection = (): VoiceConnection => {
      // joinVoiceChannel returns the existing connection for this guild if there is one.
      const nextConnection = joinVoiceChannel({
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        channelId: voiceChannel.id,
        daveEncryption: true,
        debug: isDebugEnabled(),
        guildId: voiceChannel.guild.id,
        selfDeaf: true,
        selfMute: false,
      });

      connection = nextConnection;

      if (!voiceConnectionHandlers.has(nextConnection)) {
        voiceConnectionHandlers.add(nextConnection);

        nextConnection.on("debug", (message) => debug(`[voice] ${message}`));
        nextConnection.on("error", (connectionError) => error(`[voice] ${connectionError.stack ?? connectionError}`));

        nextConnection.on(VoiceConnectionStatus.Disconnected, () => {
          if (shuttingDown || reconnectingVoiceConnection) {
            return;
          }

          warn(`voice connection disconnected (${describeVoiceDisconnectedState(nextConnection)}); attempting recovery`);
          void ensureVoiceConnection("voice disconnect");
        });

        nextConnection.on(VoiceConnectionStatus.Destroyed, () => {
          if (shuttingDown || reconnectingVoiceConnection) {
            return;
          }

          connection = undefined;
          warn("voice connection was destroyed; attempting to create a fresh connection");
          void ensureVoiceConnection("voice destroyed");
        });
      }

      return nextConnection;
    };

    const rejoin = (target: VoiceConnection): void => {
      target.rejoin({ channelId: voiceChannel.id, selfDeaf: true, selfMute: false });
    };

    const ensureVoiceConnection = async (trigger: string): Promise<void> => {
      if (reconnectingVoiceConnection) {
        return reconnectingVoiceConnection;
      }

      reconnectingVoiceConnection = (async () => {
        let attempt = 0;

        while (!shuttingDown) {
          attempt++;

          const delayMs = reconnectDelayMs(attempt);
          if (delayMs > 0) {
            warn(`voice reconnect attempt ${attempt} in ${delayMs}ms (${trigger})`);
            await sleep(delayMs);
            if (shuttingDown) {
              return;
            }
          }

          try {
            const nextConnection = createOrReuseVoiceConnection();

            if (nextConnection.state.status === VoiceConnectionStatus.Disconnected) {
              if (
                nextConnection.state.reason === VoiceConnectionDisconnectReason.WebSocketClose &&
                nextConnection.state.closeCode === 4014
              ) {
                // 4014 can mean "moved to another channel"; give Discord a moment to reconnect on its own.
                try {
                  await Promise.race([
                    entersState(nextConnection, VoiceConnectionStatus.Signalling, VOICE_RECONNECT_GRACE_MS),
                    entersState(nextConnection, VoiceConnectionStatus.Connecting, VOICE_RECONNECT_GRACE_MS),
                    entersState(nextConnection, VoiceConnectionStatus.Ready, VOICE_RECONNECT_GRACE_MS),
                  ]);
                } catch {
                  rejoin(nextConnection);
                }
              } else {
                rejoin(nextConnection);
              }
            }

            await entersState(nextConnection, VoiceConnectionStatus.Ready, VOICE_READY_TIMEOUT_MS);

            if (!nextConnection.subscribe(player)) {
              throw new Error("failed to subscribe the audio player to the voice connection");
            }

            await promoteStageSpeaker(voiceChannel);

            if (trigger === "initial connection" && attempt === 1) {
              info("joined channel successfully!");
            } else {
              info(`voice connection recovered after ${attempt} attempt(s)`);
            }

            return;
          } catch (reconnectError) {
            warn(`voice connection attempt ${attempt} failed: ${describeError(reconnectError)}`);

            if (connection?.state.status === VoiceConnectionStatus.Destroyed) {
              connection = undefined;
            }
          }
        }
      })().finally(() => {
        reconnectingVoiceConnection = undefined;
      });

      return reconnectingVoiceConnection;
    };

    await ensureVoiceConnection("initial connection");
    if (shuttingDown) {
      return;
    }

    info(audioSourceHandle.startupMessage);
    const transcoder = createFfmpegOpusStream(settings.ffmpegPath, audioSourceHandle.stream, audioSourceHandle.ffmpegInput, {
      volume: settings.volume,
      opusBitrate: settings.opusBitrate,
    });
    stopTranscoder = transcoder.stop;
    transcoder.events.on("error", (transcoderError) => {
      fail(transcoderError.message);
    });

    const resource = createAudioResource(transcoder.stream, {
      inputType: StreamType.OggOpus,
      metadata: null,
    });
    player.play(resource);
    audioSourceHandle.start();

    if (audioSourceHandle.awaitInitialPlayback) {
      try {
        await entersState(player, AudioPlayerStatus.Playing, INITIAL_PLAYBACK_TIMEOUT_MS);
      } catch {
        if (!shuttingDown && !playbackStarted) {
          warn(audioSourceHandle.ffmpegInput.waitingMessage);
        }
      }
    }
  } catch (runError) {
    fail(runError instanceof Error && isDebugEnabled() ? (runError.stack ?? runError.message) : describeError(runError));
  }
}
