import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnection,
  VoiceConnectionDisconnectReason,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  generateDependencyReport,
  joinVoiceChannel,
} from "@discordjs/voice";
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  GuildBasedChannel,
} from "discord.js";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { parseArgs } from "node:util";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

type AudioSource = "stdin" | "spotify" | "pulse-monitor" | "windows-dshow";
type InputFormat = "f32le" | "s16le";
type FfmpegInputSpec = {
  format: InputFormat;
  sampleRate: number;
  channels: number;
  waitingMessage: string;
};
type PreparedAudioSource = {
  stream: Readable;
  ffmpegInput: FfmpegInputSpec;
  start: () => void;
  stop: () => void;
  startupMessage: string;
  awaitInitialPlayback: boolean;
};

type StdinmanConfig = {
  bot_token: string;
  voice_channel_id: string;
  bot_activity: string;
  audio_source: AudioSource;
  audio_device: string;
  input_format: InputFormat;
  ffmpeg_path: string;
  parec_path: string;
  pactl_path: string;
  librespot_path: string;
  librespot_name: string;
  librespot_bitrate: number;
  librespot_args: string[];
};

const DEFAULT_CONFIG: StdinmanConfig = {
  bot_token: "",
  voice_channel_id: "",
  bot_activity: "stdinman",
  audio_source: "stdin",
  audio_device: "",
  input_format: "f32le",
  ffmpeg_path: "ffmpeg",
  parec_path: "parec",
  pactl_path: "pactl",
  librespot_path: "librespot",
  librespot_name: "stdinman_connect",
  librespot_bitrate: 320,
  librespot_args: [],
};

const LOGGER_NAME = "stdinman.ts";
const VOICE_READY_TIMEOUT_MS = 30_000;
const VOICE_RECONNECT_GRACE_MS = 5_000;
const VOICE_RECONNECT_INITIAL_DELAY_MS = 1_000;
const VOICE_RECONNECT_MAX_DELAY_MS = 30_000;

function isDebugEnabled(): boolean {
  const value = `${process.env.STDINMAN_LOG ?? process.env.RUST_LOG ?? ""}`.toLowerCase();
  return value.includes("debug") || value.includes("trace");
}

function log(level: "DEBUG" | "INFO" | "WARN" | "ERROR", message: string): void {
  const line = `[${new Date().toISOString()}] ${level} ${LOGGER_NAME} ${message}`;
  if (level === "ERROR" || level === "WARN") {
    console.error(line);
  } else {
    console.log(line);
  }
}

function debug(message: string): void {
  if (isDebugEnabled()) {
    log("DEBUG", message);
  }
}

function info(message: string): void {
  log("INFO", message);
}

function warn(message: string): void {
  log("WARN", message);
}

function error(message: string): void {
  log("ERROR", message);
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function resolveConfigPath(): string {
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(configHome, "stdinman", "stdinman.toml");
}

async function ensureConfigFile(path: string): Promise<void> {
  try {
    await readFile(path, "utf8");
  } catch (readError) {
    const err = readError as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") {
      throw readError;
    }

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, stringifyToml(DEFAULT_CONFIG), "utf8");
    info(`created config file at ${path}`);
  }
}

function parseConfig(text: string): StdinmanConfig {
  const parsed = parseToml(text) as Partial<StdinmanConfig>;

  return {
    ...DEFAULT_CONFIG,
    ...parsed,
    audio_source: normalizeAudioSource(parsed.audio_source),
    audio_device: normalizeStringValue(parsed.audio_device, DEFAULT_CONFIG.audio_device),
    input_format: normalizeInputFormat(parsed.input_format),
    ffmpeg_path: normalizeStringValue(parsed.ffmpeg_path, DEFAULT_CONFIG.ffmpeg_path),
    parec_path: normalizeStringValue(parsed.parec_path, DEFAULT_CONFIG.parec_path),
    pactl_path: normalizeStringValue(parsed.pactl_path, DEFAULT_CONFIG.pactl_path),
    librespot_path: normalizeStringValue(parsed.librespot_path, DEFAULT_CONFIG.librespot_path),
    librespot_name: normalizeStringValue(parsed.librespot_name, DEFAULT_CONFIG.librespot_name),
    librespot_bitrate: normalizeLibrespotBitrate(parsed.librespot_bitrate),
    librespot_args: normalizeStringArray(parsed.librespot_args),
  };
}

async function loadConfig(path: string): Promise<StdinmanConfig> {
  await ensureConfigFile(path);
  const text = await readFile(path, "utf8");
  return parseConfig(text);
}

async function loadOptionalConfig(path: string): Promise<StdinmanConfig> {
  try {
    const text = await readFile(path, "utf8");
    return parseConfig(text);
  } catch (readError) {
    const err = readError as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return { ...DEFAULT_CONFIG };
    }

    throw readError;
  }
}

function normalizeAudioSource(value: unknown): AudioSource {
  switch (value) {
    case "spotify":
      return "spotify";
    case "pulse-monitor":
      return "pulse-monitor";
    case "windows-dshow":
      return "windows-dshow";
    default:
      return "stdin";
  }
}

function normalizeInputFormat(value: unknown): InputFormat {
  return value === "s16le" ? "s16le" : "f32le";
}

function normalizeLibrespotBitrate(value: unknown): number {
  const candidate =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;

  return Number.isInteger(candidate) && candidate > 0
    ? candidate
    : DEFAULT_CONFIG.librespot_bitrate;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string");
}

function normalizeStringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value ? value : fallback;
}

type VoiceTargetChannel = GuildBasedChannel & {
  type: ChannelType.GuildVoice | ChannelType.GuildStageVoice;
};

function isVoiceTargetChannel(channel: unknown): channel is VoiceTargetChannel {
  if (!channel || typeof channel !== "object" || !("type" in channel)) {
    return false;
  }

  return (
    channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice
  );
}

function createSwitchingStdinStream(): PreparedAudioSource {
  const output = new PassThrough();
  let forwarding = false;

  const onData = (chunk: Buffer): void => {
    if (!forwarding) {
      return;
    }

    if (!output.write(chunk)) {
      process.stdin.pause();
      output.once("drain", () => process.stdin.resume());
    }
  };

  const onEnd = (): void => {
    output.end();
  };

  const onError = (streamError: Error): void => {
    output.destroy(streamError);
  };

  const detach = (): void => {
    process.stdin.off("data", onData);
    process.stdin.off("end", onEnd);
    process.stdin.off("error", onError);
  };

  process.stdin.on("data", onData);
  process.stdin.on("end", onEnd);
  process.stdin.on("error", onError);
  output.once("close", detach);
  process.stdin.resume();

  return {
    stream: output,
    ffmpegInput: {
      format: "f32le",
      sampleRate: 48_000,
      channels: 2,
      waitingMessage:
        "ffmpeg has not produced any opus packets yet. If audio is already flowing into stdin, this points to an upstream stdin/transcode/runtime issue.",
    },
    start: (): void => {
      forwarding = true;
    },
    stop: (): void => {
      output.end();
    },
    startupMessage: "going to pipe stdin to the bot",
    awaitInitialPlayback: true,
  };
}

function createProcessAudioSource(options: {
  command: string;
  args: string[];
  ffmpegInput: FfmpegInputSpec;
  startupMessage: string;
  startedMessage: string;
  logPrefix: string;
  awaitInitialPlayback: boolean;
}): PreparedAudioSource {
  const output = new PassThrough();
  let child: ReturnType<typeof spawn> | undefined;
  let stopping = false;

  return {
    stream: output,
    ffmpegInput: options.ffmpegInput,
    start: (): void => {
      if (child) {
        return;
      }

      debug(`starting ${options.logPrefix} source: ${options.command} ${options.args.join(" ")}`);
      child = spawn(options.command, options.args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      const stdout = child.stdout;
      const stderr = child.stderr;
      if (!stdout || !stderr) {
        throw new Error(`${options.logPrefix} did not start with piped stdout/stderr`);
      }

      stdout.pipe(output);
      stderr.setEncoding("utf8");
      stderr.on("data", (chunk: string) => {
        for (const line of chunk.split(/\r?\n/)) {
          const text = line.trim();
          if (!text) {
            continue;
          }

          debug(`[${options.logPrefix}] ${text}`);
        }
      });
      child.on("spawn", () => {
        info(options.startedMessage);
      });
      child.on("error", (childError) => {
        output.destroy(
          new Error(`failed to start ${options.logPrefix} source (${options.command}): ${String(childError)}`),
        );
      });
      child.on("close", (code, signal) => {
        if (stopping) {
          output.end();
          return;
        }

        output.destroy(
          new Error(
            `${options.logPrefix} exited with code=${code ?? "null"} signal=${signal ?? "null"}`,
          ),
        );
      });
    },
    stop: (): void => {
      stopping = true;
      output.end();
      if (!child) {
        return;
      }

      child.stdout?.unpipe(output);
      child.kill("SIGTERM");
    },
    startupMessage: options.startupMessage,
    awaitInitialPlayback: options.awaitInitialPlayback,
  };
}

function createSpotifySource(options: {
  librespotPath: string;
  librespotName: string;
  librespotBitrate: number;
  librespotArgs: string[];
}): PreparedAudioSource {
  return createProcessAudioSource({
    command: options.librespotPath,
    args: [
      "-n",
      options.librespotName,
      "--backend",
      "pipe",
      "-b",
      String(options.librespotBitrate),
      ...options.librespotArgs,
    ],
    ffmpegInput: {
      format: "s16le",
      sampleRate: 44_100,
      channels: 2,
      waitingMessage: `ffmpeg is still waiting for Spotify audio. Start playback on the Spotify Connect device "${options.librespotName}" if you have not already.`,
    },
    startupMessage: `starting librespot and waiting for Spotify playback on device "${options.librespotName}"`,
    startedMessage: `librespot started; waiting for Spotify playback on device "${options.librespotName}"`,
    logPrefix: "librespot",
    awaitInitialPlayback: false,
  });
}

function createPulseMonitorSource(options: {
  parecPath: string;
  audioDevice: string;
}): PreparedAudioSource {
  return createProcessAudioSource({
    command: options.parecPath,
    args: [
      "-d",
      options.audioDevice,
      "--format=float32le",
      "--rate=48000",
      "--channels=2",
    ],
    ffmpegInput: {
      format: "f32le",
      sampleRate: 48_000,
      channels: 2,
      waitingMessage: `ffmpeg is still waiting for PulseAudio/PipeWire input from source "${options.audioDevice}". Make sure audio is routed to that source.`,
    },
    startupMessage: `starting PulseAudio/PipeWire capture from source "${options.audioDevice}"`,
    startedMessage: `PulseAudio/PipeWire capture started from source "${options.audioDevice}"`,
    logPrefix: "parec",
    awaitInitialPlayback: false,
  });
}

function formatDirectShowAudioInput(audioDevice: string): string {
  return audioDevice.startsWith("audio=") || audioDevice.startsWith("video=")
    ? audioDevice
    : `audio=${audioDevice}`;
}

function createWindowsDshowSource(options: {
  ffmpegPath: string;
  audioDevice: string;
}): PreparedAudioSource {
  const dshowInput = formatDirectShowAudioInput(options.audioDevice);

  return createProcessAudioSource({
    command: options.ffmpegPath,
    args: [
      "-hide_banner",
      "-loglevel",
      isDebugEnabled() ? "warning" : "error",
      "-f",
      "dshow",
      "-sample_rate",
      "48000",
      "-channels",
      "2",
      "-i",
      dshowInput,
      "-vn",
      "-sn",
      "-dn",
      "-acodec",
      "pcm_f32le",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-f",
      "f32le",
      "pipe:1",
    ],
    ffmpegInput: {
      format: "f32le",
      sampleRate: 48_000,
      channels: 2,
      waitingMessage: `ffmpeg is still waiting for DirectShow input from "${options.audioDevice}". Make sure the capture device is active and producing audio.`,
    },
    startupMessage: `starting DirectShow capture from audio device "${options.audioDevice}"`,
    startedMessage: `DirectShow capture started from audio device "${options.audioDevice}"`,
    logPrefix: "ffmpeg-dshow",
    awaitInitialPlayback: false,
  });
}

function createFfmpegOpusStream(
  ffmpegPath: string,
  input: Readable,
  ffmpegInput: FfmpegInputSpec,
): {
  stream: Readable;
  stop: () => void;
} {
  const ffmpegArgs = [
    "-analyzeduration",
    "0",
    "-loglevel",
    isDebugEnabled() ? "warning" : "error",
    "-f",
    ffmpegInput.format,
    "-ar",
    String(ffmpegInput.sampleRate),
    "-ac",
    String(ffmpegInput.channels),
    "-i",
    "pipe:0",
    "-map",
    "0:a:0",
    "-c:a",
    "libopus",
    "-application",
    "audio",
    "-frame_duration",
    "20",
    "-f",
    "ogg",
    "pipe:1",
  ];

  debug(`starting ffmpeg transcoder: ${ffmpegPath} ${ffmpegArgs.join(" ")}`);

  const child = spawn(ffmpegPath, ffmpegArgs, {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let sawOutput = false;

  input.pipe(child.stdin);

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    const text = chunk.trim();
    if (text) {
      debug(`[ffmpeg] ${text}`);
    }
  });
  child.stdout.once("data", () => {
    sawOutput = true;
    info("ffmpeg produced opus output");
  });

  child.on("error", (childError) => {
    error(`failed to start ffmpeg transcoder (${ffmpegPath}): ${childError.stack ?? childError}`);
  });

  child.on("close", (code, signal) => {
    if (code === 0 || signal === "SIGTERM") {
      return;
    }

    error(`ffmpeg exited unexpectedly with code=${code ?? "null"} signal=${signal ?? "null"}`);
  });

  setTimeout(() => {
    if (!sawOutput) {
      warn(ffmpegInput.waitingMessage);
    }
  }, 10_000).unref();

  return {
    stream: child.stdout,
    stop: (): void => {
      input.unpipe(child.stdin);
      child.stdin.destroy();
      child.kill("SIGTERM");
    },
  };
}

type CapturedCommandResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
};

async function runCommandCapture(command: string, args: string[]): Promise<CapturedCommandResult> {
  return await new Promise<CapturedCommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = child.stdout;
    const stderr = child.stderr;

    if (!stdout || !stderr) {
      reject(new Error(`${command} did not start with piped stdout/stderr`));
      return;
    }

    let stdoutText = "";
    let stderrText = "";

    stdout.setEncoding("utf8");
    stderr.setEncoding("utf8");
    stdout.on("data", (chunk: string) => {
      stdoutText += chunk;
    });
    stderr.on("data", (chunk: string) => {
      stderrText += chunk;
    });

    child.on("error", (childError) => {
      reject(new Error(`failed to start ${command}: ${String(childError)}`));
    });
    child.on("close", (code, signal) => {
      resolve({
        stdout: stdoutText,
        stderr: stderrText,
        code,
        signal,
      });
    });
  });
}

function isMonitorSourceName(sourceName: string): boolean {
  return sourceName.endsWith(".monitor") || sourceName.toLowerCase().includes("monitor");
}

function printAvailableSources(): void {
  console.log("Available source modes:");
  console.log("  stdin           Read raw PCM from stdin");
  console.log("  spotify         Spawn librespot and stream Spotify Connect audio");
  console.log("  pulse-monitor   Capture a PulseAudio/PipeWire source via parec (Linux)");
  console.log("  windows-dshow   Capture a Windows DirectShow audio device via ffmpeg");
}

function isCommandNotFoundError(commandError: unknown, command: string): boolean {
  const text = String(commandError);
  return text.includes("ENOENT") && text.includes(command);
}

async function listPulseSources(pactlPath: string): Promise<void> {
  const printPulseListingWarning = (message: string): void => {
    printAvailableSources();
    console.log("");
    warn(message);
    console.log(`You can still use --source pulse-monitor --audio-device <SOURCE_NAME> if you already know the monitor/source name.`);
  };

  let result: CapturedCommandResult;
  try {
    result = await runCommandCapture(pactlPath, ["list", "short", "sources"]);
  } catch (captureError) {
    if (isCommandNotFoundError(captureError, pactlPath)) {
      printPulseListingWarning(
        `PulseAudio/PipeWire source listing is unavailable because "${pactlPath}" was not found. Install pactl or provide --audio-device manually if you already know the source name.`,
      );
      return;
    }

    printPulseListingWarning(
      `PulseAudio/PipeWire source listing is unavailable: ${String(captureError)}`,
    );
    return;
  }

  if (result.code !== 0) {
    printPulseListingWarning(
      `PulseAudio/PipeWire source listing is unavailable: ${result.stderr.trim() || `exit code ${result.code ?? "null"}`}`,
    );
    return;
  }

  const rows = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\t+/))
    .filter((columns) => columns.length >= 5)
    .map(([id, name, driver, spec, state]) => ({
      id,
      name,
      driver,
      spec,
      state,
      isMonitor: isMonitorSourceName(name),
    }))
    .sort((left, right) => Number(right.isMonitor) - Number(left.isMonitor) || left.name.localeCompare(right.name));

  printAvailableSources();
  console.log("");
  console.log("PulseAudio/PipeWire sources:");

  if (rows.length === 0) {
    console.log("  (none found)");
    return;
  }

  for (const row of rows) {
    const kind = row.isMonitor ? "monitor" : "source";
    console.log(`  ${row.name}  [${kind}]  ${row.spec}  ${row.state}`);
  }
}

async function listDirectShowAudioDevices(ffmpegPath: string): Promise<void> {
  const result = await runCommandCapture(ffmpegPath, [
    "-hide_banner",
    "-list_devices",
    "true",
    "-f",
    "dshow",
    "-i",
    "dummy",
  ]);

  const devices: string[] = [];
  let inAudioSection = false;

  for (const line of result.stderr.split(/\r?\n/)) {
    if (line.includes("DirectShow audio devices")) {
      inAudioSection = true;
      continue;
    }

    if (line.includes("DirectShow video devices")) {
      inAudioSection = false;
      continue;
    }

    if (!inAudioSection) {
      continue;
    }

    const match = line.match(/"([^"]+)"/);
    if (!match) {
      continue;
    }

    if (!devices.includes(match[1])) {
      devices.push(match[1]);
    }
  }

  if (devices.length === 0) {
    throw new Error(
      `failed to list DirectShow audio devices using ${ffmpegPath}: ${result.stderr.trim() || `exit code ${result.code ?? "null"}`}`,
    );
  }

  printAvailableSources();
  console.log("");
  console.log("DirectShow audio devices:");
  for (const device of devices) {
    console.log(`  ${device}`);
  }
}

async function listDevices(options: {
  audioSource: AudioSource;
  ffmpegPath: string;
  pactlPath: string;
}): Promise<void> {
  switch (options.audioSource) {
    case "pulse-monitor":
      if (process.platform !== "linux") {
        throw new Error("pulse-monitor source listing is only supported on Linux");
      }

      await listPulseSources(options.pactlPath);
      return;
    case "windows-dshow":
      if (process.platform !== "win32") {
        throw new Error("windows-dshow source listing is only supported on Windows");
      }

      await listDirectShowAudioDevices(options.ffmpegPath);
      return;
    case "stdin":
    case "spotify":
      printAvailableSources();
      console.log("");
      console.log(`source "${options.audioSource}" does not use a device list`);
      return;
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

async function promoteStageSpeaker(channel: GuildBasedChannel): Promise<void> {
  if (channel.type !== ChannelType.GuildStageVoice) {
    return;
  }

  const me = await channel.guild.members.fetchMe();

  try {
    await me.voice.setSuppressed(false);
    info("unsuppressed bot in stage channel");
  } catch (unsuppressError) {
    warn(
      `failed to unsuppress the bot in the stage channel: ${String(
        unsuppressError,
      )}. trying request-to-speak instead`,
    );

    try {
      await me.voice.setRequestToSpeak(true);
      info("requested to speak in stage channel");
    } catch (requestError) {
      warn(`failed to request speaking privileges in the stage channel: ${String(requestError)}`);
    }
  }
}

const voiceDebugBindings = new WeakSet<VoiceConnection>();

function describeVoiceDisconnectedState(connection: VoiceConnection): string {
  const state = connection.state;
  if (state.status !== VoiceConnectionStatus.Disconnected) {
    return state.status;
  }

  if (state.reason === VoiceConnectionDisconnectReason.WebSocketClose) {
    return `websocket close ${state.closeCode}`;
  }

  switch (state.reason) {
    case VoiceConnectionDisconnectReason.AdapterUnavailable:
      return "adapter unavailable";
    case VoiceConnectionDisconnectReason.EndpointRemoved:
      return "endpoint removed";
    case VoiceConnectionDisconnectReason.Manual:
      return "manual disconnect";
  }

  return "unknown disconnect";
}

function attachVoiceDebug(connection: VoiceConnection): void {
  if (voiceDebugBindings.has(connection)) {
    return;
  }

  voiceDebugBindings.add(connection);
  connection.on("debug", (message) => debug(`[voice] ${message}`));
  connection.on("error", (connectionError) => error(`[voice] ${connectionError.stack ?? connectionError}`));
  connection.on(VoiceConnectionStatus.Disconnected, (_oldState, newState) => {
    warn(`[voice] disconnected: ${JSON.stringify(newState)}`);
  });
}

async function main(): Promise<void> {
  if (isDebugEnabled()) {
    debug(generateDependencyReport());
  }

  const args = parseArgs({
    options: {
      "bot-token": { type: "string" },
      "voice-channel-id": { type: "string" },
      "bot-activity": { type: "string" },
      "audio-device": { type: "string" },
      source: { type: "string" },
      spotify: { type: "boolean" },
      "input-format": { type: "string" },
      "ffmpeg-path": { type: "string" },
      "parec-path": { type: "string" },
      "pactl-path": { type: "string" },
      "librespot-path": { type: "string" },
      "librespot-name": { type: "string" },
      "librespot-bitrate": { type: "string" },
      "librespot-arg": { type: "string", multiple: true },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: true,
  });

  if (args.values.help) {
    console.log(`Usage:
  stdinman [OPTIONS]
  stdinman devices list [--source <pulse-monitor|windows-dshow>]

Options:
  --bot-token <BOT_TOKEN>
  --voice-channel-id <VOICE_CHANNEL_ID>
  --bot-activity <BOT_ACTIVITY>
  --audio-device <DEVICE_NAME>
  --source <stdin|spotify|pulse-monitor|windows-dshow>
  --spotify
  --input-format <f32le|s16le>
  --ffmpeg-path <PATH>
  --parec-path <PATH>
  --pactl-path <PATH>
  --librespot-path <PATH>
  --librespot-name <DEVICE_NAME>
  --librespot-bitrate <BITRATE>
  --librespot-arg <ARG> (repeatable)
  -h, --help`);
    return;
  }

  const configPath = resolveConfigPath();
  const positionals = args.positionals;
  const isDevicesListCommand =
    positionals.length === 2 && positionals[0] === "devices" && positionals[1] === "list";
  if (!isDevicesListCommand && positionals.length > 0) {
    throw new Error(`unknown command: ${positionals.join(" ")}`);
  }

  const config = isDevicesListCommand
    ? await loadOptionalConfig(configPath)
    : await loadConfig(configPath);

  const botToken = args.values["bot-token"] ?? config.bot_token;
  const voiceChannelId = args.values["voice-channel-id"] ?? config.voice_channel_id;
  const botActivity = args.values["bot-activity"] ?? config.bot_activity;
  const audioSource = normalizeAudioSource(
    args.values.spotify ? "spotify" : (args.values.source ?? config.audio_source),
  );
  const audioDevice = args.values["audio-device"] ?? config.audio_device;
  const inputFormat = normalizeInputFormat(args.values["input-format"] ?? config.input_format);
  const ffmpegPath = args.values["ffmpeg-path"] ?? config.ffmpeg_path;
  const parecPath = args.values["parec-path"] ?? config.parec_path;
  const pactlPath = args.values["pactl-path"] ?? config.pactl_path;
  const librespotPath = args.values["librespot-path"] ?? config.librespot_path;
  const librespotName = args.values["librespot-name"] ?? config.librespot_name;
  const librespotBitrate = normalizeLibrespotBitrate(
    args.values["librespot-bitrate"] ?? config.librespot_bitrate,
  );
  const librespotArgs = args.values["librespot-arg"] ?? config.librespot_args;

  if (isDevicesListCommand) {
    const listSource =
      args.values.source ??
      (process.platform === "linux"
        ? "pulse-monitor"
        : process.platform === "win32"
          ? "windows-dshow"
          : config.audio_source);

    await listDevices({
      audioSource: normalizeAudioSource(listSource),
      ffmpegPath,
      pactlPath,
    });
    return;
  }

  if (!botToken) {
    throw new Error(
      `missing bot_token in config! Please provide it via CLI arg or add it in ${configPath}`,
    );
  }

  if (!voiceChannelId) {
    throw new Error(
      `missing voice_channel_id in config! Please provide it via CLI arg or add it in ${configPath}`,
    );
  }

  if (audioSource !== "stdin" && args.values["input-format"]) {
    warn(`ignoring --input-format because the ${audioSource} source does not read raw stdin PCM`);
  }

  if (
    audioSource !== "spotify" &&
    (args.values["librespot-path"] ||
      args.values["librespot-name"] ||
      args.values["librespot-bitrate"] ||
      args.values["librespot-arg"])
  ) {
    warn("ignoring librespot options because the selected source is not spotify");
  }

  if (
    audioSource !== "pulse-monitor" &&
    audioSource !== "windows-dshow" &&
    args.values["audio-device"]
  ) {
    warn("ignoring --audio-device because the selected source does not use a capture device name");
  }

  if (audioSource === "pulse-monitor" && process.platform !== "linux") {
    throw new Error("pulse-monitor source is only supported on Linux");
  }

  if (audioSource === "windows-dshow" && process.platform !== "win32") {
    throw new Error("windows-dshow source is only supported on Windows");
  }

  if (
    (audioSource === "pulse-monitor" || audioSource === "windows-dshow") &&
    !audioDevice
  ) {
    throw new Error(
      `source "${audioSource}" requires --audio-device or audio_device in ${configPath}`,
    );
  }

  const audioSourceHandle =
    audioSource === "spotify"
      ? createSpotifySource({
          librespotPath,
          librespotName,
          librespotBitrate,
          librespotArgs,
        })
      : audioSource === "pulse-monitor"
        ? createPulseMonitorSource({
            parecPath,
            audioDevice,
          })
        : audioSource === "windows-dshow"
          ? createWindowsDshowSource({
              ffmpegPath,
              audioDevice,
            })
          : createSwitchingStdinStream();

  let connection: VoiceConnection | undefined;
  let stopTranscoder: (() => void) | undefined;
  let stopAudioSource: (() => void) | undefined;
  let playbackStarted = false;
  let shuttingDown = false;

  const shutdown = async (code: number): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;

    try {
      connection?.destroy();
    } catch (connectionError) {
      debug(`failed to destroy voice connection cleanly: ${String(connectionError)}`);
    }

    try {
      stopTranscoder?.();
    } catch (transcoderError) {
      debug(`failed to stop ffmpeg transcoder cleanly: ${String(transcoderError)}`);
    }

    try {
      stopAudioSource?.();
    } catch (sourceError) {
      debug(`failed to stop audio source cleanly: ${String(sourceError)}`);
    }

    try {
      await client.destroy();
    } catch (clientError) {
      debug(`failed to destroy Discord client cleanly: ${String(clientError)}`);
    }

    process.exit(code);
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });

  client.on(Events.Error, (clientError) => {
    error(clientError.stack ?? String(clientError));
  });

  if (isDebugEnabled()) {
    client.on(Events.Debug, (message) => debug(`[gateway] ${message}`));
  }

  audioSourceHandle.stream.on("error", (sourceError) => {
    error(`[source] ${sourceError.stack ?? sourceError}`);
    void shutdown(1);
  });

  process.once("SIGINT", () => void shutdown(0));
  process.once("SIGTERM", () => void shutdown(0));

  info("logging into Discord");
  await client.login(botToken);
  await waitForReady(client);

  if (!client.user) {
    throw new Error("discord client became ready without a user");
  }

  info("discord bot is ready");
  client.user.setActivity(botActivity);

  const channel = await client.channels.fetch(voiceChannelId);

  if (!channel) {
    throw new Error(`failed to find voice channel ${voiceChannelId}`);
  }

  if (!isVoiceTargetChannel(channel)) {
    throw new Error(`channel ${voiceChannelId} is not a voice-capable guild channel`);
  }

  const voiceChannel = channel;
  info(`found channel ${channel.id} in guild ${channel.guild.id}, attempting to connect...`);

  const player = createAudioPlayer({
    behaviors: {
      // Keep live sources flowing during reconnect windows instead of backpressuring stdin/librespot.
      noSubscriber: NoSubscriberBehavior.Play,
    },
  });

  player.on("debug", (message) => debug(`[player] ${message}`));
  player.on("error", (playerError) => {
    error(`[player] ${playerError.stack ?? playerError}`);
    void shutdown(1);
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
    if (!playbackStarted) {
      return;
    }

    info("audio input ended; disconnecting");
    void shutdown(0);
  });

  let reconnectingVoiceConnection: Promise<void> | undefined;
  const voiceConnectionHandlers = new WeakSet<VoiceConnection>();

  const createOrReuseVoiceConnection = (): VoiceConnection => {
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
    attachVoiceDebug(nextConnection);

    if (!voiceConnectionHandlers.has(nextConnection)) {
      voiceConnectionHandlers.add(nextConnection);

      nextConnection.on(VoiceConnectionStatus.Disconnected, () => {
        if (shuttingDown || reconnectingVoiceConnection) {
          return;
        }

        warn(
          `voice connection disconnected (${describeVoiceDisconnectedState(nextConnection)}); attempting recovery`,
        );
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

  const ensureVoiceConnection = async (trigger: string): Promise<void> => {
    if (reconnectingVoiceConnection) {
      return reconnectingVoiceConnection;
    }

    reconnectingVoiceConnection = (async () => {
      let attempt = 0;
      let lastError: unknown;

      while (!shuttingDown) {
        attempt++;

        const delayMs =
          attempt === 1
            ? 0
            : Math.min(
                VOICE_RECONNECT_INITIAL_DELAY_MS * 2 ** (attempt - 2),
                VOICE_RECONNECT_MAX_DELAY_MS,
              );

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
              try {
                await Promise.race([
                  entersState(nextConnection, VoiceConnectionStatus.Signalling, VOICE_RECONNECT_GRACE_MS),
                  entersState(nextConnection, VoiceConnectionStatus.Connecting, VOICE_RECONNECT_GRACE_MS),
                  entersState(nextConnection, VoiceConnectionStatus.Ready, VOICE_RECONNECT_GRACE_MS),
                ]);
              } catch {
                nextConnection.rejoin({
                  channelId: voiceChannel.id,
                  selfDeaf: true,
                  selfMute: false,
                });
              }
            } else {
              nextConnection.rejoin({
                channelId: voiceChannel.id,
                selfDeaf: true,
                selfMute: false,
              });
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
          lastError = reconnectError;
          warn(
            `voice reconnect attempt ${attempt} failed: ${
              reconnectError instanceof Error ? reconnectError.message : String(reconnectError)
            }`,
          );

          if (connection?.state.status === VoiceConnectionStatus.Destroyed) {
            connection = undefined;
          }
        }
      }

      if (lastError) {
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
      }
    })().finally(() => {
      reconnectingVoiceConnection = undefined;
    });

    return reconnectingVoiceConnection;
  };

  await ensureVoiceConnection("initial connection");

  info(audioSourceHandle.startupMessage);
  const transcoder = createFfmpegOpusStream(
    ffmpegPath,
    audioSourceHandle.stream,
    audioSource === "stdin"
      ? {
          ...audioSourceHandle.ffmpegInput,
          format: inputFormat,
        }
      : audioSourceHandle.ffmpegInput,
  );
  stopTranscoder = transcoder.stop;
  stopAudioSource = audioSourceHandle.stop;
  const resource = createAudioResource(transcoder.stream, {
    inputType: StreamType.OggOpus,
    metadata: null,
  });
  player.play(resource);
  audioSourceHandle.start();

  if (audioSourceHandle.awaitInitialPlayback) {
    await entersState(player, AudioPlayerStatus.Playing, 60_000);
  }
}

main().catch((mainError) => {
  error(mainError instanceof Error ? mainError.stack ?? mainError.message : String(mainError));
  process.exit(1);
});
