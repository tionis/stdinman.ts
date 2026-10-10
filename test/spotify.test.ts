import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NowPlayingEvents } from "../ts/sources.ts";
import {
  SpotifyNowPlayingTracker,
  formatLibrespotName,
  formatTrackTitle,
  librespotArgs,
  librespotLogLevel,
  validateLibrespotArgs,
  onEventScript,
  parseLibrespotEventLine,
} from "../ts/spotify.ts";

const SEP = "\u001f";

describe("librespot args", () => {
  test("adds the event hook only when given", () => {
    const base = { librespotName: "dev", librespotBitrate: 320, librespotArgs: ["--x"] };
    expect(librespotArgs(base)).not.toContain("--onevent");
    const withHook = librespotArgs({ ...base, onEventPath: "/tmp/hook.sh" });
    expect(withHook[withHook.indexOf("--onevent") + 1]).toBe("/tmp/hook.sh");
    expect(withHook.at(-1)).toBe("--x");
  });

  test("full initial volume and float output", () => {
    const args = librespotArgs({ librespotName: "dev", librespotBitrate: 160, librespotArgs: [] });
    expect(args).toEqual(["-n", "dev", "--backend", "pipe", "--format", "F32", "-b", "160", "--initial-volume", "100"]);
  });

  test("a user supplied initial volume wins", () => {
    for (const userArgs of [["-R", "40"], ["--initial-volume", "40"], ["--initial-volume=40"]]) {
      const args = librespotArgs({ librespotName: "dev", librespotBitrate: 320, librespotArgs: userArgs });
      expect(args.filter((arg) => arg === "100")).toEqual([]);
    }
  });

  test("options stdinman manages are rejected", () => {
    expect(() => validateLibrespotArgs(["--format", "S16"])).toThrow(/managed by stdinman/);
    expect(() => validateLibrespotArgs(["-n", "x"])).toThrow(/--librespot-name/);
    expect(() => validateLibrespotArgs(["--bitrate=160"])).toThrow(/--librespot-bitrate/);
    expect(() => validateLibrespotArgs(["--backend", "alsa"])).toThrow(/managed/);
    expect(() => validateLibrespotArgs(["--initial-volume", "80", "--volume-ctrl", "fixed"])).not.toThrow();
  });
});

test("device name template", () => {
  expect(formatLibrespotName("discord: {bot}", "Music Bot")).toBe("discord: Music Bot");
  expect(formatLibrespotName("{bot} ({bot})", "A")).toBe("A (A)");
  expect(formatLibrespotName("living room", "A")).toBe("living room");
  expect(formatLibrespotName("  ", "A")).toBe("A");
  expect(formatLibrespotName("{bot}", "x".repeat(100))).toHaveLength(63);
  // Truncation counts UTF-8 bytes and never splits a character.
  expect(Buffer.byteLength(formatLibrespotName("{bot}", "é".repeat(40)))).toBe(62);
});

test("librespot log levels", () => {
  expect(librespotLogLevel("[2026-10-10T14:22:59Z WARN  libmdns::fsm] error sending packet")).toBe("WARN");
  expect(librespotLogLevel("[2026-10-10T14:22:59Z ERROR librespot_core::session] connection lost")).toBe("ERROR");
  expect(librespotLogLevel("[2026-10-10T14:22:59Z INFO  librespot] librespot 0.8.0")).toBe("INFO");
  expect(librespotLogLevel("plain text")).toBeUndefined();
});

describe("event parsing", () => {
  test("parses track events with several artists", () => {
    const event = parseLibrespotEventLine(
      ["STDINMAN_EVENT", "track_changed", "Song", "Artist A", "Artist B", "Album", ""].join(SEP),
    );
    expect(event).toEqual({ event: "track_changed", name: "Song", artists: ["Artist A", "Artist B"], album: "Album", showName: "" });
    expect(formatTrackTitle(event!)).toBe("Song – Artist A, Artist B");
  });

  test("episodes use the show name", () => {
    const event = parseLibrespotEventLine(["STDINMAN_EVENT", "track_changed", "Episode 1", "", "", "The Show"].join(SEP));
    expect(formatTrackTitle(event!)).toBe("Episode 1 – The Show");
  });

  test("ignores other stderr lines", () => {
    expect(parseLibrespotEventLine("[2026] INFO librespot connected")).toBeUndefined();
  });

  test("tracker emits titles on play and clears on pause", () => {
    const emitter = new EventEmitter<NowPlayingEvents>();
    const titles: Array<string | null> = [];
    emitter.on("change", (title) => titles.push(title));
    const tracker = new SpotifyNowPlayingTracker(emitter);
    const event = (name: string, title = "") => ({ event: name, name: title, artists: ["A"], album: "", showName: "" });
    tracker.handle(event("track_changed", "Song"));
    tracker.handle(event("playing"));
    tracker.handle(event("paused"));
    tracker.handle(event("volume_changed"));
    tracker.handle(event("playing"));
    expect(titles).toEqual(["Song – A", "Song – A", null, "Song – A"]);
  });
});

describe.skipIf(process.platform === "win32")("onevent hook script", () => {
  test("reports librespot's environment on one stderr line", () => {
    const dir = mkdtempSync(join(tmpdir(), "stdinman-test-"));
    const script = join(dir, "hook.sh");
    writeFileSync(script, onEventScript("linux"));
    chmodSync(script, 0o700);

    const result = spawnSync(script, [], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, PLAYER_EVENT: "track_changed", NAME: "Wish & Hope", ARTISTS: "One\nTwo", ALBUM: "Al" },
    });
    expect(result.stdout).toBe("");
    const event = parseLibrespotEventLine(result.stderr.trim());
    expect(event).toEqual({ event: "track_changed", name: "Wish & Hope", artists: ["One", "Two"], album: "Al", showName: "" });
  });
});

test("windows hook script uses delayed expansion and CRLF", () => {
  const script = onEventScript("win32");
  expect(script).toContain("EnableDelayedExpansion");
  expect(script).toContain("!NAME!");
  expect(script).toContain("\r\n");
});
