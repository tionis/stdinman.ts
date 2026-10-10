import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { spawnWithBackpressure } from "./fifo.ts";
import { LineTail, debug, info, warn } from "./log.ts";
import { CAPTURE_CHANNELS, CAPTURE_SAMPLE_RATE, type NowPlayingEvents, type PreparedAudioSource, rawPcmInput } from "./sources.ts";

const AUDIO_EXTENSIONS = new Set([
  ".aac",
  ".aif",
  ".aiff",
  ".alac",
  ".ape",
  ".flac",
  ".m4a",
  ".mka",
  ".mp2",
  ".mp3",
  ".mp4",
  ".mpc",
  ".oga",
  ".ogg",
  ".opus",
  ".wav",
  ".weba",
  ".webm",
  ".wma",
  ".wv",
]);

export function isUrl(input: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(input);
}

/** Expands a leading "~" (paths from the config file do not go through a shell). */
export function expandHome(path: string, home = homedir()): string {
  return path === "~" ? home : /^~[/\\]/.test(path) ? join(home, path.slice(2)) : path;
}

/** Expands directories into their audio files (recursively, in name order). URLs and files pass through. */
export async function expandInputs(inputs: string[]): Promise<string[]> {
  const expanded: string[] = [];
  for (const rawInput of inputs) {
    const input = isUrl(rawInput) ? rawInput : expandHome(rawInput);
    if (isUrl(input)) {
      expanded.push(input);
      continue;
    }

    let stats;
    try {
      stats = await stat(input);
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`input not found: ${input}`);
      }

      throw statError;
    }

    if (stats.isDirectory()) {
      expanded.push(...(await listAudioFiles(input)));
    } else {
      expanded.push(input);
    }
  }

  return expanded;
}

async function listAudioFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));

  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listAudioFiles(path)));
    } else if (AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      files.push(path);
    }
  }

  return files;
}

export function mediaDecodeArgs(input: string): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    "-nostats",
    // "info" is needed for the input metadata dump used for now-playing titles.
    "-loglevel",
    "info",
    ...(isUrl(input) ? ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "10"] : []),
    "-i",
    input,
    "-map",
    "0:a:0",
    "-vn",
    "-sn",
    "-dn",
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

export function fallbackTitle(input: string): string {
  if (isUrl(input)) {
    try {
      const url = new URL(input);
      return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
    } catch {
      return input;
    }
  }

  const name = basename(input);
  const extension = extname(name);
  return extension ? name.slice(0, -extension.length) : name;
}

/** Collects input metadata from ffmpeg's stderr header dump. */
export class FfmpegMetadataParser {
  private inInput = false;
  private done = false;
  private readonly tags = new Map<string, string>();

  /** Feeds one stderr line; returns true once the header dump is complete. */
  push(line: string): boolean {
    if (this.done) {
      return false;
    }

    if (/^Input #0\b/.test(line)) {
      this.inInput = true;
      return false;
    }

    if (this.inInput && (/^Stream mapping:/.test(line) || /^Output #0\b/.test(line))) {
      this.done = true;
      return true;
    }

    if (this.inInput) {
      const match = line.match(/^([A-Za-z][\w-]*)\s*:\s(.*)$/);
      if (match) {
        const key = match[1].toLowerCase();
        if (!this.tags.has(key)) {
          this.tags.set(key, match[2].trim());
        }
      }
    }

    return false;
  }

  title(): string | undefined {
    const streamTitle = this.tags.get("streamtitle");
    if (streamTitle) {
      return streamTitle;
    }

    const title = this.tags.get("title");
    const artist = this.tags.get("artist") ?? this.tags.get("album_artist");
    if (title) {
      return artist ? `${title} – ${artist}` : title;
    }

    return this.tags.get("icy-name") || undefined;
  }
}

/**
 * Decodes each input with its own ffmpeg process and concatenates the PCM,
 * so a playlist plays through a single transcoder and voice resource.
 */
export function createMediaSource(options: { ffmpegPath: string; inputs: string[]; loop: boolean }): PreparedAudioSource {
  const output = new PassThrough();
  const nowPlaying = new EventEmitter<NowPlayingEvents>();
  let child: ChildProcess | undefined;
  let childStdout: Readable | undefined;
  let started = false;
  let stopping = false;
  let index = 0;
  let succeededThisRound = false;

  const finish = (failure?: Error): void => {
    nowPlaying.emit("change", null);
    if (failure) {
      output.destroy(failure);
    } else {
      output.end();
    }
  };

  const playNext = (): void => {
    if (stopping) {
      return;
    }

    if (index >= options.inputs.length) {
      if (!succeededThisRound) {
        finish(new Error("none of the inputs could be played"));
        return;
      }

      if (!options.loop) {
        info("reached the end of the inputs");
        finish();
        return;
      }

      index = 0;
      succeededThisRound = false;
    }

    const input = options.inputs[index++];
    const args = mediaDecodeArgs(input);
    const metadata = new FfmpegMetadataParser();
    const stderrTail = new LineTail();
    let reportedTitle = false;
    const reportTitle = (): void => {
      if (!reportedTitle) {
        reportedTitle = true;
        const title = metadata.title() ?? fallbackTitle(input);
        info(`now playing: ${title}`);
        nowPlaying.emit("change", title);
      }
    };

    debug(`starting media decoder: ${options.ffmpegPath} ${args.join(" ")}`);
    const spawned = spawnWithBackpressure(options.ffmpegPath, args, { windowsHide: true });
    const current = spawned.child;
    child = current;
    childStdout = spawned.stdout;

    spawned.stdout.pipe(output, { end: false });
    spawned.stdout.once("data", reportTitle);
    current.stderr!.setEncoding("utf8");
    current.stderr!.on("data", (chunk: string) => {
      for (const line of stderrTail.push(chunk)) {
        debug(`[ffmpeg-media] ${line}`);
        if (metadata.push(line)) {
          reportTitle();
        }
      }
    });

    let failedToSpawn = false;
    current.on("error", (spawnError: NodeJS.ErrnoException) => {
      failedToSpawn = true;
      const hint = spawnError.code === "ENOENT" ? ` (is "${options.ffmpegPath}" installed and on PATH?)` : "";
      finish(new Error(`failed to start ffmpeg media decoder (${options.ffmpegPath}): ${spawnError.message}${hint}`));
    });

    spawned.onClose((code, signal) => {
      spawned.stdout.unpipe(output);
      if (stopping || failedToSpawn) {
        return;
      }

      if (code === 0) {
        succeededThisRound = true;
      } else {
        const tail = stderrTail.text().split("\n").slice(-3).join("\n");
        warn(`failed to play ${input} (code=${code ?? "null"} signal=${signal ?? "null"})${tail ? `\n${tail}` : ""}`);
      }

      playNext();
    });
  };

  return {
    stream: output,
    ffmpegInput: rawPcmInput("f32le", "ffmpeg is still waiting for decoded media. Check that the inputs are reachable."),
    nowPlaying,
    start: (): void => {
      if (started || stopping) {
        return;
      }

      started = true;
      playNext();
    },
    stop: (): void => {
      if (stopping) {
        return;
      }

      stopping = true;
      output.end();
      childStdout?.unpipe(output);
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
    },
    pauseWhenUnheard: true,
    pacing: "wait",
    activity: "running",
    continuous: false,
    startupMessage: `playing ${options.inputs.length} input${options.inputs.length === 1 ? "" : "s"}${options.loop ? " on loop" : ""}`,
    awaitInitialPlayback: false,
  };
}
