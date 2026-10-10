import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, type Readable } from "node:stream";
import type { InputFormat } from "./config.ts";
import { LineTail, debug, info, isDebugEnabled, warn } from "./log.ts";

export type FfmpegInputSpec = {
  format: InputFormat;
  sampleRate: number;
  channels: number;
  waitingMessage: string;
};

export type PreparedAudioSource = {
  stream: Readable;
  ffmpegInput: FfmpegInputSpec;
  start: () => void;
  stop: () => void;
  startupMessage: string;
  awaitInitialPlayback: boolean;
};

/**
 * Reads PCM from `input` (normally process.stdin) but discards everything until
 * start() is called, so audio that arrives while the bot is still connecting is
 * dropped instead of being played late.
 */
export function createSwitchingStdinStream(
  inputFormat: InputFormat,
  input: NodeJS.ReadableStream = process.stdin,
): PreparedAudioSource {
  const output = new PassThrough();
  let forwarding = false;
  let waitingForDrain = false;

  const onData = (chunk: Buffer): void => {
    if (!forwarding || output.destroyed || output.writableEnded) {
      return;
    }

    if (!output.write(chunk) && !waitingForDrain) {
      waitingForDrain = true;
      input.pause();
      output.once("drain", () => {
        waitingForDrain = false;
        input.resume();
      });
    }
  };

  const onEnd = (): void => {
    output.end();
  };

  const onError = (streamError: Error): void => {
    output.destroy(streamError);
  };

  const detach = (): void => {
    input.off("data", onData);
    input.off("end", onEnd);
    input.off("error", onError);
  };

  input.on("data", onData);
  input.on("end", onEnd);
  input.on("error", onError);
  output.once("close", detach);
  input.resume();

  return {
    stream: output,
    ffmpegInput: {
      format: inputFormat,
      sampleRate: 48_000,
      channels: 2,
      waitingMessage: `ffmpeg has not produced any opus packets yet. Make sure raw ${inputFormat} PCM (48 kHz stereo) is being piped into stdin.`,
    },
    start: (): void => {
      forwarding = true;
    },
    stop: (): void => {
      detach();
      output.end();
    },
    startupMessage: "going to pipe stdin to the bot",
    awaitInitialPlayback: true,
  };
}

export function createProcessAudioSource(options: {
  command: string;
  args: string[];
  ffmpegInput: FfmpegInputSpec;
  startupMessage: string;
  startedMessage: string;
  logPrefix: string;
  awaitInitialPlayback: boolean;
}): PreparedAudioSource {
  const output = new PassThrough();
  const stderrTail = new LineTail();
  let child: ChildProcess | undefined;
  let stopping = false;

  return {
    stream: output,
    ffmpegInput: options.ffmpegInput,
    start: (): void => {
      if (child || stopping) {
        return;
      }

      debug(`starting ${options.logPrefix} source: ${options.command} ${options.args.join(" ")}`);
      child = spawn(options.command, options.args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      const stdout = child.stdout;
      const stderr = child.stderr;
      if (!stdout || !stderr) {
        throw new Error(`${options.logPrefix} did not start with piped stdout/stderr`);
      }

      stdout.pipe(output);
      stderr.setEncoding("utf8");
      stderr.on("data", (chunk: string) => {
        for (const line of stderrTail.push(chunk)) {
          debug(`[${options.logPrefix}] ${line}`);
        }
      });
      child.on("spawn", () => {
        info(options.startedMessage);
      });
      child.on("error", (childError: NodeJS.ErrnoException) => {
        const hint = childError.code === "ENOENT" ? ` (is "${options.command}" installed and on PATH?)` : "";
        output.destroy(
          new Error(`failed to start ${options.logPrefix} source (${options.command}): ${childError.message}${hint}`),
        );
      });
      child.on("close", (code, signal) => {
        if (stopping) {
          output.end();
          return;
        }

        const tail = stderrTail.text();
        output.destroy(
          new Error(
            `${options.logPrefix} exited with code=${code ?? "null"} signal=${signal ?? "null"}${tail ? `\n${tail}` : ""}`,
          ),
        );
      });
    },
    stop: (): void => {
      if (stopping) {
        return;
      }

      stopping = true;
      output.end();
      if (!child) {
        return;
      }

      child.stdout?.unpipe(output);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
    },
    startupMessage: options.startupMessage,
    awaitInitialPlayback: options.awaitInitialPlayback,
  };
}

export function librespotArgs(options: {
  librespotName: string;
  librespotBitrate: number;
  librespotArgs: string[];
}): string[] {
  return [
    "-n",
    options.librespotName,
    "--backend",
    "pipe",
    "-b",
    String(options.librespotBitrate),
    ...options.librespotArgs,
  ];
}

export function createSpotifySource(options: {
  librespotPath: string;
  librespotName: string;
  librespotBitrate: number;
  librespotArgs: string[];
}): PreparedAudioSource {
  return createProcessAudioSource({
    command: options.librespotPath,
    args: librespotArgs(options),
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

export function parecArgs(audioDevice: string): string[] {
  return ["-d", audioDevice, "--format=float32le", "--rate=48000", "--channels=2", "--latency-msec=20"];
}

export function createPulseMonitorSource(options: { parecPath: string; audioDevice: string }): PreparedAudioSource {
  return createProcessAudioSource({
    command: options.parecPath,
    args: parecArgs(options.audioDevice),
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

export function formatDirectShowAudioInput(audioDevice: string): string {
  return audioDevice.startsWith("audio=") || audioDevice.startsWith("video=") ? audioDevice : `audio=${audioDevice}`;
}

export function directShowCaptureArgs(audioDevice: string, debugEnabled = isDebugEnabled()): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    debugEnabled ? "warning" : "error",
    "-f",
    "dshow",
    "-audio_buffer_size",
    "50",
    "-sample_rate",
    "48000",
    "-channels",
    "2",
    "-i",
    formatDirectShowAudioInput(audioDevice),
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
  ];
}

export function createWindowsDshowSource(options: { ffmpegPath: string; audioDevice: string }): PreparedAudioSource {
  return createProcessAudioSource({
    command: options.ffmpegPath,
    args: directShowCaptureArgs(options.audioDevice),
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

export type TranscodeOptions = {
  volume: number;
  opusBitrate: number;
};

export function ffmpegOpusArgs(
  ffmpegInput: FfmpegInputSpec,
  options: TranscodeOptions,
  debugEnabled = isDebugEnabled(),
): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    "-analyzeduration",
    "0",
    "-loglevel",
    debugEnabled ? "warning" : "error",
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
    ...(options.volume !== 1 ? ["-af", `volume=${options.volume}`] : []),
    "-c:a",
    "libopus",
    ...(options.opusBitrate > 0 ? ["-b:a", `${options.opusBitrate}k`] : []),
    "-application",
    "audio",
    "-frame_duration",
    "20",
    "-ar",
    "48000",
    "-ac",
    "2",
    // Emit one Ogg page per opus packet; the default 1s pages make live audio bursty.
    "-page_duration",
    "20000",
    "-flush_packets",
    "1",
    "-f",
    "ogg",
    "pipe:1",
  ];
}

export type Transcoder = {
  stream: Readable;
  stop: () => void;
  /** Emits "error" when ffmpeg cannot start or dies unexpectedly. */
  events: EventEmitter<{ error: [Error] }>;
};

export function createFfmpegOpusStream(
  ffmpegPath: string,
  input: Readable,
  ffmpegInput: FfmpegInputSpec,
  options: TranscodeOptions,
): Transcoder {
  const ffmpegArgs = ffmpegOpusArgs(ffmpegInput, options);
  debug(`starting ffmpeg transcoder: ${ffmpegPath} ${ffmpegArgs.join(" ")}`);

  const events = new EventEmitter<{ error: [Error] }>();
  const stderrTail = new LineTail();
  const child = spawn(ffmpegPath, ffmpegArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let sawOutput = false;
  let stopping = false;
  let failed = false;
  const reportFailure = (failure: Error): void => {
    // A spawn failure emits both "error" and "close"; only report the first.
    if (!failed) {
      failed = true;
      events.emit("error", failure);
    }
  };

  // ffmpeg closing its stdin early (e.g. when it crashes) must not take the process down with EPIPE.
  child.stdin.on("error", (stdinError) => {
    debug(`[ffmpeg] stdin error: ${stdinError.message}`);
  });
  input.pipe(child.stdin);

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    for (const line of stderrTail.push(chunk)) {
      debug(`[ffmpeg] ${line}`);
    }
  });
  child.stdout.once("data", () => {
    sawOutput = true;
    info("ffmpeg produced opus output");
  });

  child.on("error", (childError: NodeJS.ErrnoException) => {
    const hint = childError.code === "ENOENT" ? ` (is "${ffmpegPath}" installed and on PATH?)` : "";
    reportFailure(new Error(`failed to start ffmpeg transcoder (${ffmpegPath}): ${childError.message}${hint}`));
  });

  child.on("close", (code, signal) => {
    if (stopping || code === 0) {
      return;
    }

    const tail = stderrTail.text();
    reportFailure(
      new Error(`ffmpeg exited unexpectedly with code=${code ?? "null"} signal=${signal ?? "null"}${tail ? `\n${tail}` : ""}`),
    );
  });

  setTimeout(() => {
    if (!sawOutput && !stopping) {
      warn(ffmpegInput.waitingMessage);
    }
  }, 10_000).unref();

  return {
    stream: child.stdout,
    events,
    stop: (): void => {
      if (stopping) {
        return;
      }

      stopping = true;
      input.unpipe(child.stdin);
      child.stdin.destroy();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
    },
  };
}
