import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { debug, warn } from "./log.ts";
import { type NowPlayingEvents, type PreparedAudioSource, createProcessAudioSource } from "./sources.ts";

const EVENT_MARKER = "STDINMAN_EVENT";
const FIELD_SEPARATOR = "\u001f";

/** The device name is announced over mDNS, whose instance names are limited to 63 bytes. */
const DEVICE_NAME_MAX_BYTES = 63;

/** Fills the `{bot}` placeholder in the configured Spotify Connect device name. */
export function formatLibrespotName(template: string, botName: string): string {
  let name = "";
  for (const char of template.replaceAll("{bot}", botName).trim() || botName) {
    if (Buffer.byteLength(name + char) > DEVICE_NAME_MAX_BYTES) {
      break;
    }
    name += char;
  }

  return name;
}

function usesOption(args: string[], short: string, long: string): boolean {
  return args.some((arg) => arg === `-${short}` || arg === `--${long}` || arg.startsWith(`--${long}=`));
}

/** librespot options stdinman sets itself; passing them again makes librespot fail on the duplicate. */
const MANAGED_OPTIONS = [
  { short: "n", long: "name", use: "--librespot-name" },
  { short: "B", long: "backend", use: "" },
  { short: "b", long: "bitrate", use: "--librespot-bitrate" },
  { short: "f", long: "format", use: "" },
] as const;

/** Throws if extra librespot arguments clash with options stdinman passes itself. */
export function validateLibrespotArgs(args: string[]): void {
  for (const option of MANAGED_OPTIONS) {
    if (usesOption(args, option.short, option.long)) {
      throw new Error(
        `--librespot-arg ${args.find((arg) => arg === `-${option.short}` || arg.startsWith(`--${option.long}`))} is managed by stdinman${option.use ? `; use ${option.use} instead` : ""}`,
      );
    }
  }
}

export function librespotArgs(options: {
  librespotName: string;
  librespotBitrate: number;
  librespotArgs: string[];
  onEventPath?: string;
}): string[] {
  return [
    "-n",
    options.librespotName,
    "--backend",
    "pipe",
    // Float output keeps full resolution when Spotify's volume slider attenuates the signal;
    // the default S16 output loses bits (and adds dither noise) at lower volumes.
    "--format",
    "F32",
    "-b",
    String(options.librespotBitrate),
    // librespot starts at 50%, which its log volume curve maps to -30 dB. Start at full volume;
    // the Spotify app's volume slider still works.
    ...(usesOption(options.librespotArgs, "R", "initial-volume") ? [] : ["--initial-volume", "100"]),
    ...(options.onEventPath ? ["--onevent", options.onEventPath] : []),
    ...options.librespotArgs,
  ];
}

function userSetsOnEvent(args: string[]): boolean {
  return usesOption(args, "o", "onevent");
}

/**
 * librespot runs the --onevent program with track details in environment
 * variables and inherits its stdio. stdout carries the audio, so the hook
 * reports events on stderr, where createProcessAudioSource reads them.
 */
export function onEventScript(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    // Delayed expansion keeps characters like & and | in track names from being interpreted.
    return [
      "@echo off",
      "setlocal EnableDelayedExpansion",
      `echo ${EVENT_MARKER}${FIELD_SEPARATOR}!PLAYER_EVENT!${FIELD_SEPARATOR}!NAME!${FIELD_SEPARATOR}!ARTISTS!${FIELD_SEPARATOR}!ALBUM!${FIELD_SEPARATOR}!SHOW_NAME! 1>&2`,
      "",
    ].join("\r\n");
  }

  // ARTISTS is newline separated; flatten it so each event stays on one line.
  return `#!/bin/sh
artists=$(printf '%s' "$ARTISTS" | tr '\\n' '\\037')
printf '${EVENT_MARKER}\\037%s\\037%s\\037%s\\037%s\\037%s\\n' "$PLAYER_EVENT" "$NAME" "$artists" "$ALBUM" "$SHOW_NAME" >&2
`;
}

export type LibrespotEvent = {
  event: string;
  name: string;
  artists: string[];
  album: string;
  showName: string;
};

/** Extracts the level from a librespot log line like "[2026-10-10T14:22:59Z WARN  libmdns::fsm] ...". */
export function librespotLogLevel(line: string): string | undefined {
  return line.match(/^\[\S+\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s/)?.[1];
}

export function parseLibrespotEventLine(line: string): LibrespotEvent | undefined {
  if (!line.startsWith(EVENT_MARKER + FIELD_SEPARATOR)) {
    return undefined;
  }

  const [, event = "", name = "", ...rest] = line.split(FIELD_SEPARATOR);
  // The artist list may itself contain separators; album and show name are always the last two fields.
  const showName = rest.length >= 3 ? (rest.pop() ?? "") : "";
  const album = rest.length >= 2 ? (rest.pop() ?? "") : "";
  const artists = rest.map((artist) => artist.trim()).filter(Boolean);
  return { event: event.trim(), name: name.trim(), artists, album: album.trim(), showName: showName.trim() };
}

export function formatTrackTitle(event: LibrespotEvent): string | null {
  if (!event.name) {
    return null;
  }

  const by = event.artists.length > 0 ? event.artists.join(", ") : event.showName;
  return by ? `${event.name} – ${by}` : event.name;
}

/** Turns the librespot event stream into now-playing titles. */
export class SpotifyNowPlayingTracker {
  private currentTitle: string | null = null;

  constructor(private readonly emitter: EventEmitter<NowPlayingEvents>) {}

  handle(event: LibrespotEvent): void {
    switch (event.event) {
      case "track_changed":
        this.currentTitle = formatTrackTitle(event);
        this.emitter.emit("change", this.currentTitle);
        return;
      case "playing":
        this.emitter.emit("change", this.currentTitle);
        return;
      case "paused":
      case "stopped":
      case "session_disconnected":
        this.emitter.emit("change", null);
        return;
      default:
        return;
    }
  }
}

function writeOnEventScript(): { path: string; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "stdinman-"));
  const path = join(dir, process.platform === "win32" ? "onevent.cmd" : "onevent.sh");
  writeFileSync(path, onEventScript(), { mode: 0o700 });
  return {
    path,
    remove: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (removeError) {
        debug(`failed to remove ${dir}: ${String(removeError)}`);
      }
    },
  };
}

export function createSpotifySource(options: {
  librespotPath: string;
  librespotName: string;
  librespotBitrate: number;
  librespotArgs: string[];
  nowPlaying: boolean;
}): PreparedAudioSource {
  validateLibrespotArgs(options.librespotArgs);
  const trackEvents = options.nowPlaying && !userSetsOnEvent(options.librespotArgs);
  const hook = trackEvents ? writeOnEventScript() : undefined;
  const nowPlaying = new EventEmitter<NowPlayingEvents>();
  const tracker = new SpotifyNowPlayingTracker(nowPlaying);
  const seenWarnings = new Set<string>();

  return createProcessAudioSource({
    command: options.librespotPath,
    args: librespotArgs({ ...options, onEventPath: hook?.path }),
    ffmpegInput: {
      format: "f32le",
      sampleRate: 44_100,
      channels: 2,
      waitingMessage: `ffmpeg is still waiting for Spotify audio. Start playback on the Spotify Connect device "${options.librespotName}" if you have not already.`,
    },
    fasterThanRealtime: true,
    startupMessage: `starting librespot and waiting for Spotify playback on device "${options.librespotName}"`,
    startedMessage: `librespot started; waiting for Spotify playback on device "${options.librespotName}"`,
    logPrefix: "librespot",
    awaitInitialPlayback: false,
    onStderrLine: (line) => {
      const event = parseLibrespotEventLine(line);
      if (!event) {
        const level = librespotLogLevel(line);
        if (level !== "WARN" && level !== "ERROR") {
          return false;
        }

        // Show each distinct warning once; some (e.g. mDNS send errors) repeat constantly.
        const message = line.replace(/^\[\S+\s+/, "");
        // Expected: stdinman deliberately reads audio only as fast as it is played.
        if (/Throughput .* lower than minimum/.test(message) || seenWarnings.has(message)) {
          return false;
        }

        seenWarnings.add(message);
        warn(`[librespot] ${message}`);
        return true;
      }

      debug(`[librespot] event ${event.event}${event.name ? `: ${event.name}` : ""}`);
      tracker.handle(event);
      return true;
    },
    nowPlaying: trackEvents ? nowPlaying : undefined,
    cleanup: hook?.remove,
  });
}
