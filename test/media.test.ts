import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import {
  FfmpegMetadataParser,
  createMediaSource,
  expandHome,
  expandInputs,
  fallbackTitle,
  isUrl,
  mediaDecodeArgs,
} from "../ts/media.ts";

const hasFfmpeg = spawnSync("ffmpeg", ["-hide_banner", "-version"]).status === 0;

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

describe("inputs", () => {
  test("URL detection", () => {
    expect(isUrl("https://radio.example/stream")).toBe(true);
    expect(isUrl("rtmp://x/y")).toBe(true);
    expect(isUrl("C:\\music\\a.mp3")).toBe(false);
    expect(isUrl("song.mp3")).toBe(false);
  });

  test("expands directories into sorted audio files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stdinman-test-"));
    mkdirSync(join(dir, "cd2"));
    for (const name of ["10 ten.mp3", "2 two.flac", "cover.jpg", "cd2/1 one.ogg"]) {
      writeFileSync(join(dir, name), "");
    }

    expect(await expandInputs([dir, "https://example.com/live"])).toEqual([
      join(dir, "2 two.flac"),
      join(dir, "10 ten.mp3"),
      join(dir, "cd2", "1 one.ogg"),
      "https://example.com/live",
    ]);
  });

  test("home directory expansion", () => {
    expect(expandHome("~/Music", "/home/u")).toBe(join("/home/u", "Music"));
    expect(expandHome("~", "/home/u")).toBe("/home/u");
    expect(expandHome("a/~/b", "/home/u")).toBe("a/~/b");
  });

  test("missing files are reported", async () => {
    expect(expandInputs(["/definitely/missing.mp3"])).rejects.toThrow(/input not found/);
  });

  test("URLs get reconnect options", () => {
    expect(mediaDecodeArgs("https://x/y")).toContain("-reconnect");
    expect(mediaDecodeArgs("a.mp3")).not.toContain("-reconnect");
  });

  test("fallback titles", () => {
    expect(fallbackTitle("/music/Artist - Song.mp3")).toBe("Artist - Song");
    expect(fallbackTitle("https://radio.example/live.mp3?token=1")).toBe("radio.example/live.mp3");
  });
});

describe("FfmpegMetadataParser", () => {
  test("reads tags from the input header", () => {
    const parser = new FfmpegMetadataParser();
    const lines = [
      "Input #0, mp3, from 'song.mp3':",
      "Metadata:",
      "title           : Song",
      "artist          : Band",
      "Duration: 00:03:00.00, start: 0.000000, bitrate: 320 kb/s",
      "Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 320 kb/s",
      "Output #0, f32le, to 'pipe:1':",
      "title           : ignored",
    ];
    expect(lines.map((line) => parser.push(line))).toEqual([false, false, false, false, false, false, true, false]);
    expect(parser.title()).toBe("Song – Band");
  });

  test("prefers ICY stream titles, then station names", () => {
    const radio = new FfmpegMetadataParser();
    ["Input #0, mp3, from 'http://radio':", "icy-name        : Radio X", "StreamTitle     : Now - This"].forEach((line) =>
      radio.push(line),
    );
    expect(radio.title()).toBe("Now - This");

    const station = new FfmpegMetadataParser();
    ["Input #0, mp3, from 'http://radio':", "icy-name        : Radio X"].forEach((line) => station.push(line));
    expect(station.title()).toBe("Radio X");
  });
});

describe.skipIf(!hasFfmpeg)("media source", () => {
  const dir = mkdtempSync(join(tmpdir(), "stdinman-media-"));
  const tone = (name: string, title?: string) => {
    const path = join(dir, name);
    const args = ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=duration=0.5", "-ac", "2"];
    spawnSync("ffmpeg", [...args, ...(title ? ["-metadata", `title=${title}`] : []), "-y", path]);
    return path;
  };

  test("plays inputs in order, skips broken ones and reports titles", async () => {
    const first = tone("first.wav", "First Tone");
    const second = tone("second.flac");
    const broken = join(dir, "broken.mp3");
    writeFileSync(broken, "not audio");

    const source = createMediaSource({ ffmpegPath: "ffmpeg", inputs: [first, broken, second], loop: false });
    const titles: Array<string | null> = [];
    source.nowPlaying?.on("change", (title) => titles.push(title));
    const output = collect(source.stream);
    source.start();

    const pcm = await output;
    // Two half-second stereo f32 tones at 48 kHz.
    expect(pcm.length).toBe(2 * 0.5 * 48_000 * 2 * 4);
    expect(titles).toEqual(["First Tone", "second", null]);
  });

  test("fails when nothing can be played", async () => {
    const broken = join(dir, "broken2.mp3");
    writeFileSync(broken, "not audio");
    const source = createMediaSource({ ffmpegPath: "ffmpeg", inputs: [broken], loop: true });
    source.start();
    const failure = await new Promise<Error>((resolve) => source.stream.once("error", resolve));
    expect(failure.message).toContain("none of the inputs");
  });

  test("loops until stopped", async () => {
    const source = createMediaSource({ ffmpegPath: "ffmpeg", inputs: [tone("loop.wav", "Loop")], loop: true });
    const titles: Array<string | null> = [];
    source.stream.resume();
    source.start();
    await new Promise<void>((resolve) => {
      source.nowPlaying?.on("change", (title) => {
        titles.push(title);
        if (titles.length === 3) {
          resolve();
        }
      });
    });
    source.stop();
    expect(titles).toEqual(["Loop", "Loop", "Loop"]);
  });
});
