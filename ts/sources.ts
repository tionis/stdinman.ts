import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createReadStream } from "node:fs";
import { PassThrough, type Readable } from "node:stream";
import { trackChild } from "./children.ts";
import type { InputFormat } from "./config.ts";
import { spawnPiped, spawnWithBackpressure } from "./fifo.ts";
import type { PacingMode, PcmLayout } from "./pacer.ts";
import { LineTail, debug, info, isDebugEnabled, warn } from "./log.ts";

export type FfmpegInputSpec = {
  format: InputFormat;
  sampleRate: number;
  channels: number;
  waitingMessage: string;
};

export type NowPlayingEvents = { change: [title: string | null] };

export type PreparedAudioSource = {
  stream: Readable;
  ffmpegInput: FfmpegInputSpec;
  start: () => void;
  stop: () => void;
  startupMessage: string;
  awaitInitialPlayback: boolean;
  /** Emits "change" with a human readable title (or null) when the playing item changes. */
  nowPlaying?: EventEmitter<NowPlayingEvents>;
  /** Pause (rather than discard) audio while the bot is not in a channel. For finite media. */
  pauseWhenUnheard?: boolean;
  /**
   * How audio is kept in step with playback (see pacer.ts): "wait" for sources that can
   * run faster than real time, "drop" for live capture whose clock drifts. Unset: unpaced.
   */
  pacing?: PacingMode;
};

const BYTES_PER_SAMPLE: Record<Exclude<InputFormat, "wav">, number> = { f32le: 4, s16le: 2, s32le: 4 };

/** Byte layout of the transcoder input, or "wav" when it is read from the stream's header. */
export function pcmLayout(spec: FfmpegInputSpec): PcmLayout | "wav" {
  if (spec.format === "wav") {
    return "wav";
  }

  const frameBytes = BYTES_PER_SAMPLE[spec.format] * spec.channels;
  return { bytesPerSecond: frameBytes * spec.sampleRate, frameBytes };
}

export const CAPTURE_SAMPLE_RATE = 48_000;
export const CAPTURE_CHANNELS = 2;

export function rawPcmInput(
  format: InputFormat,
  waitingMessage: string,
  sampleRate = CAPTURE_SAMPLE_RATE,
  channels = CAPTURE_CHANNELS,
): FfmpegInputSpec {
  return { format, sampleRate, channels, waitingMessage };
}

/**
 * Opens stdin as a pull-based file stream. Unlike process.stdin, this respects
 * backpressure under Bun too, so a fast writer (`cat song.raw | stdinman`) is
 * held back instead of being read into memory.
 */
function openStdin(): NodeJS.ReadableStream {
  return createReadStream("", { fd: 0, highWaterMark: 16 * 1024, autoClose: false });
}

/**
 * Reads PCM from `input` (normally stdin) but discards everything until
 * start() is called, so audio that arrives while the bot is still connecting is
 * dropped instead of being played late.
 */
export function createSwitchingStdinStream(
  pcm: { inputFormat: InputFormat; sampleRate: number; channels: number },
  input: NodeJS.ReadableStream = openStdin(),
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
    ffmpegInput: rawPcmInput(
      pcm.inputFormat,
      `ffmpeg has not produced any opus packets yet. Make sure ${describePcm(pcm)} audio is being piped into stdin.`,
      pcm.sampleRate,
      pcm.channels,
    ),
    start: (): void => {
      forwarding = true;
    },
    stop: (): void => {
      detach();
      output.end();
    },
    startupMessage: "going to pipe stdin to the bot",
    awaitInitialPlayback: true,
    // stdin may carry a file (faster than real time) or a live stream; waiting suits both.
    pacing: "wait",
  };
}

export function describePcm(pcm: { inputFormat: InputFormat; sampleRate: number; channels: number }): string {
  return pcm.inputFormat === "wav"
    ? "WAV"
    : `raw ${pcm.inputFormat} PCM (${pcm.sampleRate} Hz, ${pcm.channels} channel${pcm.channels === 1 ? "" : "s"})`;
}

export function createProcessAudioSource(options: {
  command: string;
  args: string[];
  /** Run the command through the system shell (for user supplied command lines). */
  shell?: boolean;
  ffmpegInput: FfmpegInputSpec;
  startupMessage: string;
  startedMessage: string;
  logPrefix: string;
  awaitInitialPlayback: boolean;
  /** Called for every stderr line; return true to suppress the debug log for that line. */
  onStderrLine?: (line: string) => boolean;
  nowPlaying?: EventEmitter<NowPlayingEvents>;
  /** Called once the source has stopped or failed, e.g. to remove temporary files. */
  cleanup?: () => void;
  pacing?: PacingMode;
  /** Read stdout through a FIFO for real backpressure (for producers faster than real time). */
  useFifo?: boolean;
}): PreparedAudioSource {
  const output = new PassThrough();
  const stderrTail = new LineTail();
  let child: ChildProcess | undefined;
  let childStdout: Readable | undefined;
  let stopping = false;
  let cleanedUp = false;
  const cleanup = (): void => {
    if (!cleanedUp) {
      cleanedUp = true;
      options.cleanup?.();
    }
  };
  output.once("close", cleanup);

  return {
    stream: output,
    ffmpegInput: options.ffmpegInput,
    nowPlaying: options.nowPlaying,
    pacing: options.pacing,
    start: (): void => {
      if (child || stopping) {
        return;
      }

      debug(`starting ${options.logPrefix} source: ${options.command} ${options.args.join(" ")}`);
      const spawnOptions = { windowsHide: true, shell: options.shell };
      // Producers faster than real time need real backpressure, or they run far ahead of playback.
      const spawned = options.useFifo
        ? spawnWithBackpressure(options.command, options.args, spawnOptions)
        : spawnPiped(options.command, options.args, spawnOptions);
      child = spawned.child;
      childStdout = spawned.stdout;

      const stderr = child.stderr;
      if (!stderr) {
        throw new Error(`${options.logPrefix} did not start with piped stderr`);
      }

      spawned.stdout.pipe(output, { end: false });
      stderr.setEncoding("utf8");
      stderr.on("data", (chunk: string) => {
        for (const line of stderrTail.push(chunk)) {
          if (!options.onStderrLine?.(line)) {
            debug(`[${options.logPrefix}] ${line}`);
          }
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
      spawned.onClose((code, signal) => {
        cleanup();
        if (stopping || code === 0) {
          // A clean exit ends the audio like EOF on stdin.
          if (!stopping) {
            info(`${options.logPrefix} finished`);
          }
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
        cleanup();
        return;
      }

      childStdout?.unpipe(output);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
    },
    startupMessage: options.startupMessage,
    awaitInitialPlayback: options.awaitInitialPlayback,
  };
}

export function parecArgs(audioDevice: string): string[] {
  return ["-d", audioDevice, "--format=float32le", "--rate=48000", "--channels=2", "--latency-msec=20"];
}

export function createPulseMonitorSource(options: { parecPath: string; audioDevice: string }): PreparedAudioSource {
  return createProcessAudioSource({
    command: options.parecPath,
    args: parecArgs(options.audioDevice),
    ffmpegInput: rawPcmInput(
      "f32le",
      `ffmpeg is still waiting for PulseAudio/PipeWire input from source "${options.audioDevice}". Make sure audio is routed to that source.`,
    ),
    startupMessage: `starting PulseAudio/PipeWire capture from source "${options.audioDevice}"`,
    startedMessage: `PulseAudio/PipeWire capture started from source "${options.audioDevice}"`,
    logPrefix: "parec",
    awaitInitialPlayback: false,
    pacing: "drop",
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
    ffmpegInput: rawPcmInput(
      "f32le",
      `ffmpeg is still waiting for DirectShow input from "${options.audioDevice}". Make sure the capture device is active and producing audio.`,
    ),
    startupMessage: `starting DirectShow capture from audio device "${options.audioDevice}"`,
    startedMessage: `DirectShow capture started from audio device "${options.audioDevice}"`,
    logPrefix: "ffmpeg-dshow",
    awaitInitialPlayback: false,
    pacing: "drop",
  });
}

export function createCommandSource(options: {
  command: string;
  inputFormat: InputFormat;
  sampleRate: number;
  channels: number;
}): PreparedAudioSource {
  return createProcessAudioSource({
    command: options.command,
    args: [],
    shell: true,
    ffmpegInput: rawPcmInput(
      options.inputFormat,
      `ffmpeg is still waiting for audio from the command. Make sure it writes ${describePcm(options)} to stdout.`,
      options.sampleRate,
      options.channels,
    ),
    startupMessage: `starting command: ${options.command}`,
    startedMessage: "command started",
    logPrefix: "command",
    awaitInitialPlayback: false,
    // The command may be a file decoder (faster than real time) or a live recorder; waiting suits both.
    pacing: "wait",
    useFifo: true,
  });
}

export function pwRecordArgs(target: string): string[] {
  return [
    "--raw",
    "--format",
    "f32",
    "--rate",
    String(CAPTURE_SAMPLE_RATE),
    "--channels",
    String(CAPTURE_CHANNELS),
    "--latency",
    "20ms",
    "--media-category",
    "Capture",
    "-P",
    "node.name=stdinman",
    // Capture the monitor when the target is a sink (or, without a target, the default sink).
    "-P",
    "stream.capture.sink=true",
    // Never silently fall back to another device if the target is missing.
    "-P",
    "node.dont-fallback=true",
    ...(target ? ["--target", target] : []),
    "-",
  ];
}

export function avfoundationCaptureArgs(audioDevice: string, debugEnabled = isDebugEnabled()): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    debugEnabled ? "warning" : "error",
    "-f",
    "avfoundation",
    "-i",
    `:${audioDevice}`,
    "-vn",
    "-acodec",
    "pcm_f32le",
    "-ar",
    String(CAPTURE_SAMPLE_RATE),
    "-ac",
    String(CAPTURE_CHANNELS),
    "-f",
    "f32le",
    "pipe:1",
  ];
}

export function createAvfoundationSource(options: { ffmpegPath: string; audioDevice: string }): PreparedAudioSource {
  return createProcessAudioSource({
    command: options.ffmpegPath,
    args: avfoundationCaptureArgs(options.audioDevice),
    ffmpegInput: rawPcmInput(
      "f32le",
      `ffmpeg is still waiting for AVFoundation input from "${options.audioDevice}". Make sure audio is routed to that device and that the terminal has microphone permission.`,
    ),
    startupMessage: `starting AVFoundation capture from audio device "${options.audioDevice}"`,
    startedMessage: `AVFoundation capture started from audio device "${options.audioDevice}"`,
    logPrefix: "ffmpeg-avfoundation",
    awaitInitialPlayback: false,
    pacing: "drop",
  });
}

export type TranscodeOptions = {
  volume: number;
  opusBitrate: number;
  /** Extra ffmpeg audio filter chain, e.g. "bass=g=3". */
  audioFilter?: string;
};

function audioFilterArgs(options: TranscodeOptions): string[] {
  const filters = [
    ...(options.volume !== 1 ? [`volume=${options.volume}`] : []),
    ...(options.audioFilter ? [options.audioFilter] : []),
  ];
  return filters.length > 0 ? ["-af", filters.join(",")] : [];
}

export function ffmpegOpusArgs(
  ffmpegInput: FfmpegInputSpec,
  options: TranscodeOptions,
  debugEnabled = isDebugEnabled(),
): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    // The input format is known, so skip probing: the default 5 MB probe delays live audio by many seconds.
    "-probesize",
    "32",
    "-analyzeduration",
    "0",
    "-loglevel",
    debugEnabled ? "warning" : "error",
    ...(ffmpegInput.format === "wav"
      ? ["-f", "wav", "-ignore_length", "1"]
      : ["-f", ffmpegInput.format, "-ar", String(ffmpegInput.sampleRate), "-ac", String(ffmpegInput.channels)]),
    "-i",
    "pipe:0",
    "-map",
    "0:a:0",
    ...audioFilterArgs(options),
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
  const child = trackChild(
    spawn(ffmpegPath, ffmpegArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }),
  );
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
