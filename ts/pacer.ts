import { once } from "node:events";
import { PassThrough, type Readable } from "node:stream";

/**
 * - "wait": hold the input back (for sources that can run faster than real time).
 * - "drop": never wait; drop audio when it runs too far ahead (for live capture,
 *   whose device clock drifts against the clock that paces Discord playback).
 */
export type PacingMode = "wait" | "drop";

export type PcmLayout = {
  bytesPerSecond: number;
  /** Bytes per sample frame (all channels); drops happen in whole frames. */
  frameBytes: number;
};

export type PacerOptions = {
  mode: PacingMode;
  /** Real audio played so far, in milliseconds. */
  playedMs: () => number;
  /** Raw PCM layout, or "wav" to read it from the stream's WAV header. */
  layout: PcmLayout | "wav";
  /** How far ahead of playback audio may run. */
  leadMs?: number;
  /** "drop" mode: start dropping once this far ahead, then drop back down to the lead. */
  maxAheadMs?: number;
  /**
   * "drop" mode: jitter buffer. Live audio arrives just in time, so any timing jitter makes the
   * player miss frames (audible gaps). Audio is held back until this much is queued, at startup
   * and whenever the queue runs nearly dry.
   */
  cushionMs?: number;
  /** "drop" mode: called with the milliseconds of audio dropped in one go. */
  onDrop?: (droppedMs: number) => void;
  /** Called if a WAV header cannot be parsed; the audio then passes through unpaced. */
  onUnpaced?: (reason: string) => void;
};

export const PACER_LEAD_MS = 250;
export const PACER_MAX_AHEAD_MS = 400;
export const PACER_CUSHION_MS = 150;
/** Below this much queued audio the jitter buffer refills (the encoder itself holds some). */
const PACER_CUSHION_LOW_MS = 40;
/** Until playback starts, ffmpeg needs a little more input before it emits its first packets. */
const PACER_STARTUP_LEAD_MS = 1_000;
const PACER_POLL_MS = 10;
const WAV_HEADER_LIMIT_BYTES = 64 * 1024;

export type WavHeader = { headerBytes: number; layout: PcmLayout };

/**
 * Parses a RIFF/WAVE header. Returns undefined while more bytes are needed and
 * throws if the data is not a WAV stream.
 */
export function parseWavHeader(buffer: Buffer): WavHeader | undefined {
  if (buffer.length < 12) {
    return undefined;
  }

  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("input does not start with a RIFF/WAVE header");
  }

  let offset = 12;
  let layout: PcmLayout | undefined;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === "data") {
      if (!layout) {
        throw new Error("WAV data chunk before fmt chunk");
      }

      return { headerBytes: body, layout };
    }

    if (body + size > buffer.length) {
      return undefined;
    }

    if (id === "fmt ") {
      const byteRate = buffer.readUInt32LE(body + 8);
      const blockAlign = buffer.readUInt16LE(body + 12);
      if (byteRate === 0 || blockAlign === 0) {
        throw new Error("WAV fmt chunk has no byte rate");
      }

      layout = { bytesPerSecond: byteRate, frameBytes: blockAlign };
    }

    // Chunks are padded to an even size.
    offset = body + size + (size % 2);
  }

  if (buffer.length > WAV_HEADER_LIMIT_BYTES) {
    throw new Error("no WAV data chunk in the first 64 KiB");
  }

  return undefined;
}

/**
 * Releases audio in step with playback: at most `leadMs` ahead of `playedMs()`,
 * the amount of real audio the consumer has played. Following the playback
 * position (rather than the wall clock) also absorbs encoder startup,
 * reconnects and paused playback without building up delay.
 */
export function createPacer(input: Readable, options: PacerOptions): Readable {
  const leadMs = options.leadMs ?? PACER_LEAD_MS;
  const maxAheadMs = Math.max(options.maxAheadMs ?? PACER_MAX_AHEAD_MS, leadMs);
  const output = new PassThrough();
  // Errors are reported through the input stream's own listeners.
  output.on("error", () => {});

  let layout = options.layout === "wav" ? undefined : options.layout;
  let header: Buffer | undefined = options.layout === "wav" ? Buffer.alloc(0) : undefined;
  let unpaced = false;
  let sentMs = 0;
  let dropping = false;
  let droppedMs = 0;
  const cushionMs = Math.min(options.cushionMs ?? PACER_CUSHION_MS, leadMs);
  // Jitter buffer for "drop" mode: chunks held back while (re)filling the cushion.
  let held: Buffer[] | undefined = options.mode === "drop" && cushionMs > 0 ? [] : undefined;
  let heldMs = 0;

  const startupAllowance = (played: number): number => (played > 0 ? 0 : PACER_STARTUP_LEAD_MS);

  const write = async (data: Buffer): Promise<void> => {
    if (data.length > 0 && !output.write(data)) {
      await once(output, "drain");
    }
  };

  const reportDrop = (): void => {
    if (droppedMs > 0) {
      options.onDrop?.(droppedMs);
      droppedMs = 0;
    }
  };

  void (async () => {
    try {
      for await (const chunk of input as AsyncIterable<Buffer>) {
        if (output.destroyed) {
          break;
        }

        let data = chunk;
        if (header) {
          header = Buffer.concat([header, data]);
          let parsed: WavHeader | undefined;
          try {
            parsed = parseWavHeader(header);
          } catch (headerError) {
            unpaced = true;
            options.onUnpaced?.(headerError instanceof Error ? headerError.message : String(headerError));
            data = header;
            header = undefined;
          }

          if (header && !parsed) {
            continue;
          }

          if (parsed && header) {
            layout = parsed.layout;
            await write(header.subarray(0, parsed.headerBytes));
            data = header.subarray(parsed.headerBytes);
            header = undefined;
          }
        }

        if (unpaced || !layout) {
          await write(data);
          continue;
        }

        const msPerByte = 1000 / layout.bytesPerSecond;
        if (options.mode === "wait") {
          for (;;) {
            const played = options.playedMs();
            if (output.destroyed || sentMs <= played + Math.max(leadMs, startupAllowance(played))) {
              break;
            }

            await new Promise((resolve) => setTimeout(resolve, PACER_POLL_MS));
          }
        } else {
          const played = options.playedMs();
          const ahead = sentMs - played;

          if (!held && cushionMs > 0 && played > 0 && ahead < PACER_CUSHION_LOW_MS) {
            held = [];
            heldMs = 0;
          }

          if (held) {
            held.push(data);
            heldMs += data.length * msPerByte;
            if (ahead + heldMs < cushionMs) {
              continue;
            }

            data = Buffer.concat(held);
            held = undefined;
          } else if (dropping || ahead > maxAheadMs + startupAllowance(played)) {
            if (ahead > leadMs) {
              dropping = true;
              // Drop whole frames only, so the rest of the stream stays sample aligned.
              const keep = data.length % layout.frameBytes;
              droppedMs += (data.length - keep) * msPerByte;
              data = data.subarray(data.length - keep);
            } else {
              dropping = false;
              reportDrop();
            }
          }
        }

        if (output.destroyed) {
          break;
        }

        sentMs += data.length * msPerByte;
        await write(data);
      }

      reportDrop();
      output.end();
    } catch (pacerError) {
      output.destroy(pacerError instanceof Error ? pacerError : new Error(String(pacerError)));
    }
  })();

  return output;
}
