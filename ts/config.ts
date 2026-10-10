import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

export const AUDIO_SOURCES = [
  "stdin",
  "command",
  "media",
  "spotify",
  "pulse-monitor",
  "pipewire",
  "windows-dshow",
  "windows-loopback",
  "macos-avfoundation",
] as const;
export const INPUT_FORMATS = ["f32le", "s16le", "s32le", "wav"] as const;
export const LIBRESPOT_BITRATES = [96, 160, 320] as const;

export type AudioSource = (typeof AUDIO_SOURCES)[number];
export type InputFormat = (typeof INPUT_FORMATS)[number];

export type StdinmanConfig = {
  bot_token: string;
  voice_channel_id: string;
  bot_activity: string;
  audio_source: AudioSource;
  audio_device: string;
  input_format: InputFormat;
  sample_rate: number;
  channels: number;
  inputs: string[];
  loop: boolean;
  command: string;
  follow_user_id: string;
  now_playing: boolean;
  volume: number;
  opus_bitrate: number;
  audio_filter: string;
  ffmpeg_path: string;
  parec_path: string;
  pactl_path: string;
  pw_record_path: string;
  powershell_path: string;
  librespot_path: string;
  librespot_name: string;
  librespot_bitrate: number;
  librespot_args: string[];
};

export const DEFAULT_CONFIG: Readonly<StdinmanConfig> = Object.freeze({
  bot_token: "",
  voice_channel_id: "",
  bot_activity: "stdinman",
  audio_source: "stdin",
  audio_device: "",
  input_format: "f32le",
  sample_rate: 48_000,
  channels: 2,
  inputs: [],
  loop: false,
  command: "",
  follow_user_id: "",
  now_playing: true,
  volume: 1,
  // 0 lets libopus pick its default bitrate.
  opus_bitrate: 0,
  // Extra ffmpeg audio filters applied before encoding, e.g. "bass=g=3" or "loudnorm".
  audio_filter: "",
  ffmpeg_path: "ffmpeg",
  parec_path: "parec",
  pactl_path: "pactl",
  pw_record_path: "pw-record",
  powershell_path: "powershell.exe",
  librespot_path: "librespot",
  // "{bot}" is replaced with the bot's display name.
  librespot_name: "discord: {bot}",
  librespot_bitrate: 320,
  librespot_args: [],
});

const CONFIG_KEYS = new Set(Object.keys(DEFAULT_CONFIG));

/** A mutable copy of the defaults. */
export function defaultConfig(): StdinmanConfig {
  return { ...DEFAULT_CONFIG, inputs: [], librespot_args: [] };
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function resolveConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.STDINMAN_CONFIG) {
    return env.STDINMAN_CONFIG;
  }

  const configHome = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(configHome, "stdinman", "stdinman.toml");
}

export function renderDefaultConfig(): string {
  return `# stdinman configuration. CLI flags and STDINMAN_* environment variables override these values.
# Keep this file private: it contains your bot token.

${stringifyToml(DEFAULT_CONFIG)}
`;
}

/** Creates the config file with owner-only permissions. Returns true if it was created. */
export async function ensureConfigFile(path: string): Promise<boolean> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, renderDefaultConfig(), { encoding: "utf8", mode: 0o600, flag: "wx" });
    return true;
  } catch (writeError) {
    if ((writeError as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }

    throw writeError;
  }
}

export type ParsedConfig = {
  config: StdinmanConfig;
  warnings: string[];
};

export function parseConfig(text: string): ParsedConfig {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(text, { integersAsBigInt: "asNeeded" }) as Record<string, unknown>;
  } catch (parseError) {
    throw new ConfigError(`invalid TOML: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
  }

  const warnings = Object.keys(parsed)
    .filter((key) => !CONFIG_KEYS.has(key))
    .map((key) => `unknown config key "${key}" will be ignored`);

  const config: StdinmanConfig = {
    bot_token: readString(parsed, "bot_token"),
    voice_channel_id: readSnowflake(parsed, "voice_channel_id"),
    bot_activity: readString(parsed, "bot_activity"),
    audio_source: readEnum(parsed, "audio_source", parseAudioSource),
    audio_device: readString(parsed, "audio_device"),
    input_format: readEnum(parsed, "input_format", parseInputFormat),
    sample_rate: readEnum(parsed, "sample_rate", parseSampleRate),
    channels: readEnum(parsed, "channels", parseChannels),
    inputs: readStringArray(parsed, "inputs"),
    loop: readBoolean(parsed, "loop"),
    command: readString(parsed, "command"),
    follow_user_id: readSnowflake(parsed, "follow_user_id"),
    now_playing: readBoolean(parsed, "now_playing"),
    volume: readEnum(parsed, "volume", parseVolume),
    opus_bitrate: readEnum(parsed, "opus_bitrate", parseOpusBitrate),
    audio_filter: readString(parsed, "audio_filter"),
    ffmpeg_path: readString(parsed, "ffmpeg_path"),
    parec_path: readString(parsed, "parec_path"),
    pactl_path: readString(parsed, "pactl_path"),
    pw_record_path: readString(parsed, "pw_record_path"),
    powershell_path: readString(parsed, "powershell_path"),
    librespot_path: readString(parsed, "librespot_path"),
    librespot_name: readString(parsed, "librespot_name"),
    librespot_bitrate: readEnum(parsed, "librespot_bitrate", parseLibrespotBitrate),
    librespot_args: readStringArray(parsed, "librespot_args"),
  };

  return { config, warnings };
}

/** Reads the config file, creating it first when `create` is set. A missing file yields the defaults. */
export async function loadConfig(
  path: string,
  options: { create: boolean },
): Promise<ParsedConfig & { created: boolean }> {
  const created = options.create ? await ensureConfigFile(path) : false;

  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (readError) {
    if ((readError as NodeJS.ErrnoException).code === "ENOENT") {
      return { config: defaultConfig(), warnings: [], created };
    }

    throw readError;
  }

  try {
    return { ...parseConfig(text), created };
  } catch (parseError) {
    if (parseError instanceof ConfigError) {
      throw new ConfigError(`${path}: ${parseError.message}`);
    }

    throw parseError;
  }
}

function readString(
  table: Record<string, unknown>,
  key: { [K in keyof StdinmanConfig]: StdinmanConfig[K] extends string ? K : never }[keyof StdinmanConfig],
): string {
  const value = table[key];
  if (value === undefined || value === "") {
    return DEFAULT_CONFIG[key];
  }

  if (typeof value !== "string") {
    throw new ConfigError(`"${key}" must be a string`);
  }

  return value;
}

function readSnowflake(table: Record<string, unknown>, key: "voice_channel_id" | "follow_user_id"): string {
  const value = table[key];
  // Discord IDs exceed Number.MAX_SAFE_INTEGER, so unquoted IDs arrive as bigint.
  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "number") {
    throw new ConfigError(`"${key}" must be a quoted string, e.g. ${key} = "123456789012345678"`);
  }

  return readString(table, key);
}

function readBoolean(table: Record<string, unknown>, key: "loop" | "now_playing"): boolean {
  const value = table[key];
  if (value === undefined) {
    return DEFAULT_CONFIG[key];
  }

  if (typeof value !== "boolean") {
    throw new ConfigError(`"${key}" must be true or false`);
  }

  return value;
}

function readStringArray(table: Record<string, unknown>, key: "librespot_args" | "inputs"): string[] {
  const value = table[key];
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new ConfigError(`"${key}" must be an array of strings`);
  }

  return [...value];
}

function readEnum<K extends keyof StdinmanConfig>(
  table: Record<string, unknown>,
  key: K,
  parseValue: (value: unknown) => StdinmanConfig[K],
): StdinmanConfig[K] {
  const value = table[key];
  if (value === undefined || value === "") {
    return DEFAULT_CONFIG[key];
  }

  try {
    return parseValue(value);
  } catch (valueError) {
    throw new ConfigError(`"${key}": ${valueError instanceof Error ? valueError.message : String(valueError)}`);
  }
}

export function parseAudioSource(value: unknown): AudioSource {
  if (typeof value === "string" && (AUDIO_SOURCES as readonly string[]).includes(value)) {
    return value as AudioSource;
  }

  throw new ConfigError(`invalid audio source ${JSON.stringify(value)}; expected one of: ${AUDIO_SOURCES.join(", ")}`);
}

export function parseInputFormat(value: unknown): InputFormat {
  if (typeof value === "string" && (INPUT_FORMATS as readonly string[]).includes(value)) {
    return value as InputFormat;
  }

  throw new ConfigError(`invalid input format ${JSON.stringify(value)}; expected one of: ${INPUT_FORMATS.join(", ")}`);
}

function toNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  if (typeof value === "string" && value.trim() !== "") {
    return Number(value.trim());
  }

  return Number.NaN;
}

export function parseLibrespotBitrate(value: unknown): number {
  const bitrate = toNumber(value);
  if (!(LIBRESPOT_BITRATES as readonly number[]).includes(bitrate)) {
    throw new ConfigError(
      `invalid librespot bitrate ${JSON.stringify(String(value))}; expected one of: ${LIBRESPOT_BITRATES.join(", ")}`,
    );
  }

  return bitrate;
}

export function parseVolume(value: unknown): number {
  const volume = toNumber(value);
  if (!Number.isFinite(volume) || volume < 0 || volume > 10) {
    throw new ConfigError(`invalid volume ${JSON.stringify(String(value))}; expected a number between 0 and 10`);
  }

  return volume;
}

/** Opus bitrate in kbit/s; 0 means "encoder default". */
export function parseOpusBitrate(value: unknown): number {
  const bitrate = toNumber(value);
  if (!Number.isInteger(bitrate) || (bitrate !== 0 && (bitrate < 6 || bitrate > 510))) {
    throw new ConfigError(
      `invalid opus bitrate ${JSON.stringify(String(value))}; expected kbit/s between 6 and 510 (or 0 for the encoder default)`,
    );
  }

  return bitrate;
}

export function parseSampleRate(value: unknown): number {
  const rate = toNumber(value);
  if (!Number.isInteger(rate) || rate < 8_000 || rate > 384_000) {
    throw new ConfigError(`invalid sample rate ${JSON.stringify(String(value))}; expected Hz between 8000 and 384000`);
  }

  return rate;
}

export function parseChannels(value: unknown): number {
  const channels = toNumber(value);
  if (!Number.isInteger(channels) || channels < 1 || channels > 8) {
    throw new ConfigError(`invalid channel count ${JSON.stringify(String(value))}; expected 1 to 8`);
  }

  return channels;
}
