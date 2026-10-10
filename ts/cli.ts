import { parseArgs } from "node:util";
import { validateLibrespotArgs } from "./spotify.ts";
import {
  type AudioSource,
  ConfigError,
  type JoinPolicy,
  type InputFormat,
  LIBRESPOT_BITRATES,
  type StdinmanConfig,
  parseAudioSource,
  parseChannels,
  parseDuration,
  parseInputFormat,
  parseJoinPolicy,
  parseSampleRate,
  parseSilenceThreshold,
  parseLibrespotBitrate,
  parseOpusBitrate,
  parseVolume,
} from "./config.ts";

export class UsageError extends Error {
  override name = "UsageError";
}

const OPTIONS = {
  config: { type: "string", short: "c" },
  "bot-token": { type: "string" },
  "voice-channel-id": { type: "string" },
  "bot-activity": { type: "string" },
  "audio-device": { type: "string", short: "d" },
  source: { type: "string", short: "s" },
  spotify: { type: "boolean" },
  "input-format": { type: "string" },
  "sample-rate": { type: "string" },
  channels: { type: "string" },
  input: { type: "string", short: "i", multiple: true },
  loop: { type: "boolean" },
  command: { type: "string" },
  "follow-user": { type: "string" },
  join: { type: "string" },
  "idle-timeout": { type: "string" },
  "silence-threshold": { type: "string" },
  socket: { type: "string" },
  "log-file": { type: "string" },
  "now-playing": { type: "boolean" },
  "no-now-playing": { type: "boolean" },
  volume: { type: "string" },
  "opus-bitrate": { type: "string" },
  "audio-filter": { type: "string" },
  "ffmpeg-path": { type: "string" },
  "parec-path": { type: "string" },
  "pactl-path": { type: "string" },
  "pw-record-path": { type: "string" },
  "powershell-path": { type: "string" },
  "librespot-path": { type: "string" },
  "librespot-name": { type: "string" },
  "librespot-bitrate": { type: "string" },
  "librespot-arg": { type: "string", multiple: true },
  verbose: { type: "boolean", short: "v" },
  version: { type: "boolean", short: "V" },
  help: { type: "boolean", short: "h" },
} as const;

export type CliValues = ReturnType<typeof parseCliValues>["values"];

export type Command =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "run" }
  | { kind: "devices-list" }
  | { kind: "config-path" }
  | { kind: "config-init" }
  | { kind: "doctor" }
  | { kind: "serve" }
  /** Arguments after `ctl`, forwarded unparsed to the running instance. */
  | { kind: "ctl"; args: string[] }
  | { kind: "service"; action: "install" | "uninstall" | "status" };

export type ParsedCli = {
  command: Command;
  values: CliValues;
};

function parseCliValues(argv: string[]) {
  return parseArgs({
    args: argv,
    options: OPTIONS,
    strict: true,
    allowPositionals: true,
  });
}

/** Index of the first positional argument (the command), honoring options that take values. */
function firstPositionalIndex(argv: string[]): number | undefined {
  const { tokens } = parseArgs({ args: argv, options: OPTIONS, strict: false, allowPositionals: true, tokens: true });
  return tokens.find((token) => token.kind === "positional")?.index;
}

export function parseCli(argv: string[]): ParsedCli {
  // `ctl` forwards everything after it to the running instance, including options.
  const commandIndex = firstPositionalIndex(argv);
  if (commandIndex !== undefined && argv[commandIndex] === "ctl") {
    const local = parseCli(argv.slice(0, commandIndex));
    return { command: { kind: "ctl", args: argv.slice(commandIndex + 1) }, values: local.values };
  }

  let parsed: ReturnType<typeof parseCliValues>;
  try {
    parsed = parseCliValues(argv);
  } catch (parseError) {
    throw new UsageError(parseError instanceof Error ? parseError.message : String(parseError));
  }

  const { values, positionals } = parsed;
  if (values.help || positionals[0] === "help") {
    return { command: { kind: "help" }, values };
  }

  if (values.version) {
    return { command: { kind: "version" }, values };
  }

  const commandText = positionals.join(" ");
  switch (commandText) {
    case "":
      return { command: { kind: "run" }, values };
    case "devices":
    case "devices list":
      return { command: { kind: "devices-list" }, values };
    case "config":
    case "config path":
      return { command: { kind: "config-path" }, values };
    case "config init":
      return { command: { kind: "config-init" }, values };
    case "doctor":
      return { command: { kind: "doctor" }, values };
    case "serve":
      return { command: { kind: "serve" }, values };
    case "service install":
    case "service uninstall":
    case "service status":
      return {
        command: { kind: "service", action: positionals[1] as "install" | "uninstall" | "status" },
        values,
      };
    case "service":
      throw new UsageError("usage: stdinman service install|uninstall|status");
    default:
      throw new UsageError(`unknown command: ${commandText} (see --help)`);
  }
}

export type Settings = {
  botToken: string;
  voiceChannelId: string;
  botActivity: string;
  audioSource: AudioSource;
  audioDevice: string;
  inputFormat: InputFormat;
  sampleRate: number;
  channels: number;
  inputs: string[];
  loop: boolean;
  command: string;
  followUserId: string;
  join: JoinPolicy;
  idleTimeoutMs: number;
  silenceThresholdDb: number;
  socketPath: string;
  logFile: string;
  nowPlaying: boolean;
  volume: number;
  opusBitrate: number;
  audioFilter: string;
  ffmpegPath: string;
  parecPath: string;
  pactlPath: string;
  pwRecordPath: string;
  powershellPath: string;
  librespotPath: string;
  librespotName: string;
  librespotBitrate: number;
  librespotArgs: string[];
};

export type ResolvedSettings = {
  settings: Settings;
  warnings: string[];
};

function parseFlag<T>(flag: string, value: string | undefined, parseValue: (value: unknown) => T): T | undefined {
  if (value === undefined) {
    return undefined;
  }

  try {
    return parseValue(value);
  } catch (valueError) {
    if (valueError instanceof ConfigError) {
      throw new UsageError(`--${flag}: ${valueError.message}`);
    }

    throw valueError;
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return value ? value : undefined;
}

/**
 * Merges CLI flags, STDINMAN_* environment variables and the config file
 * (in that order of precedence) into the effective runtime settings.
 */
export function resolveSettings(
  values: CliValues,
  config: StdinmanConfig,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedSettings {
  const warnings: string[] = [];

  if (values.spotify && values.source && values.source !== "spotify") {
    throw new UsageError(`--spotify conflicts with --source ${values.source}`);
  }

  const audioSource =
    parseFlag("source", values.spotify ? "spotify" : values.source, parseAudioSource) ?? config.audio_source;

  if (values["now-playing"] && values["no-now-playing"]) {
    throw new UsageError("--now-playing conflicts with --no-now-playing");
  }

  // The voice target is either a fixed channel or a user to follow. A value set on a
  // higher-precedence layer (CLI > env > config) replaces the other mode from lower layers.
  const layers = [
    { channel: values["voice-channel-id"], follow: values["follow-user"] },
    { channel: nonEmpty(env.STDINMAN_VOICE_CHANNEL_ID), follow: nonEmpty(env.STDINMAN_FOLLOW_USER_ID) },
    { channel: nonEmpty(config.voice_channel_id), follow: nonEmpty(config.follow_user_id) },
  ];
  const targetLayer = layers.find((layer) => layer.channel || layer.follow);
  if (targetLayer?.channel && targetLayer.follow) {
    warnings.push("both a voice channel and a user to follow are set; following the user");
  }

  const followUserId = targetLayer?.follow ?? "";
  const voiceChannelId = followUserId ? "" : (targetLayer?.channel ?? "");

  const settings: Settings = {
    botToken: values["bot-token"] ?? nonEmpty(env.STDINMAN_BOT_TOKEN) ?? config.bot_token,
    voiceChannelId,
    botActivity: values["bot-activity"] ?? config.bot_activity,
    audioSource,
    audioDevice: values["audio-device"] ?? config.audio_device,
    inputFormat: parseFlag("input-format", values["input-format"], parseInputFormat) ?? config.input_format,
    sampleRate: parseFlag("sample-rate", values["sample-rate"], parseSampleRate) ?? config.sample_rate,
    channels: parseFlag("channels", values.channels, parseChannels) ?? config.channels,
    inputs: values.input ?? config.inputs,
    loop: values.loop ?? config.loop,
    command: values.command ?? config.command,
    followUserId,
    join: parseFlag("join", values.join, parseJoinPolicy) ?? config.join,
    idleTimeoutMs: parseFlag("idle-timeout", values["idle-timeout"] ?? config.idle_timeout, parseDuration) ?? 0,
    silenceThresholdDb:
      parseFlag("silence-threshold", values["silence-threshold"], parseSilenceThreshold) ?? config.silence_threshold,
    socketPath: values.socket ?? config.socket_path,
    logFile: values["log-file"] ?? config.log_file,
    nowPlaying: values["no-now-playing"] ? false : (values["now-playing"] ?? config.now_playing),
    volume: parseFlag("volume", values.volume, parseVolume) ?? config.volume,
    opusBitrate: parseFlag("opus-bitrate", values["opus-bitrate"], parseOpusBitrate) ?? config.opus_bitrate,
    audioFilter: values["audio-filter"] ?? config.audio_filter,
    ffmpegPath: values["ffmpeg-path"] ?? config.ffmpeg_path,
    parecPath: values["parec-path"] ?? config.parec_path,
    pactlPath: values["pactl-path"] ?? config.pactl_path,
    pwRecordPath: values["pw-record-path"] ?? config.pw_record_path,
    powershellPath: values["powershell-path"] ?? config.powershell_path,
    librespotPath: values["librespot-path"] ?? config.librespot_path,
    librespotName: values["librespot-name"] ?? config.librespot_name,
    librespotBitrate:
      parseFlag("librespot-bitrate", values["librespot-bitrate"], parseLibrespotBitrate) ?? config.librespot_bitrate,
    librespotArgs: values["librespot-arg"] ?? config.librespot_args,
  };

  if (settings.voiceChannelId && !SNOWFLAKE.test(settings.voiceChannelId)) {
    throw new UsageError(
      `voice channel ID "${settings.voiceChannelId}" does not look like a Discord ID (enable Developer Mode in Discord and use "Copy Channel ID")`,
    );
  }

  if (settings.followUserId && !SNOWFLAKE.test(settings.followUserId)) {
    throw new UsageError(
      `user ID "${settings.followUserId}" does not look like a Discord ID (enable Developer Mode in Discord and use "Copy User ID")`,
    );
  }

  const readsPcm = audioSource === "stdin" || audioSource === "command";
  for (const flag of ["input-format", "sample-rate", "channels"] as const) {
    if (!readsPcm && values[flag]) {
      warnings.push(`ignoring --${flag} because the ${audioSource} source does not read raw PCM`);
    }
  }

  if (audioSource !== "media" && values.input) {
    warnings.push("ignoring --input because the selected source is not media");
  }

  if (audioSource !== "media" && values.loop) {
    warnings.push("ignoring --loop because the selected source is not media");
  }

  if (audioSource !== "command" && values.command) {
    warnings.push("ignoring --command because the selected source is not command");
  }

  if (
    audioSource !== "spotify" &&
    (values["librespot-path"] || values["librespot-name"] || values["librespot-bitrate"] || values["librespot-arg"])
  ) {
    warnings.push("ignoring librespot options because the selected source is not spotify");
  }

  if (!sourceUsesDevice(audioSource) && values["audio-device"]) {
    warnings.push("ignoring --audio-device because the selected source does not use a capture device name");
  }

  return { settings, warnings };
}

const SNOWFLAKE = /^\d{17,20}$/;

const SOURCE_PLATFORMS: Partial<Record<AudioSource, { platform: NodeJS.Platform; name: string }>> = {
  "pulse-monitor": { platform: "linux", name: "Linux" },
  pipewire: { platform: "linux", name: "Linux" },
  "windows-dshow": { platform: "win32", name: "Windows" },
  "windows-loopback": { platform: "win32", name: "Windows" },
  "macos-avfoundation": { platform: "darwin", name: "macOS" },
};

export function sourceUsesDevice(source: AudioSource): boolean {
  return (
    source === "pulse-monitor" ||
    source === "pipewire" ||
    source === "windows-dshow" ||
    source === "windows-loopback" ||
    source === "macos-avfoundation"
  );
}

/** Sources where --audio-device is mandatory (the others fall back to the default device). */
export function sourceRequiresDevice(source: AudioSource): boolean {
  return source === "pulse-monitor" || source === "windows-dshow" || source === "macos-avfoundation";
}

/** Throws a UsageError if the settings cannot be used to start streaming. */
export function validateRunSettings(
  settings: Settings,
  configPath: string,
  platform = process.platform,
  options: { requireVoiceTarget?: boolean } = {},
): void {
  if (!settings.botToken) {
    throw new UsageError(
      `missing bot token. Pass --bot-token, set STDINMAN_BOT_TOKEN, or add bot_token to ${configPath}`,
    );
  }

  if ((options.requireVoiceTarget ?? true) && !settings.voiceChannelId && !settings.followUserId) {
    throw new UsageError(
      `missing voice channel. Pass --voice-channel-id or --follow-user, or add voice_channel_id or follow_user_id to ${configPath}`,
    );
  }

  const requiredPlatform = SOURCE_PLATFORMS[settings.audioSource];
  if (requiredPlatform && platform !== requiredPlatform.platform) {
    throw new UsageError(`the ${settings.audioSource} source is only supported on ${requiredPlatform.name}`);
  }

  if (settings.audioSource === "media" && settings.inputs.length === 0) {
    throw new UsageError(`source "media" requires at least one --input (file, directory or URL) or inputs in ${configPath}`);
  }

  if (settings.audioSource === "command" && !settings.command) {
    throw new UsageError(`source "command" requires --command or command in ${configPath}`);
  }

  if (settings.audioSource === "spotify") {
    try {
      validateLibrespotArgs(settings.librespotArgs);
    } catch (argsError) {
      throw new UsageError(argsError instanceof Error ? argsError.message : String(argsError));
    }
  }

  if (sourceRequiresDevice(settings.audioSource) && !settings.audioDevice) {
    throw new UsageError(
      `source "${settings.audioSource}" requires --audio-device or audio_device in ${configPath} (run "stdinman devices list" to see available devices)`,
    );
  }
}

/** The source whose devices `devices list` should show when --source is not given. */
export function defaultDeviceListSource(configured: AudioSource, platform = process.platform): AudioSource {
  if (sourceUsesDevice(configured)) {
    return configured;
  }

  if (platform === "linux") {
    return "pulse-monitor";
  }

  if (platform === "win32") {
    return "windows-dshow";
  }

  if (platform === "darwin") {
    return "macos-avfoundation";
  }

  return configured;
}

export function helpText(version: string): string {
  return `stdinman ${version}
Stream audio from this computer into a Discord voice channel through a bot.

Usage:
  stdinman [OPTIONS]                 Join the voice channel and stream until the source ends
  stdinman serve [OPTIONS]           Run in the background: apply join rules, accept ctl commands
  stdinman ctl COMMAND [ARGS]        Control a running "serve" instance ("stdinman ctl help")
  stdinman service install|uninstall|status
                                     Run "serve" as a user service (systemd, launchd, Task Scheduler)
  stdinman devices list [--source S] List capture devices for a source
  stdinman doctor [OPTIONS]          Check config and external tools
  stdinman config path               Print the config file location
  stdinman config init               Create the config file if it does not exist

Connection:
  --bot-token <TOKEN>          Discord bot token (env: STDINMAN_BOT_TOKEN)
  --voice-channel-id <ID>      Voice or stage channel to join (env: STDINMAN_VOICE_CHANNEL_ID)
  --follow-user <USER_ID>      Instead, follow this user between voice channels: join when they
                               join, move with them, leave when they leave (env: STDINMAN_FOLLOW_USER_ID)
  --join <always|activity>     Join whenever there is a target, or only while the source plays
  --idle-timeout <DURATION>    Leave after the source was idle this long (default: 5m)
  --silence-threshold <DBFS>   Capture sources count as playing above this level (default: -60)
  --bot-activity <TEXT>        Activity shown on the bot's profile
  --[no-]now-playing           Show the current track as the bot's activity (default: on)

Sources (-s, --source <SOURCE>, default: stdin):
  stdin                        Raw PCM or WAV piped into stdin
  command                      Raw PCM or WAV from --command <CMDLINE> (run through the shell)
  media                        Files, directories or URLs from -i/--input (repeatable); --loop to repeat
  spotify                      Spotify Connect via librespot (--spotify is a shorthand)
  pulse-monitor                PulseAudio/PipeWire source via parec (Linux, needs --audio-device)
  pipewire                     PipeWire device or application via pw-record (Linux, default: output)
  windows-dshow                DirectShow capture device via ffmpeg (Windows, needs --audio-device)
  windows-loopback             What a Windows output device plays (Windows, default: output)
  macos-avfoundation           AVFoundation audio device via ffmpeg (macOS, needs --audio-device)

Audio:
  -d, --audio-device <NAME>    Device (or, for pipewire, application) to capture
  --input-format <FORMAT>      stdin/command format: f32le | s16le | s32le | wav (default: f32le)
  --sample-rate <HZ>           stdin/command sample rate (default: 48000)
  --channels <N>               stdin/command channel count (default: 2)
  --volume <FACTOR>            Volume multiplier, 0-10 (default: 1)
  --opus-bitrate <KBPS>        Opus bitrate in kbit/s, 6-510 (default: encoder default, ~96 for stereo)
  --audio-filter <FILTERS>     Extra ffmpeg audio filters before encoding, e.g. "bass=g=3"

Spotify (librespot):
  --librespot-path <PATH>      librespot binary (default: librespot)
  --librespot-name <NAME>      Spotify Connect device name; {bot} is the bot's name (default: "discord: {bot}")
  --librespot-bitrate <KBPS>   ${LIBRESPOT_BITRATES.join(" | ")} (default: 320)
  --librespot-arg <ARG>        Extra librespot argument (repeatable)

Tools:
  --ffmpeg-path <PATH>         ffmpeg binary (default: ffmpeg)
  --parec-path <PATH>          parec binary (default: parec)
  --pactl-path <PATH>          pactl binary (default: pactl)
  --pw-record-path <PATH>      pw-record binary (default: pw-record)
  --powershell-path <PATH>     PowerShell for windows-loopback (default: powershell.exe)

General:
  -c, --config <PATH>          Config file (env: STDINMAN_CONFIG)
  --socket <PATH>              Control socket for serve/ctl (default: per-user location)
  --log-file <PATH>            Also append logs to this file
  -v, --verbose                Enable debug logging (or STDINMAN_LOG=debug)
  -V, --version                Print version
  -h, --help                   Print this help`;
}
