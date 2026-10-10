import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { PassThrough, type Readable } from "node:stream";
import type { InputFormat } from "./config.ts";
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
   * The source produces audio faster than real time (librespot's pipe backend, file decoding).
   * Such sources are paced, otherwise pipes and ffmpeg buffer many seconds of audio and
   * pausing or skipping takes that long to be heard.
   */
  fasterThanRealtime?: boolean;
};

const BYTES_PER_SAMPLE: Record<Exclude<InputFormat, "wav">, number> = { f32le: 4, s16le: 2, s32le: 4 };

/** Byte rate of raw PCM input, or undefined for self-describing formats such as WAV. */
export function pcmBytesPerSecond(spec: FfmpegInputSpec): number | undefined {
  return spec.format === "wav" ? undefined : BYTES_PER_SAMPLE[spec.format] * spec.sampleRate * spec.channels;
}

/** How much audio the pacer lets run ahead of playback, to absorb encoder delay and timer jitter. */
export const PACER_LEAD_MS = 250;
/** Until playback starts, ffmpeg needs a little more input before it emits its first packets. */
const PACER_STARTUP_LEAD_MS = 1_000;
const PACER_POLL_MS = 10;

/**
 * Releases PCM only as fast as it is actually played: at most `leadMs` ahead of
 * `playedMs()`, the amount of real audio the consumer has played so far. Following
 * the playback position (rather than the wall clock) also absorbs encoder startup,
 * reconnects and paused playback without building up delay.
 */
export function createRealtimePacer(
  input: Readable,
  bytesPerSecond: number,
  playedMs: () => number,
  leadMs = PACER_LEAD_MS,
): Readable {
  const output = new PassThrough();
  // Errors are reported through the input stream's own listeners.
  output.on("error", () => {});
  let sentMs = 0;
  const allowedMs = (): number => {
    const played = playedMs();
    return played + (played > 0 ? leadMs : Math.max(leadMs, PACER_STARTUP_LEAD_MS));
  };

  void (async () => {
    try {
      for await (const chunk of input as AsyncIterable<Buffer>) {
        while (!output.destroyed && sentMs > allowedMs()) {
          await new Promise((resolve) => setTimeout(resolve, PACER_POLL_MS));
        }

        if (output.destroyed) {
          break;
        }

        sentMs += (chunk.length / bytesPerSecond) * 1000;
        if (!output.write(chunk)) {
          await once(output, "drain");
        }
      }

      output.end();
    } catch (pacerError) {
      output.destroy(pacerError instanceof Error ? pacerError : new Error(String(pacerError)));
    }
  })();

  return output;
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
 * Reads PCM from `input` (normally process.stdin) but discards everything until
 * start() is called, so audio that arrives while the bot is still connecting is
 * dropped instead of being played late.
 */
export function createSwitchingStdinStream(
  pcm: { inputFormat: InputFormat; sampleRate: number; channels: number },
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
  fasterThanRealtime?: boolean;
}): PreparedAudioSource {
  const output = new PassThrough();
  const stderrTail = new LineTail();
  let child: ChildProcess | undefined;
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
    fasterThanRealtime: options.fasterThanRealtime,
    start: (): void => {
      if (child || stopping) {
        return;
      }

      debug(`starting ${options.logPrefix} source: ${options.command} ${options.args.join(" ")}`);
      child = spawn(options.command, options.args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: options.shell,
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
      child.on("close", (code, signal) => {
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

      child.stdout?.unpipe(output);
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
