import { describe, expect, test } from "bun:test";
import { PassThrough, Readable } from "node:stream";
import { applyGain, createPacer, parseWavHeader, peakLevel } from "../ts/pacer.ts";

// 1 byte = 1 ms of audio, with 2-byte frames.
const LAYOUT = { bytesPerSecond: 1_000, frameBytes: 2, sample: "unknown" as const };
const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
const chunks = (count: number, size: number) =>
  Readable.from(Array.from({ length: count }, () => Buffer.alloc(size)), { objectMode: false });

function counter(stream: Readable) {
  const state = { bytes: 0, data: [] as Buffer[] };
  stream.on("data", (chunk: Buffer) => {
    state.bytes += chunk.length;
    state.data.push(chunk);
  });
  return state;
}

function wavHeader(byteRate: number, blockAlign: number, extraChunk = false): Buffer {
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0, "ascii");
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(3, 8); // IEEE float
  fmt.writeUInt16LE(2, 10);
  fmt.writeUInt32LE(byteRate / blockAlign, 12);
  fmt.writeUInt32LE(byteRate, 16);
  fmt.writeUInt16LE(blockAlign, 20);
  fmt.writeUInt16LE(32, 22);
  const list = Buffer.from("LIST\u0003\u0000\u0000\u0000abc\u0000", "latin1");
  const data = Buffer.from("data\xff\xff\xff\xff", "latin1");
  return Buffer.concat([Buffer.from("RIFF\xff\xff\xff\xffWAVE", "latin1"), fmt, ...(extraChunk ? [list] : []), data]);
}

describe("wait mode", () => {
  test("releases audio only as far ahead of playback as the lead allows", async () => {
    let played = 0;
    const out = counter(createPacer(chunks(100, 100), { mode: "wait", layout: LAYOUT, playedMs: () => played, leadMs: 250 }));

    // Before playback starts, a larger startup lead applies.
    await settle();
    expect(out.bytes).toBeGreaterThanOrEqual(1_000);
    expect(out.bytes).toBeLessThanOrEqual(1_100);

    played = 2_000;
    await settle();
    expect(out.bytes).toBeGreaterThanOrEqual(2_250);
    expect(out.bytes).toBeLessThanOrEqual(2_350);

    // Paused playback holds the producer back instead of buffering.
    await settle();
    expect(out.bytes).toBeLessThanOrEqual(2_350);

    played = 20_000;
    await settle(150);
    expect(out.bytes).toBe(10_000);
  });

  test("stops reading when the output is destroyed", async () => {
    const input = chunks(100, 100);
    const output = createPacer(input, { mode: "wait", layout: LAYOUT, playedMs: () => 0 });
    output.resume();
    await settle();
    output.destroy();
    await settle();
    expect(input.readableEnded).toBe(false);
  });
});

describe("drop mode", () => {
  test("never waits while audio is within bounds", async () => {
    let played = 0;
    const input = new PassThrough();
    const drops: number[] = [];
    const out = counter(
      createPacer(input, { mode: "drop", layout: LAYOUT, playedMs: () => played, leadMs: 250, maxAheadMs: 400, onDrop: (ms) => drops.push(ms) }),
    );
    played = 1;
    for (let i = 0; i < 10; i++) {
      input.write(Buffer.alloc(30));
    }
    await settle(20);
    expect(out.bytes).toBe(300);
    expect(drops).toEqual([]);
  });

  test("drops whole frames down to the lead once too far ahead", async () => {
    let played = 1;
    const input = new PassThrough();
    const drops: number[] = [];
    const out = counter(
      createPacer(input, { mode: "drop", layout: LAYOUT, playedMs: () => played, leadMs: 250, maxAheadMs: 400, onDrop: (ms) => drops.push(ms) }),
    );

    const feed = async (count: number, size: number) => {
      for (let i = 0; i < count; i++) {
        input.write(Buffer.alloc(size, i % 256));
        await settle(1);
      }
    };

    // 450 ms buffered against 1 ms played: the chunk that crosses 400 ms ahead gets dropped.
    await feed(15, 30);
    const kept = out.bytes;
    expect(kept).toBeLessThan(450);
    // Odd-sized chunks are cut to whole frames: one byte per dropped chunk is kept.
    await feed(3, 31);
    expect(out.bytes - kept).toBe(3);

    // Playback catches up: once within the lead, audio flows again and the drop is reported.
    played = 300;
    await feed(1, 30);
    expect(out.bytes - kept).toBe(33);
    expect(drops).toHaveLength(1);
    expect(drops[0]).toBeGreaterThan(0);
    // Only whole 2-byte frames were dropped, so the rest of the stream stays sample aligned.
    const fed = 15 * 30 + 3 * 31 + 30;
    expect((fed - out.bytes) % 2).toBe(0);
  });
});

describe("jitter cushion", () => {
  test("holds live audio until the cushion is filled, then refills when the queue runs dry", async () => {
    let played = 0;
    const input = new PassThrough();
    const out = counter(createPacer(input, { mode: "drop", layout: LAYOUT, playedMs: () => played, leadMs: 250, cushionMs: 150 }));

    for (let i = 0; i < 4; i++) {
      input.write(Buffer.alloc(30));
    }
    await settle(20);
    expect(out.bytes).toBe(0); // 120 ms held, below the 150 ms cushion

    input.write(Buffer.alloc(30));
    await settle(20);
    expect(out.bytes).toBe(150); // cushion reached: everything flows

    played = 140; // 10 ms left queued: nearly dry
    input.write(Buffer.alloc(30));
    await settle(20);
    expect(out.bytes).toBe(150); // held to rebuild the cushion
    input.write(Buffer.alloc(120));
    await settle(20);
    expect(out.bytes).toBe(300);
  });
});

describe("WAV input", () => {
  test("parses headers with extra chunks", () => {
    expect(parseWavHeader(wavHeader(384_000, 8))).toEqual({
      headerBytes: 44,
      layout: { bytesPerSecond: 384_000, frameBytes: 8, sample: "f32" },
    });
    expect(parseWavHeader(wavHeader(384_000, 8, true))?.headerBytes).toBe(56);
    expect(parseWavHeader(wavHeader(384_000, 8).subarray(0, 30))).toBeUndefined();
    expect(() => parseWavHeader(Buffer.from("not a wav file at all"))).toThrow(/RIFF/);
  });

  test("passes the header through and paces the samples", async () => {
    const header = wavHeader(1_000, 2);
    const input = new PassThrough();
    const out = counter(createPacer(input, { mode: "wait", layout: "wav", playedMs: () => 0, leadMs: 250 }));
    // The header arrives split across chunks.
    input.write(header.subarray(0, 20));
    input.write(Buffer.concat([header.subarray(20), Buffer.alloc(3_000)]));
    await settle();
    expect(Buffer.concat(out.data).subarray(0, header.length).equals(header)).toBe(true);
    // Startup lead of 1 s at 1000 bytes/s, plus the header.
    expect(out.bytes).toBe(header.length + 3_000);
    input.write(Buffer.alloc(1_000));
    await settle();
    expect(out.bytes).toBe(header.length + 3_000);
  });

  test("passes non-WAV data through unpaced with a warning", async () => {
    const input = new PassThrough();
    const reasons: string[] = [];
    const out = counter(
      createPacer(input, { mode: "drop", layout: "wav", playedMs: () => 0, onUnpaced: (reason) => reasons.push(reason) }),
    );
    input.write(Buffer.from("definitely not a wav header"));
    await settle();
    expect(out.bytes).toBe(27);
    expect(reasons[0]).toMatch(/RIFF/);
  });
});

describe("gain and levels", () => {
  const f32 = (...values: number[]) => {
    const buffer = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
    return buffer;
  };
  const s16 = (...values: number[]) => {
    const buffer = Buffer.alloc(values.length * 2);
    values.forEach((value, index) => buffer.writeInt16LE(value, index * 2));
    return buffer;
  };

  test("peak levels per sample format", () => {
    expect(peakLevel(f32(0.1, -0.5, 0.25), "f32")).toBeCloseTo(0.5);
    expect(peakLevel(s16(1_000, -16_384), "s16")).toBeCloseTo(0.5);
    expect(peakLevel(Buffer.from([0x00, 0x00, 0x40]), "s24")).toBeCloseTo(0.5);
  });

  test("gain scales samples and clips integers", () => {
    const louder = applyGain(f32(0.25, -0.5), "f32", 2);
    expect(louder.readFloatLE(0)).toBeCloseTo(0.5);
    expect(louder.readFloatLE(4)).toBeCloseTo(-1);
    const clipped = applyGain(s16(20_000, -20_000), "s16", 2);
    expect(clipped.readInt16LE(0)).toBe(32_767);
    expect(clipped.readInt16LE(2)).toBe(-32_768);
    const original = s16(100);
    expect(applyGain(original, "s16", 1)).toBe(original);
  });

  test("the pacer applies a changing gain to whole samples across chunk boundaries", async () => {
    let gain = 2;
    const input = new PassThrough();
    const levels: number[] = [];
    const out = counter(
      createPacer(input, {
        mode: "drop",
        layout: { bytesPerSecond: 4_000, frameBytes: 4, sample: "s16" },
        playedMs: () => 1,
        cushionMs: 0,
        gain: () => gain,
        onLevel: (peak) => levels.push(peak),
      }),
    );
    const samples = s16(1_000, 2_000, 3_000, 4_000);
    // Split in the middle of a sample.
    input.write(samples.subarray(0, 3));
    input.write(samples.subarray(3, 6));
    await settle(20);
    gain = 0.5;
    input.write(samples.subarray(6));
    await settle(20);
    const result = Buffer.concat(out.data);
    expect([0, 2, 4, 6].map((offset) => result.readInt16LE(offset))).toEqual([2_000, 4_000, 6_000, 2_000]);
    expect(levels.length).toBeGreaterThan(0);
  });

  test("WAV sample formats", () => {
    const pcm16 = wavHeader(192_000, 4);
    pcm16.writeUInt16LE(1, 20);
    pcm16.writeUInt16LE(16, 34);
    expect(parseWavHeader(pcm16)?.layout.sample).toBe("s16");
    const unknown = wavHeader(192_000, 4);
    unknown.writeUInt16LE(2, 20); // ADPCM
    expect(parseWavHeader(unknown)?.layout.sample).toBe("unknown");
  });
});
