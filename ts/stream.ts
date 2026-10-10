import {
  type AudioResource,
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
  ActivityType,
  ChannelType,
  Client,
  DiscordAPIError,
  Events,
  GatewayIntentBits,
  type GuildBasedChannel,
  PermissionFlagsBits,
  type User,
} from "discord.js";
import type { Settings } from "./cli.ts";
import { debug, describeError, error, info, isDebugEnabled, warn } from "./log.ts";
import { createMediaSource, expandInputs } from "./media.ts";
import { createPipeWireSource, resolvePipeWireTarget } from "./pipewire.ts";
import {
  type PreparedAudioSource,
  createAvfoundationSource,
  createCommandSource,
  createFfmpegOpusStream,
  createPulseMonitorSource,
  createRealtimePacer,
  pcmBytesPerSecond,
  createSwitchingStdinStream,
  createWindowsDshowSource,
} from "./sources.ts";
import { createSpotifySource, formatLibrespotName } from "./spotify.ts";
import { createWindowsLoopbackSource } from "./windows-loopback.ts";

const VOICE_READY_TIMEOUT_MS = 30_000;
const VOICE_RECONNECT_GRACE_MS = 5_000;
const VOICE_RECONNECT_INITIAL_DELAY_MS = 1_000;
const VOICE_RECONNECT_MAX_DELAY_MS = 30_000;
const INITIAL_PLAYBACK_TIMEOUT_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const PRESENCE_MIN_INTERVAL_MS = 5_000;
const ACTIVITY_MAX_LENGTH = 128;

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

export async function createAudioSource(settings: Settings, botName: string): Promise<PreparedAudioSource> {
  switch (settings.audioSource) {
    case "spotify":
      return createSpotifySource({
        ...settings,
        librespotName: formatLibrespotName(settings.librespotName, botName),
      });
    case "pulse-monitor":
      return createPulseMonitorSource(settings);
    case "pipewire":
      return createPipeWireSource({
        pwRecordPath: settings.pwRecordPath,
        target: await resolvePipeWireTarget(settings.audioDevice),
      });
    case "windows-dshow":
      return createWindowsDshowSource(settings);
    case "windows-loopback":
      return createWindowsLoopbackSource(settings);
    case "macos-avfoundation":
      return createAvfoundationSource(settings);
    case "media": {
      const inputs = await expandInputs(settings.inputs);
      if (inputs.length === 0) {
        throw new Error("no playable audio files were found in the given inputs");
      }

      return createMediaSource({ ffmpegPath: settings.ffmpegPath, inputs, loop: settings.loop });
    }
    case "command":
      return createCommandSource(settings);
    case "stdin":
      return createSwitchingStdinStream(settings);
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

/** Names of the voice permissions the bot lacks in `channel` (empty if it can join and speak). */
function missingVoicePermissions(channel: VoiceTargetChannel): string[] {
  const me = channel.guild.members.me;
  if (!me) {
    return [];
  }

  const permissions = channel.permissionsFor(me);
  const missing: string[] = (
    [
      ["View Channel", PermissionFlagsBits.ViewChannel],
      ["Connect", PermissionFlagsBits.Connect],
      ["Speak", PermissionFlagsBits.Speak],
    ] as const
  )
    .filter(([, flag]) => !permissions.has(flag))
    .map(([name]) => name);

  if (channel.full && !permissions.has(PermissionFlagsBits.MoveMembers)) {
    missing.push("a free slot (the channel is full)");
  }

  return missing;
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

  await channel.guild.members.fetchMe();
  const missing = missingVoicePermissions(channel);
  if (missing.length > 0) {
    throw new Error(`the bot is missing permissions in channel ${channel.name}: ${missing.join(", ")}`);
  }

  return channel;
}

async function fetchFollowedUser(client: Client, userId: string): Promise<User> {
  try {
    return await client.users.fetch(userId);
  } catch (fetchError) {
    if (fetchError instanceof DiscordAPIError && fetchError.code === 10013) {
      throw new Error(`unknown Discord user ${userId}`);
    }

    throw fetchError;
  }
}

function findUserVoiceChannel(client: Client, userId: string): VoiceTargetChannel | undefined {
  for (const guild of client.guilds.cache.values()) {
    const channel = guild.voiceStates.cache.get(userId)?.channel;
    if (isVoiceTargetChannel(channel)) {
      return channel;
    }
  }

  return undefined;
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

export function truncateActivity(text: string): string {
  return text.length > ACTIVITY_MAX_LENGTH ? `${text.slice(0, ACTIVITY_MAX_LENGTH - 1)}…` : text;
}

/** Shows the now-playing title as the bot's activity, rate limited to stay within Discord's presence limits. */
class PresenceUpdater {
  private desired: string | null = null;
  private applied: string | null | undefined;
  private lastUpdate = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly client: Client,
    private readonly defaultActivity: string,
  ) {}

  set(title: string | null): void {
    this.desired = title ? truncateActivity(title) : null;
    if (this.timer) {
      return;
    }

    const wait = Math.max(0, this.lastUpdate + PRESENCE_MIN_INTERVAL_MS - Date.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.apply();
    }, wait);
    this.timer.unref();
  }

  private apply(): void {
    if (this.desired === this.applied || !this.client.user) {
      return;
    }

    this.applied = this.desired;
    this.lastUpdate = Date.now();
    if (this.desired) {
      this.client.user.setActivity(this.desired, { type: ActivityType.Listening });
    } else {
      this.client.user.setActivity(this.defaultActivity);
    }
  }
}

/**
 * Joins the configured voice channel (or follows a user between channels) and
 * streams the selected audio source until the source ends, a fatal error
 * occurs, or the process is signalled. The process exits via shutdown().
 */
export async function runStream(settings: Settings): Promise<void> {
  let audioSourceHandle: PreparedAudioSource | undefined;
  let connection: VoiceConnection | undefined;
  let target: VoiceTargetChannel | undefined;
  let stopTranscoder: (() => void) | undefined;
  let playbackStarted = false;
  let shuttingDown = false;
  const followUserId = settings.followUserId;

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
      audioSourceHandle?.stop();
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

  try {
    info("logging into Discord");
    await client.login(settings.botToken);
    await waitForReady(client);

    if (!client.user) {
      throw new Error("discord client became ready without a user");
    }

    info(`discord bot is ready as ${client.user.tag}`);
    client.user.setActivity(settings.botActivity);

    // Created after login so sources can use the bot's name (e.g. the Spotify Connect device name).
    const source = await createAudioSource(settings, client.user.displayName);
    audioSourceHandle = source;
    source.stream.on("error", (sourceError) => {
      fail(`[source] ${sourceError.message}`);
    });

    const presence = new PresenceUpdater(client, settings.botActivity);
    if (settings.nowPlaying && source.nowPlaying) {
      source.nowPlaying.on("change", (title) => presence.set(title));
    }

    const player = createAudioPlayer({
      behaviors: {
        // Live sources keep flowing while the bot is not in a channel instead of backpressuring
        // stdin/librespot/capture; finite media pauses so nothing is played to an empty room.
        noSubscriber: source.pauseWhenUnheard ? NoSubscriberBehavior.Pause : NoSubscriberBehavior.Play,
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
    player.on(AudioPlayerStatus.AutoPaused, () => {
      info("nobody is listening; pausing playback");
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
    const intentionallyDestroyed = new WeakSet<VoiceConnection>();
    let firstConnection: (() => void) | undefined;
    const firstConnected = new Promise<void>((resolve) => {
      firstConnection = resolve;
    });

    const leaveVoice = (): void => {
      if (!connection) {
        return;
      }

      intentionallyDestroyed.add(connection);
      try {
        connection.destroy();
      } catch (destroyError) {
        debug(`failed to destroy voice connection: ${describeError(destroyError)}`);
      }
      connection = undefined;
    };

    const attachConnectionHandlers = (nextConnection: VoiceConnection): void => {
      if (voiceConnectionHandlers.has(nextConnection)) {
        return;
      }

      voiceConnectionHandlers.add(nextConnection);
      nextConnection.on("debug", (message) => debug(`[voice] ${message}`));
      nextConnection.on("error", (connectionError) => error(`[voice] ${connectionError.stack ?? connectionError}`));

      nextConnection.on(VoiceConnectionStatus.Disconnected, () => {
        if (shuttingDown || reconnectingVoiceConnection || !target || nextConnection !== connection) {
          return;
        }

        warn(`voice connection disconnected (${describeVoiceDisconnectedState(nextConnection)}); attempting recovery`);
        void ensureVoiceConnection("voice disconnect");
      });

      nextConnection.on(VoiceConnectionStatus.Destroyed, () => {
        if (shuttingDown || intentionallyDestroyed.has(nextConnection) || nextConnection !== connection) {
          return;
        }

        connection = undefined;
        if (target && !reconnectingVoiceConnection) {
          warn("voice connection was destroyed; attempting to create a fresh connection");
          void ensureVoiceConnection("voice destroyed");
        }
      });
    };

    const rejoin = (existing: VoiceConnection, channel: VoiceTargetChannel): void => {
      existing.rejoin({ channelId: channel.id, selfDeaf: true, selfMute: false });
    };

    /** Points the existing connection at `channel` (same guild) or creates a new one. */
    const connectTo = async (channel: VoiceTargetChannel): Promise<VoiceConnection> => {
      const existing = connection;
      if (
        existing &&
        existing.state.status !== VoiceConnectionStatus.Destroyed &&
        existing.joinConfig.guildId === channel.guild.id
      ) {
        if (existing.state.status === VoiceConnectionStatus.Disconnected) {
          if (
            existing.state.reason === VoiceConnectionDisconnectReason.WebSocketClose &&
            existing.state.closeCode === 4014 &&
            existing.joinConfig.channelId === channel.id
          ) {
            // 4014 can mean "moved to another channel"; give Discord a moment to reconnect on its own.
            try {
              await Promise.race([
                entersState(existing, VoiceConnectionStatus.Signalling, VOICE_RECONNECT_GRACE_MS),
                entersState(existing, VoiceConnectionStatus.Connecting, VOICE_RECONNECT_GRACE_MS),
                entersState(existing, VoiceConnectionStatus.Ready, VOICE_RECONNECT_GRACE_MS),
              ]);
            } catch {
              rejoin(existing, channel);
            }
          } else {
            rejoin(existing, channel);
          }
        } else if (existing.joinConfig.channelId !== channel.id) {
          rejoin(existing, channel);
        }

        return existing;
      }

      if (existing) {
        leaveVoice();
      }

      const nextConnection = joinVoiceChannel({
        adapterCreator: channel.guild.voiceAdapterCreator,
        channelId: channel.id,
        daveEncryption: true,
        debug: isDebugEnabled(),
        guildId: channel.guild.id,
        selfDeaf: true,
        selfMute: false,
      });
      connection = nextConnection;
      attachConnectionHandlers(nextConnection);
      return nextConnection;
    };

    /** Connects to the current target, retrying with backoff until it is reached or the target goes away. */
    const ensureVoiceConnection = async (trigger: string): Promise<void> => {
      if (reconnectingVoiceConnection) {
        return reconnectingVoiceConnection;
      }

      reconnectingVoiceConnection = (async () => {
        let attempt = 0;

        while (!shuttingDown && target) {
          attempt++;
          const channel = target;

          const delayMs = reconnectDelayMs(attempt);
          if (delayMs > 0) {
            warn(`voice connection attempt ${attempt} in ${delayMs}ms (${trigger})`);
            await sleep(delayMs);
            if (shuttingDown || target !== channel) {
              attempt = 0;
              continue;
            }
          }

          try {
            const nextConnection = await connectTo(channel);
            await entersState(nextConnection, VoiceConnectionStatus.Ready, VOICE_READY_TIMEOUT_MS);
            if (target !== channel) {
              // The target changed while connecting; go again for the new one.
              attempt = 0;
              continue;
            }

            if (!nextConnection.subscribe(player)) {
              throw new Error("failed to subscribe the audio player to the voice connection");
            }

            await promoteStageSpeaker(channel);
            info(
              attempt === 1
                ? `joined "${channel.name}" in "${channel.guild.name}"`
                : `voice connection to "${channel.name}" recovered after ${attempt} attempt(s)`,
            );
            firstConnection?.();
            return;
          } catch (reconnectError) {
            if (target !== channel) {
              attempt = 0;
              continue;
            }

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

    const setTarget = (channel: VoiceTargetChannel | undefined, reason: string): void => {
      if (channel?.id === target?.id) {
        return;
      }

      if (channel) {
        const missing = missingVoicePermissions(channel);
        if (missing.length > 0) {
          warn(`cannot join "${channel.name}": the bot is missing ${missing.join(", ")}`);
          channel = undefined;
        }
      }

      target = channel;
      if (!channel) {
        if (connection) {
          info(`leaving voice (${reason})`);
          leaveVoice();
        }
        return;
      }

      info(`${connection ? "moving" : "connecting"} to "${channel.name}" in "${channel.guild.name}" (${reason})`);
      void ensureVoiceConnection(reason);
    };

    if (followUserId) {
      const user = await fetchFollowedUser(client, followUserId);
      client.on(Events.VoiceStateUpdate, (oldState, newState) => {
        if (newState.id !== followUserId || oldState.channelId === newState.channelId) {
          return;
        }

        const channel = isVoiceTargetChannel(newState.channel) ? newState.channel : undefined;
        // When switching servers, the "left" event for the old server can arrive after the "joined" event.
        if (!channel && target && target.guild.id !== newState.guild.id) {
          return;
        }

        setTarget(channel, channel ? `${user.username} joined it` : `${user.username} left voice`);
      });

      const current = findUserVoiceChannel(client, followUserId);
      if (current) {
        setTarget(current, `following ${user.username}`);
      } else {
        info(`waiting for ${user.username} to join a voice channel the bot can see`);
      }
    } else {
      setTarget(await fetchVoiceChannel(client, settings.voiceChannelId), "configured channel");
    }

    // Start streaming once the bot is first in a channel, so stdin backlog and playlists are not wasted.
    await firstConnected;
    if (shuttingDown) {
      return;
    }

    info(source.startupMessage);
    // The resource is created below; the pacer only reads its position once audio flows.
    let resource: AudioResource<null> | undefined;
    const bytesPerSecond = pcmBytesPerSecond(source.ffmpegInput);
    const transcoderInput =
      source.fasterThanRealtime && bytesPerSecond
        ? createRealtimePacer(source.stream, bytesPerSecond, () => resource?.playbackDuration ?? 0)
        : source.stream;
    const transcoder = createFfmpegOpusStream(settings.ffmpegPath, transcoderInput, source.ffmpegInput, {
      volume: settings.volume,
      opusBitrate: settings.opusBitrate,
      audioFilter: settings.audioFilter,
    });
    stopTranscoder = transcoder.stop;
    transcoder.events.on("error", (transcoderError) => {
      fail(transcoderError.message);
    });

    resource = createAudioResource(transcoder.stream, {
      inputType: StreamType.OggOpus,
      metadata: null,
    });
    player.play(resource);
    source.start();

    if (source.awaitInitialPlayback) {
      try {
        await entersState(player, AudioPlayerStatus.Playing, INITIAL_PLAYBACK_TIMEOUT_MS);
      } catch {
        if (!shuttingDown && !playbackStarted) {
          warn(source.ffmpegInput.waitingMessage);
        }
      }
    }
  } catch (runError) {
    fail(runError instanceof Error && isDebugEnabled() ? (runError.stack ?? runError.message) : describeError(runError));
  }
}
