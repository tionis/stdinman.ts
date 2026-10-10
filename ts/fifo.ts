import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { closeSync, constants, mkdtempSync, openSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { trackChild } from "./children.ts";
import { debug } from "./log.ts";

// Small reads keep little audio queued between the producer and the pacer.
const READ_CHUNK_BYTES = 16 * 1024;
const EMPTY_POLL_MS = 10;

/**
 * Reads a FIFO with explicit non-blocking reads, only when the stream wants more
 * data. The kernel pipe buffer then holds the writer back, which is the only
 * backpressure that works under Bun: it drains child stdout pipes eagerly, so a
 * producer faster than real time (librespot, file decoding) would run hours ahead.
 */
class FifoReadable extends Readable {
  private timer: NodeJS.Timeout | undefined;
  private fdClosed = false;

  constructor(private readonly fd: number) {
    super({ highWaterMark: READ_CHUNK_BYTES });
  }

  override _read(size: number): void {
    if (this.fdClosed) {
      return;
    }

    const buffer = Buffer.allocUnsafe(Math.min(Math.max(size, 4096), READ_CHUNK_BYTES));
    let bytesRead: number;
    try {
      bytesRead = readSync(this.fd, buffer, 0, buffer.length, null);
    } catch (readError) {
      if ((readError as NodeJS.ErrnoException).code === "EAGAIN") {
        // Nothing written yet; check again shortly.
        this.timer = setTimeout(() => this._read(size), EMPTY_POLL_MS);
        return;
      }

      this.destroy(readError as Error);
      return;
    }

    if (bytesRead === 0) {
      // All writers closed the FIFO.
      this.push(null);
      return;
    }

    this.push(buffer.subarray(0, bytesRead));
  }

  override _destroy(destroyError: Error | null, callback: (error?: Error | null) => void): void {
    this.fdClosed = true;
    clearTimeout(this.timer);
    try {
      closeSync(this.fd);
    } catch {
      // Already closed.
    }
    callback(destroyError);
  }
}

export type ChildWithStdout = {
  child: ChildProcess;
  stdout: Readable;
  /** Called once the process has exited and its stdout has been fully read. */
  onClose: (listener: (code: number | null, signal: NodeJS.Signals | null) => void) => void;
};

type SpawnOptions = { shell?: boolean; windowsHide?: boolean };

function createFifo(): { path: string; remove: () => void } | undefined {
  const dir = mkdtempSync(join(tmpdir(), "stdinman-"));
  const path = join(dir, "audio.fifo");
  const remove = (): void => rmSync(dir, { recursive: true, force: true });
  const result = spawnSync("mkfifo", ["-m", "600", path]);
  if (result.status !== 0) {
    remove();
    debug(`mkfifo failed (${result.error?.message ?? result.stderr?.toString().trim()}); falling back to a normal pipe`);
    return undefined;
  }

  return { path, remove };
}

export function spawnPiped(command: string, args: string[], options: SpawnOptions = {}): ChildWithStdout {
  const child = trackChild(spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] }));
  return {
    child,
    stdout: child.stdout!,
    // Node emits "close" only after the stdio streams have ended.
    onClose: (listener) => child.once("close", listener),
  };
}

/**
 * Spawns a process whose stdout is read with real backpressure. Uses a FIFO
 * where available (Linux, macOS) and a normal pipe elsewhere.
 */
export function spawnWithBackpressure(command: string, args: string[], options: SpawnOptions = {}): ChildWithStdout {
  if (process.platform === "win32") {
    return spawnPiped(command, args, options);
  }

  const fifo = createFifo();
  if (!fifo) {
    return spawnPiped(command, args, options);
  }

  let readFd: number | undefined;
  let writeFd: number | undefined;
  try {
    // Opening the read end non-blocking succeeds without a writer; the write end then opens immediately.
    readFd = openSync(fifo.path, constants.O_RDONLY | constants.O_NONBLOCK);
    writeFd = openSync(fifo.path, constants.O_WRONLY);
  } catch (openError) {
    for (const fd of [readFd, writeFd]) {
      if (fd !== undefined) {
        closeSync(fd);
      }
    }
    fifo.remove();
    debug(`opening the FIFO failed (${String(openError)}); falling back to a normal pipe`);
    return spawnPiped(command, args, options);
  } finally {
    // Both ends are open (or failed); the path is no longer needed.
    fifo.remove();
  }

  const stdout = new FifoReadable(readFd);
  const child = trackChild(spawn(command, args, { ...options, stdio: ["ignore", writeFd, "pipe"] }));
  // The child holds its own copy; keeping ours open would prevent end-of-file.
  closeSync(writeFd);

  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let drained = false;
  const listeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  const notify = (): void => {
    if (exit && drained) {
      for (const listener of listeners.splice(0)) {
        listener(exit.code, exit.signal);
      }
    }
  };

  stdout.once("end", () => {
    drained = true;
    notify();
  });
  stdout.once("close", () => {
    drained = true;
    notify();
  });
  child.once("close", (code, signal) => {
    exit = { code, signal };
    notify();
  });
  child.once("error", () => {
    // The process never started, so nothing will be written.
    stdout.destroy();
  });

  return {
    child,
    stdout,
    onClose: (listener) => {
      listeners.push(listener);
      notify();
    },
  };
}
