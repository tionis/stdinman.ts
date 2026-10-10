import { AudioPlayerStatus, NoSubscriberBehavior, createAudioPlayer } from "@discordjs/voice";
import { ActivityType, Client, Events, GatewayIntentBits } from "discord.js";
import { EventEmitter } from "node:events";
import { type CliValues, type Settings, UsageError, parseCli, resolveSettings, validateRunSettings } from "./cli.ts";
import { type StdinmanConfig, loadConfig, parseVolume } from "./config.ts";
import { type ControlResponse, defaultSocketPath, startControlServer } from "./control.ts";
import { debug, describeError, error, info, isDebugEnabled, warn } from "./log.ts";
import { AudioPipeline } from "./pipeline.ts";
import { type VoiceTarget, VoiceManager, waitForReady } from "./voice.ts";

const SHUTDOWN_TIMEOUT_MS = 5_000;
const PRESENCE_MIN_INTERVAL_MS = 5_000;
const ACTIVITY_MAX_LENGTH = 128;
const ACTIVITY_CHECK_INTERVAL_MS = 1_000;
const RESTART_INITIAL_DELAY_MS = 2_000;
const RESTART_MAX_DELAY_MS = 60_000;
/** A source that ran this long resets the restart backoff. */
const RESTART_STABLE_MS = 60_000;

export type EngineMode = "oneshot" | "serve";
export type Override = "auto" | "join" | "leave";

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
    private defaultActivity: string,
  ) {}

  setDefault(activity: string): void {
    this.defaultActivity = activity;
    this.applied = undefined;
    this.set(this.desired);
  }

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

  get current(): string | null {
    return this.desired;
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
 * Whether the source counts as playing. "State" reports (Spotify playing/paused,
 * a running source) hold until changed; "pulses" (audio above the silence
 * threshold) count at that moment. Either way the source stays active for the
 * idle timeout after the last activity.
 */
export class ActivityTracker extends EventEmitter<{ change: [active: boolean] }> {
  private playing = false;
  private lastActiveAt = Number.NEGATIVE_INFINITY;
  private last = false;
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly idleTimeoutMs: () => number,
    private readonly now: () => number = Date.now,
  ) {
    super();
    this.timer = setInterval(() => this.check(), ACTIVITY_CHECK_INTERVAL_MS);
    this.timer.unref();
  }

  report(active: boolean, kind: "state" | "pulse"): void {
    if (kind === "state") {
      if (this.playing && !active) {
        // The idle timeout counts from the moment playback stopped.
        this.lastActiveAt = this.now();
      }
      this.playing = active;
    } else if (active) {
      this.lastActiveAt = this.now();
    }

    this.check();
  }

  reset(): void {
    this.playing = false;
    this.lastActiveAt = Number.NEGATIVE_INFINITY;
    this.check();
  }

  get active(): boolean {
    return this.playing || this.now() - this.lastActiveAt < this.idleTimeoutMs();
  }

  check(): void {
    const active = this.active;
    if (active !== this.last) {
      this.last = active;
      this.emit("change", active);
    }
  }

  stop(): void {
    clearInterval(this.timer);
  }
}

function voiceTarget(settings: Settings): VoiceTarget {
  if (settings.followUserId) {
    return { kind: "follow", userId: settings.followUserId };
  }

  return settings.voiceChannelId ? { kind: "channel", channelId: settings.voiceChannelId } : { kind: "none" };
}

function sameTarget(left: VoiceTarget, right: VoiceTarget): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Settings that require restarting the audio pipeline when they change. */
function sourceKey(settings: Settings): string {
  const {
    audioSource,
    audioDevice,
    inputFormat,
    sampleRate,
    channels,
    inputs,
    loop,
    command,
    opusBitrate,
    audioFilter,
    ffmpegPath,
    parecPath,
    pwRecordPath,
    powershellPath,
    librespotPath,
    librespotName,
    librespotBitrate,
    librespotArgs,
  } = settings;
  return JSON.stringify([
    audioSource,
    audioDevice,
    inputFormat,
    sampleRate,
    channels,
    inputs,
    loop,
    command,
    opusBitrate,
    audioFilter,
    ffmpegPath,
    parecPath,
    pwRecordPath,
    powershellPath,
    librespotPath,
    librespotName,
    librespotBitrate,
    librespotArgs,
  ]);
}

export const CONTROL_HELP = `Commands:
  status                      Show what the instance is doing
  join [CHANNEL_ID]           Join now (optionally a different channel), ignoring the join rules
  leave                       Leave voice and stay out, ignoring the join rules
  auto                        Return to the configured join rules after join/leave
  channel CHANNEL_ID          Use a fixed channel as the voice target
  follow USER_ID              Follow a user as the voice target
  volume [FACTOR]             Show or set the volume (0-10), applied immediately
  source SOURCE [OPTIONS]     Switch the audio source, e.g. "source media -i song.mp3 --loop"
  reload                      Re-read the config file and apply changes
  stop                        Shut the instance down`;

export type EngineOptions = {
  mode: EngineMode;
  settings: Settings;
  /** The command line the engine was started with, re-applied on reload. */
  cliValues: CliValues;
  config: StdinmanConfig;
  configPath: string;
};

/**
 * Runs stdinman: logs into Discord, keeps the voice connection where the rules say
 * it should be, and streams the audio source. In "oneshot" mode the process ends
 * with the source; in "serve" mode it keeps running, restarts continuous sources,
 * and accepts `stdinman ctl` commands.
 */
export async function runEngine(options: EngineOptions): Promise<void> {
  const { mode } = options;
  let settings = options.settings;
  let config = options.config;
  let volume = settings.volume;
  let override: Override = "auto";
  let shuttingDown = false;
  let botName = "stdinman";
  let voice: VoiceManager | undefined;
  let control: { close: () => void } | undefined;
  let restartTimer: NodeJS.Timeout | undefined;
  let restartDelay = RESTART_INITIAL_DELAY_MS;
  let pipelineStartedAt = 0;
  let playbackStarted = false;
  const startedAt = Date.now();

  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  const player = createAudioPlayer({
    behaviors: {
      // Hold audio back while the bot is not in a channel: sources that can wait (Spotify,
      // files) resume where they were; live capture drops what nobody heard (see pacer.ts).
      noSubscriber: NoSubscriberBehavior.Pause,
      // Sources have gaps (e.g. Spotify paused); keep sending silence instead of ending playback.
      // The player still goes idle once the stream really ends.
      maxMissedFrames: Number.POSITIVE_INFINITY,
    },
  });
  const pipeline = new AudioPipeline(player, {
    gain: () => volume,
    silenceThreshold: () => 10 ** (settings.silenceThresholdDb / 20),
  });
  const activity = new ActivityTracker(() => settings.idleTimeoutMs);
  const presence = new PresenceUpdater(client, settings.botActivity);

  const shutdown = async (code: number): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    // Don't let a hung Discord teardown keep the process alive.
    setTimeout(() => process.exit(code), SHUTDOWN_TIMEOUT_MS).unref();
    clearTimeout(restartTimer);
    activity.stop();
    control?.close();
    voice?.destroy();
    pipeline.stop();

    try {
      await client.destroy();
    } catch (clientError) {
      debug(`failed to destroy Discord client cleanly: ${describeError(clientError)}`);
    }

    process.exit(code);
  };

  const fail = (message: string): void => {
    if (!shuttingDown) {
      error(message);
      void shutdown(1);
    }
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
  // Closing the terminal (or tmux session) sends SIGHUP.
  if (process.platform !== "win32") {
    process.on("SIGHUP", onSignal);
  }

  const updateWanted = (reason: string): void => {
    if (!voice || shuttingDown) {
      return;
    }

    const wanted =
      override === "join"
        ? true
        : override === "leave"
          ? false
          : pipeline.running && (settings.join === "always" || activity.active);
    voice.setWanted(wanted, reason);
  };

  const startPipeline = async (next: Settings): Promise<void> => {
    clearTimeout(restartTimer);
    restartTimer = undefined;
    activity.reset();
    await pipeline.start(next, botName);
    pipelineStartedAt = Date.now();
    updateWanted("source started");
  };

  const scheduleRestart = (reason: string): void => {
    if (shuttingDown || restartTimer) {
      return;
    }

    if (Date.now() - pipelineStartedAt > RESTART_STABLE_MS) {
      restartDelay = RESTART_INITIAL_DELAY_MS;
    }

    warn(`restarting the ${settings.audioSource} source in ${Math.round(restartDelay / 1000)} s (${reason})`);
    const delay = restartDelay;
    restartDelay = Math.min(restartDelay * 2, RESTART_MAX_DELAY_MS);
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      startPipeline(settings).catch((startError: unknown) => {
        error(`failed to start the ${settings.audioSource} source: ${describeError(startError)}`);
        scheduleRestart("start failed");
      });
    }, delay);
  };

  player.on("debug", (message) => debug(`[player] ${message}`));
  player.on("error", (playerError) => {
    // Errors of the playing resource; the pipeline reports its own failures separately.
    if (mode === "oneshot") {
      fail(`[player] ${playerError.message}`);
    } else {
      error(`[player] ${playerError.message}`);
      pipeline.stop();
      scheduleRestart("player error");
    }
  });
  player.on(AudioPlayerStatus.Playing, () => {
    if (!playbackStarted) {
      playbackStarted = true;
      info("piping successfully...");
    }
  });
  player.on(AudioPlayerStatus.Idle, (oldState) => {
    if (!shuttingDown && "resource" in oldState) {
      pipeline.handleIdle(oldState.resource);
    }
  });

  pipeline.on("ended", () => {
    if (mode === "oneshot") {
      info("audio input ended; disconnecting");
      void shutdown(0);
      return;
    }

    activity.reset();
    if (pipeline.continuous || settings.audioSource === "spotify") {
      scheduleRestart("source ended");
    } else {
      info('source finished; waiting for "stdinman ctl source ..." or a reload');
    }
    updateWanted("source finished");
  });
  pipeline.on("failed", (failure) => {
    if (mode === "oneshot") {
      fail(failure.message);
      return;
    }

    error(failure.message);
    activity.reset();
    updateWanted("source failed");
    scheduleRestart("source failed");
  });
  pipeline.on("activity", (active, kind) => activity.report(active, kind));
  pipeline.on("nowPlaying", (title) => {
    if (settings.nowPlaying) {
      presence.set(title);
    }
  });
  activity.on("change", (active) => {
    if (settings.join === "activity" && override === "auto") {
      info(active ? "the source started playing" : `the source has been idle for ${Math.round(settings.idleTimeoutMs / 1000)} s`);
    }
    updateWanted(active ? "source is playing" : "source is idle");
  });

  client.on(Events.Error, (clientError) => {
    error(clientError.stack ?? String(clientError));
  });
  if (isDebugEnabled()) {
    client.on(Events.Debug, (message) => debug(`[gateway] ${message}`));
  }

  const statusData = () => ({
    mode,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    source: pipeline.running ? settings.audioSource : null,
    nowPlaying: presence.current,
    volume,
    join: settings.join,
    idleTimeoutSeconds: settings.idleTimeoutMs / 1000,
    override,
    active: activity.active,
    voice: voice?.status(),
  });

  const formatStatus = (): string => {
    const status = statusData();
    const voiceStatus = status.voice;
    const target =
      voiceStatus?.target.kind === "follow"
        ? `follow ${voiceStatus.followedUser ?? voiceStatus.target.userId}`
        : voiceStatus?.target.kind === "channel"
          ? `channel ${voiceStatus.desired?.name ?? voiceStatus.target.channelId}`
          : "none";
    return [
      `source:      ${status.source ?? "(none)"}${status.nowPlaying ? ` - ${status.nowPlaying}` : ""}`,
      `activity:    ${status.active ? "playing" : "idle"}`,
      `voice:       ${voiceStatus?.connected ? `in "${voiceStatus.connected.name}" (${voiceStatus.connected.guild}), ${voiceStatus.connected.status}` : "not connected"}`,
      `target:      ${target}${voiceStatus?.desired && !voiceStatus.connected ? ` (currently "${voiceStatus.desired.name}")` : ""}`,
      `join rule:   ${override === "auto" ? `${status.join}${status.join === "activity" ? `, idle timeout ${status.idleTimeoutSeconds} s` : ""}` : `manual ${override} (use "ctl auto" to return to the rules)`}`,
      `volume:      ${status.volume}`,
      `uptime:      ${status.uptimeSeconds} s`,
    ].join("\n");
  };

  const resolveFromCli = (values: CliValues, from: StdinmanConfig): Settings => {
    const resolved = resolveSettings(values, from);
    for (const message of resolved.warnings) {
      warn(message);
    }

    validateRunSettings(resolved.settings, options.configPath, process.platform, { requireVoiceTarget: mode === "oneshot" });
    return resolved.settings;
  };

  const handleControl = async (args: string[]): Promise<ControlResponse> => {
    const [command = "status", ...rest] = args;
    switch (command) {
      case "status":
        return { ok: true, message: formatStatus(), data: statusData() };
      case "help":
        return { ok: true, message: CONTROL_HELP };
      case "join":
        if (rest[0]) {
          await voice?.setTarget({ kind: "channel", channelId: rest[0] });
        }
        override = "join";
        updateWanted("ctl join");
        return { ok: true, message: "joining (join rules are ignored until \"ctl auto\")" };
      case "leave":
        override = "leave";
        updateWanted("ctl leave");
        return { ok: true, message: "left voice (join rules are ignored until \"ctl auto\")" };
      case "auto":
        override = "auto";
        updateWanted("ctl auto");
        return { ok: true, message: `following the join rules (${settings.join})` };
      case "channel":
      case "follow": {
        const id = rest[0];
        if (!id || !/^\d{17,20}$/.test(id)) {
          throw new UsageError(`usage: ctl ${command} ${command === "channel" ? "CHANNEL_ID" : "USER_ID"}`);
        }

        await voice?.setTarget(command === "channel" ? { kind: "channel", channelId: id } : { kind: "follow", userId: id });
        override = "auto";
        updateWanted(`ctl ${command}`);
        return { ok: true, message: command === "channel" ? `voice target is now channel ${id}` : `now following user ${id}` };
      }
      case "volume":
        if (rest[0] === undefined) {
          return { ok: true, message: `volume ${volume}`, data: { volume } };
        }
        volume = parseVolume(rest[0]);
        return { ok: true, message: `volume ${volume}` };
      case "source": {
        if (!rest[0]) {
          throw new UsageError("usage: ctl source SOURCE [OPTIONS]");
        }

        const parsed = parseCli(["--source", rest[0], ...rest.slice(1)]);
        if (parsed.command.kind !== "run") {
          throw new UsageError("ctl source takes a source name and options, no command");
        }

        const next = resolveFromCli({ ...options.cliValues, spotify: undefined, ...parsed.values }, config);
        settings = { ...settings, ...pickSource(next) };
        await startPipeline(settings);
        return { ok: true, message: `switched to the ${settings.audioSource} source` };
      }
      case "reload": {
        const loaded = await loadConfig(options.configPath, { create: false });
        for (const message of loaded.warnings) {
          warn(`${options.configPath}: ${message}`);
        }
        const next = resolveFromCli(options.cliValues, loaded.config);
        if (next.botToken !== settings.botToken) {
          warn("the bot token changed; restart stdinman to use it");
        }

        const changes: string[] = [];
        const previous = settings;
        config = loaded.config;
        settings = { ...next, botToken: previous.botToken };
        volume = settings.volume;
        presence.setDefault(settings.botActivity);
        if (!sameTarget(voiceTarget(previous), voiceTarget(settings))) {
          await voice?.setTarget(voiceTarget(settings));
          changes.push("voice target");
        }
        if (sourceKey(previous) !== sourceKey(settings) || !pipeline.running) {
          await startPipeline(settings);
          changes.push("source");
        }
        updateWanted("reload");
        return { ok: true, message: `reloaded ${options.configPath}${changes.length > 0 ? ` (restarted: ${changes.join(", ")})` : ""}` };
      }
      case "stop":
        setTimeout(() => void shutdown(0), 50);
        return { ok: true, message: "shutting down" };
      default:
        throw new UsageError(`unknown command "${command}"\n${CONTROL_HELP}`);
    }
  };

  try {
    if (mode === "serve") {
      const socketPath = settings.socketPath || defaultSocketPath();
      // Claim the control socket first, so a second instance fails before touching Discord.
      control = await startControlServer(socketPath, async (args) => {
        try {
          return await handleControl(args);
        } catch (controlError) {
          return { ok: false, message: describeError(controlError) };
        }
      });
      info(`listening for "stdinman ctl" commands on ${socketPath}`);
    }

    info("logging into Discord");
    await client.login(settings.botToken);
    await waitForReady(client);
    if (!client.user) {
      throw new Error("discord client became ready without a user");
    }

    botName = client.user.displayName;
    info(`discord bot is ready as ${client.user.tag}`);
    client.user.setActivity(settings.botActivity);

    voice = new VoiceManager(client, player);
    try {
      await voice.setTarget(voiceTarget(settings));
    } catch (targetError) {
      if (mode === "oneshot") {
        throw targetError;
      }
      error(`${describeError(targetError)}; fix the config and run "stdinman ctl reload"`);
    }

    try {
      await startPipeline(settings);
    } catch (startError) {
      if (mode === "oneshot") {
        throw startError;
      }
      error(`failed to start the ${settings.audioSource} source: ${describeError(startError)}`);
      scheduleRestart("start failed");
    }
  } catch (runError) {
    fail(runError instanceof Error && isDebugEnabled() ? (runError.stack ?? runError.message) : describeError(runError));
  }
}

/** The source-related part of `next`, so switching sources keeps the rest of the current settings. */
function pickSource(next: Settings): Partial<Settings> {
  const {
    audioSource,
    audioDevice,
    inputFormat,
    sampleRate,
    channels,
    inputs,
    loop,
    command,
    opusBitrate,
    audioFilter,
    librespotName,
    librespotBitrate,
    librespotArgs,
    nowPlaying,
  } = next;
  return {
    audioSource,
    audioDevice,
    inputFormat,
    sampleRate,
    channels,
    inputs,
    loop,
    command,
    opusBitrate,
    audioFilter,
    librespotName,
    librespotBitrate,
    librespotArgs,
    nowPlaying,
  };
}
