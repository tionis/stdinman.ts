import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { PassThrough, type Readable } from "node:stream";
import { LineTail } from "../ts/log.ts";
import {
  createCommandSource,
  createFfmpegOpusStream,
  createProcessAudioSource,
  pcmLayout,
  createSwitchingStdinStream,
  directShowCaptureArgs,
  ffmpegOpusArgs,
  formatDirectShowAudioInput,
} from "../ts/sources.ts";

const PCM_SPEC = { format: "s16le" as const, sampleRate: 48_000, channels: 2, waitingMessage: "waiting" };
const hasFfmpeg = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout?.includes("libopus");

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

describe("argument builders", () => {
  test("ffmpeg opus args include optional filters only when set", () => {
    const plain = ffmpegOpusArgs(PCM_SPEC, { volume: 1, opusBitrate: 0 }, false);
    expect(plain).not.toContain("-af");
    expect(plain).not.toContain("-b:a");
    expect(plain.slice(-3)).toEqual(["-f", "ogg", "pipe:1"]);

    const tuned = ffmpegOpusArgs(PCM_SPEC, { volume: 0.5, opusBitrate: 96 }, false);
    expect(tuned).toContain("volume=0.5");
    expect(tuned[tuned.indexOf("-b:a") + 1]).toBe("96k");
  });

  test("WAV input lets ffmpeg read the format from the header", () => {
    const args = ffmpegOpusArgs({ ...PCM_SPEC, format: "wav" }, { volume: 1, opusBitrate: 0 }, false);
    const input = args.slice(0, args.indexOf("pipe:0"));
    expect(input).toContain("wav");
    expect(input).toContain("-ignore_length");
    expect(input).not.toContain("-ar");
  });

  test("volume and custom filters share one filter chain", () => {
    const args = ffmpegOpusArgs(PCM_SPEC, { volume: 2, opusBitrate: 0, audioFilter: "bass=g=3" }, false);
    expect(args[args.indexOf("-af") + 1]).toBe("volume=2,bass=g=3");
    const onlyFilter = ffmpegOpusArgs(PCM_SPEC, { volume: 1, opusBitrate: 0, audioFilter: "loudnorm" }, false);
    expect(onlyFilter[onlyFilter.indexOf("-af") + 1]).toBe("loudnorm");
  });

  test("ffmpeg log level follows debug mode", () => {
    const args = ffmpegOpusArgs(PCM_SPEC, { volume: 1, opusBitrate: 0 }, true);
    expect(args[args.indexOf("-loglevel") + 1]).toBe("warning");
  });

  test("DirectShow input names", () => {
    expect(formatDirectShowAudioInput("Mic")).toBe("audio=Mic");
    expect(formatDirectShowAudioInput("audio=Mic")).toBe("audio=Mic");
    expect(formatDirectShowAudioInput("video=Cam:audio=Mic")).toBe("video=Cam:audio=Mic");
    expect(directShowCaptureArgs("Mic", false)).toContain("audio=Mic");
  });
});

test("PCM layouts", () => {
  expect(pcmLayout({ ...PCM_SPEC, format: "f32le", sampleRate: 44_100 })).toEqual({ bytesPerSecond: 44_100 * 8, frameBytes: 8 });
  expect(pcmLayout({ ...PCM_SPEC, channels: 1 })).toEqual({ bytesPerSecond: 48_000 * 2, frameBytes: 2 });
  expect(pcmLayout({ ...PCM_SPEC, format: "wav" })).toBe("wav");
});

describe("LineTail", () => {
  test("splits chunks into lines and keeps the tail", () => {
    const tail = new LineTail(2);
    expect(tail.push("one\ntw")).toEqual(["one"]);
    expect(tail.push("o\r\nthree\n")).toEqual(["two", "three"]);
    tail.push("partial");
    expect(tail.text()).toBe("two\nthree\npartial");
  });
});

describe("switching stdin stream", () => {
  test("drops input until started and ends with the input", async () => {
    const input = new PassThrough();
    const source = createSwitchingStdinStream({ inputFormat: "s16le", sampleRate: 48_000, channels: 2 }, input);
    expect(source.ffmpegInput.format).toBe("s16le");

    const output = collect(source.stream);
    input.write("early");
    await new Promise((resolve) => setImmediate(resolve));
    source.start();
    input.write("late");
    input.end();
    expect((await output).toString()).toBe("late");
  });

  test("stop detaches from the input", () => {
    const input = new PassThrough();
    const source = createSwitchingStdinStream({ inputFormat: "f32le", sampleRate: 48_000, channels: 2 }, input);
    source.stop();
    expect(input.listenerCount("data")).toBe(0);
  });
});

describe.skipIf(process.platform === "win32")("command source", () => {
  test("runs the command line through the shell", async () => {
    const source = createCommandSource({ command: "printf abc; printf def", inputFormat: "s16le", sampleRate: 22_050, channels: 1 });
    expect(source.ffmpegInput).toMatchObject({ format: "s16le", sampleRate: 22_050, channels: 1 });
    const output = collect(source.stream);
    source.start();
    // A clean exit ends the stream normally.
    expect((await output).toString()).toBe("abcdef");
  });
});

describe("process audio source", () => {
  const spec = { ...PCM_SPEC };
  const make = (script: string) =>
    createProcessAudioSource({
      command: process.execPath,
      args: ["-e", script],
      ffmpegInput: spec,
      startupMessage: "",
      startedMessage: "test source started",
      logPrefix: "test",
      awaitInitialPlayback: false,
    });

  test("forwards child stdout", async () => {
    const source = make("process.stdout.write('pcm'); setTimeout(() => {}, 10_000)");
    const output = collect(source.stream);
    source.start();
    await new Promise((resolve) => source.stream.once("data", resolve));
    source.stop();
    expect((await output).toString()).toBe("pcm");
  });

  test("unexpected exit is an error that includes stderr", async () => {
    const source = make("console.error('device busy'); process.exit(4)");
    source.start();
    const failure = await new Promise<Error>((resolve) => source.stream.once("error", resolve));
    expect(failure.message).toContain("code=4");
    expect(failure.message).toContain("device busy");
  });

  test("missing binaries are reported with a hint", async () => {
    const source = createProcessAudioSource({
      command: "stdinman-definitely-missing-binary",
      args: [],
      ffmpegInput: spec,
      startupMessage: "",
      startedMessage: "",
      logPrefix: "missing",
      awaitInitialPlayback: false,
    });
    source.start();
    const failure = await new Promise<Error>((resolve) => source.stream.once("error", resolve));
    expect(failure.message).toContain("installed and on PATH");
  });
});

describe.skipIf(!hasFfmpeg)("ffmpeg transcoder", () => {
  test("encodes raw PCM into Ogg Opus and exits cleanly at end of input", async () => {
    const input = new PassThrough();
    const transcoder = createFfmpegOpusStream("ffmpeg", input, PCM_SPEC, { volume: 0.8, opusBitrate: 64 });
    const errors: Error[] = [];
    transcoder.events.on("error", (transcodeError) => errors.push(transcodeError));

    const output = collect(transcoder.stream);
    // One second of a 440 Hz tone.
    const samples = Buffer.alloc(48_000 * 2 * 2);
    for (let i = 0; i < 48_000; i++) {
      const value = Math.round(Math.sin((2 * Math.PI * 440 * i) / 48_000) * 8_000);
      samples.writeInt16LE(value, i * 4);
      samples.writeInt16LE(value, i * 4 + 2);
    }
    input.end(samples);

    const ogg = await output;
    expect(ogg.subarray(0, 4).toString()).toBe("OggS");
    expect(ogg.includes(Buffer.from("OpusHead"))).toBe(true);
    // Short pages: roughly one per 20ms packet rather than one per second.
    const pages = ogg.toString("latin1").split("OggS").length - 1;
    expect(pages).toBeGreaterThan(20);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(errors).toEqual([]);
  });

  test("streams live input without waiting for more data", async () => {
    const input = new PassThrough();
    const transcoder = createFfmpegOpusStream("ffmpeg", input, PCM_SPEC, { volume: 1, opusBitrate: 0 });
    // 0.3 s of silence and the stream stays open, like a live capture.
    input.write(Buffer.alloc(48_000 * 4 * 0.3));
    const firstAudioPage = await new Promise<Buffer>((resolve, reject) => {
      let seen = Buffer.alloc(0);
      const timer = setTimeout(() => reject(new Error("no opus audio within 3s")), 3_000);
      transcoder.stream.on("data", (chunk: Buffer) => {
        seen = Buffer.concat([seen, chunk]);
        // Header pages are OpusHead and OpusTags; anything after them is audio.
        if (seen.toString("latin1").split("OggS").length - 1 > 2) {
          clearTimeout(timer);
          resolve(seen);
        }
      });
    });
    expect(firstAudioPage.length).toBeGreaterThan(0);
    transcoder.stop();
  });

  test("reads WAV input", async () => {
    const wav = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=duration=0.5", "-ar", "44100", "-ac", "1", "-f", "wav", "pipe:1"]);
    const input = new PassThrough();
    const transcoder = createFfmpegOpusStream("ffmpeg", input, { ...PCM_SPEC, format: "wav" }, { volume: 1, opusBitrate: 0 });
    const output = collect(transcoder.stream);
    input.end(wav.stdout);
    const ogg = await output;
    expect(ogg.toString("latin1").split("OggS").length - 1).toBeGreaterThan(20);
  });

  test("reports ffmpeg failures with stderr context", async () => {
    const crash = createFfmpegOpusStream("ffmpeg", new PassThrough(), { ...PCM_SPEC, sampleRate: -1 }, {
      volume: 1,
      opusBitrate: 0,
    });
    crash.stream.resume();
    const crashError = await new Promise<Error>((resolve) => crash.events.once("error", resolve));
    expect(crashError.message).toContain("ffmpeg exited unexpectedly");
    expect(crashError.message.split("\n").length).toBeGreaterThan(1);
  });

  test("missing ffmpeg binary is reported", async () => {
    const transcoder = createFfmpegOpusStream("stdinman-definitely-missing-binary", new PassThrough(), PCM_SPEC, {
      volume: 1,
      opusBitrate: 0,
    });
    const failure = await new Promise<Error>((resolve) => transcoder.events.once("error", resolve));
    expect(failure.message).toContain("installed and on PATH");
  });
});
