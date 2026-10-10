import { parseArgs } from "node:util";
import {
  AUDIO_SOURCES,
  type AudioSource,
  ConfigError,
  type InputFormat,
  LIBRESPOT_BITRATES,
  type StdinmanConfig,
  parseAudioSource,
  parseInputFormat,
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
  volume: { type: "string" },
  "opus-bitrate": { type: "string" },
  "ffmpeg-path": { type: "string" },
  "parec-path": { type: "string" },
  "pactl-path": { type: "string" },
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
  | { kind: "doctor" };

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

export function parseCli(argv: string[]): ParsedCli {
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
  volume: number;
  opusBitrate: number;
  ffmpegPath: string;
  parecPath: string;
  pactlPath: string;
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

  const settings: Settings = {
    botToken: values["bot-token"] ?? nonEmpty(env.STDINMAN_BOT_TOKEN) ?? config.bot_token,
    voiceChannelId:
      values["voice-channel-id"] ?? nonEmpty(env.STDINMAN_VOICE_CHANNEL_ID) ?? config.voice_channel_id,
    botActivity: values["bot-activity"] ?? config.bot_activity,
    audioSource,
    audioDevice: values["audio-device"] ?? config.audio_device,
    inputFormat: parseFlag("input-format", values["input-format"], parseInputFormat) ?? config.input_format,
    volume: parseFlag("volume", values.volume, parseVolume) ?? config.volume,
    opusBitrate: parseFlag("opus-bitrate", values["opus-bitrate"], parseOpusBitrate) ?? config.opus_bitrate,
    ffmpegPath: values["ffmpeg-path"] ?? config.ffmpeg_path,
    parecPath: values["parec-path"] ?? config.parec_path,
    pactlPath: values["pactl-path"] ?? config.pactl_path,
    librespotPath: values["librespot-path"] ?? config.librespot_path,
    librespotName: values["librespot-name"] ?? config.librespot_name,
    librespotBitrate:
      parseFlag("librespot-bitrate", values["librespot-bitrate"], parseLibrespotBitrate) ?? config.librespot_bitrate,
    librespotArgs: values["librespot-arg"] ?? config.librespot_args,
  };

  if (settings.voiceChannelId && !/^\d{17,20}$/.test(settings.voiceChannelId)) {
    throw new UsageError(
      `voice channel ID "${settings.voiceChannelId}" does not look like a Discord ID (enable Developer Mode in Discord and use "Copy Channel ID")`,
    );
  }

  if (audioSource !== "stdin" && values["input-format"]) {
    warnings.push(`ignoring --input-format because the ${audioSource} source does not read raw stdin PCM`);
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

export function sourceUsesDevice(source: AudioSource): boolean {
  return source === "pulse-monitor" || source === "windows-dshow";
}

/** Throws a UsageError if the settings cannot be used to start streaming. */
export function validateRunSettings(settings: Settings, configPath: string, platform = process.platform): void {
  if (!settings.botToken) {
    throw new UsageError(
      `missing bot token. Pass --bot-token, set STDINMAN_BOT_TOKEN, or add bot_token to ${configPath}`,
    );
  }

  if (!settings.voiceChannelId) {
    throw new UsageError(
      `missing voice channel ID. Pass --voice-channel-id, set STDINMAN_VOICE_CHANNEL_ID, or add voice_channel_id to ${configPath}`,
    );
  }

  if (settings.audioSource === "pulse-monitor" && platform !== "linux") {
    throw new UsageError("the pulse-monitor source is only supported on Linux");
  }

  if (settings.audioSource === "windows-dshow" && platform !== "win32") {
    throw new UsageError("the windows-dshow source is only supported on Windows");
  }

  if (sourceUsesDevice(settings.audioSource) && !settings.audioDevice) {
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

  return configured;
}

export function helpText(version: string): string {
  return `stdinman ${version}
Stream audio into a Discord voice channel through a bot.

Usage:
  stdinman [OPTIONS]                 Join the voice channel and start streaming
  stdinman devices list [--source S] List capture devices for a source
  stdinman doctor [OPTIONS]          Check config and external tools
  stdinman config path               Print the config file location
  stdinman config init               Create the config file if it does not exist

Connection:
  --bot-token <TOKEN>          Discord bot token (env: STDINMAN_BOT_TOKEN)
  --voice-channel-id <ID>      Target voice or stage channel (env: STDINMAN_VOICE_CHANNEL_ID)
  --bot-activity <TEXT>        Activity shown on the bot's profile

Audio:
  -s, --source <SOURCE>        ${AUDIO_SOURCES.join(" | ")} (default: stdin)
  --spotify                    Shorthand for --source spotify
  -d, --audio-device <NAME>    Capture device for pulse-monitor / windows-dshow
  --input-format <FORMAT>      Raw stdin PCM format: f32le | s16le (48 kHz stereo)
  --volume <FACTOR>            Volume multiplier, 0-10 (default: 1)
  --opus-bitrate <KBPS>        Opus bitrate in kbit/s, 6-510 (default: encoder default)

Spotify (librespot):
  --librespot-path <PATH>      librespot binary (default: librespot)
  --librespot-name <NAME>      Spotify Connect device name (default: stdinman_connect)
  --librespot-bitrate <KBPS>   ${LIBRESPOT_BITRATES.join(" | ")} (default: 320)
  --librespot-arg <ARG>        Extra librespot argument (repeatable)

Tools:
  --ffmpeg-path <PATH>         ffmpeg binary (default: ffmpeg)
  --parec-path <PATH>          parec binary (default: parec)
  --pactl-path <PATH>          pactl binary (default: pactl)

General:
  -c, --config <PATH>          Config file (env: STDINMAN_CONFIG)
  -v, --verbose                Enable debug logging (or STDINMAN_LOG=debug)
  -V, --version                Print version
  -h, --help                   Print this help`;
}
