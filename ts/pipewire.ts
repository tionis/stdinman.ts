import { type ChildProcess, spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { trackChild } from "./children.ts";
import { CommandNotFoundError, runCommandCapture } from "./devices.ts";
import { LineTail, debug, info } from "./log.ts";
import { type PreparedAudioSource, pwRecordArgs, rawPcmInput } from "./sources.ts";

const APP_POLL_INTERVAL_MS = 2_000;

export type PipeWireNode = {
  serial: string;
  name: string;
  description: string;
  mediaClass: string;
  applicationName: string;
  binary: string;
  mediaName: string;
};

export function parsePwDump(json: string): PipeWireNode[] {
  const objects = JSON.parse(json) as Array<{ type?: string; info?: { props?: Record<string, unknown> } }>;
  const text = (value: unknown): string => (value === undefined || value === null ? "" : String(value));

  return objects
    .filter((object) => object.type === "PipeWire:Interface:Node")
    .map((object) => {
      const props = object.info?.props ?? {};
      return {
        serial: text(props["object.serial"] ?? props["object.id"]),
        name: text(props["node.name"]),
        description: text(props["node.description"] ?? props["node.nick"]),
        mediaClass: text(props["media.class"]),
        applicationName: text(props["application.name"]),
        binary: text(props["application.process.binary"]),
        mediaName: text(props["media.name"]),
      };
    });
}

export function isAudioDevice(node: PipeWireNode): boolean {
  return node.mediaClass.startsWith("Audio/");
}

export function isApplicationOutput(node: PipeWireNode): boolean {
  return node.mediaClass === "Stream/Output/Audio" && node.name !== "stdinman";
}

export function findDevice(nodes: PipeWireNode[], target: string): PipeWireNode | undefined {
  return nodes.find(
    (node) => isAudioDevice(node) && (node.name === target || node.serial === target || node.description === target),
  );
}

export function findApplicationStream(nodes: PipeWireNode[], target: string): PipeWireNode | undefined {
  const wanted = target.toLowerCase();
  return nodes.find(
    (node) =>
      isApplicationOutput(node) &&
      [node.applicationName, node.binary, node.name, node.serial].some((value) => value.toLowerCase() === wanted),
  );
}

async function pwDump(pwDumpPath: string): Promise<PipeWireNode[] | undefined> {
  try {
    const result = await runCommandCapture(pwDumpPath, []);
    if (result.code !== 0) {
      debug(`[pipewire] pw-dump failed: ${result.stderr.trim()}`);
      return undefined;
    }

    return parsePwDump(result.stdout);
  } catch (dumpError) {
    if (!(dumpError instanceof CommandNotFoundError)) {
      debug(`[pipewire] pw-dump failed: ${String(dumpError)}`);
    }

    return undefined;
  }
}

export type PipeWireTarget =
  | { kind: "default" }
  | { kind: "device"; name: string }
  | { kind: "application"; query: string }
  /** pw-dump was unavailable; pass the target to pw-record unchecked. */
  | { kind: "unchecked"; name: string };

export async function resolvePipeWireTarget(target: string, pwDumpPath = "pw-dump"): Promise<PipeWireTarget> {
  if (!target) {
    return { kind: "default" };
  }

  const nodes = await pwDump(pwDumpPath);
  if (!nodes) {
    return { kind: "unchecked", name: target };
  }

  const device = findDevice(nodes, target);
  return device ? { kind: "device", name: device.name } : { kind: "application", query: target };
}

/**
 * Captures a PipeWire device or application with pw-record. Devices are
 * captured once; applications are re-attached whenever their output stream
 * (re)appears, since apps create and destroy streams as they start and stop playing.
 */
export function createPipeWireSource(options: {
  pwRecordPath: string;
  target: PipeWireTarget;
  pwDumpPath?: string;
}): PreparedAudioSource {
  const { target } = options;
  const output = new PassThrough();
  let child: ChildProcess | undefined;
  let stopping = false;
  let started = false;
  let pollTimer: NodeJS.Timeout | undefined;
  let waitingLogged = false;

  const label =
    target.kind === "default"
      ? "the default PipeWire output"
      : target.kind === "application"
        ? `application "${target.query}"`
        : `PipeWire node "${target.name}"`;

  const record = (pwTarget: string, onExit: (code: number | null, signal: NodeJS.Signals | null, tail: string) => void): void => {
    const args = pwRecordArgs(pwTarget);
    debug(`starting pw-record: ${options.pwRecordPath} ${args.join(" ")}`);
    const stderrTail = new LineTail();
    const current = trackChild(spawn(options.pwRecordPath, args, { stdio: ["ignore", "pipe", "pipe"] }));
    child = current;
    current.stdout.pipe(output, { end: false });
    current.stderr.setEncoding("utf8");
    current.stderr.on("data", (chunk: string) => {
      for (const line of stderrTail.push(chunk)) {
        debug(`[pw-record] ${line}`);
      }
    });
    current.on("error", (spawnError: NodeJS.ErrnoException) => {
      const hint = spawnError.code === "ENOENT" ? ` (is "${options.pwRecordPath}" installed and on PATH?)` : "";
      output.destroy(new Error(`failed to start pw-record (${options.pwRecordPath}): ${spawnError.message}${hint}`));
    });
    current.on("close", (code, signal) => {
      current.stdout.unpipe(output);
      if (!stopping && !output.destroyed) {
        onExit(code, signal, stderrTail.text());
      }
    });
  };

  const captureOnce = (pwTarget: string): void => {
    record(pwTarget, (code, signal, tail) => {
      output.destroy(new Error(`pw-record exited with code=${code ?? "null"} signal=${signal ?? "null"}${tail ? `\n${tail}` : ""}`));
    });
  };

  const followApplication = async (query: string): Promise<void> => {
    if (stopping) {
      return;
    }

    const nodes = await pwDump(options.pwDumpPath ?? "pw-dump");
    const stream = nodes ? findApplicationStream(nodes, query) : undefined;
    if (stopping) {
      return;
    }

    if (!stream) {
      if (!waitingLogged) {
        waitingLogged = true;
        info(`waiting for ${label} to play audio`);
      }

      pollTimer = setTimeout(() => void followApplication(query), APP_POLL_INTERVAL_MS);
      return;
    }

    waitingLogged = false;
    info(`capturing ${label} (${stream.mediaName || stream.name}, node ${stream.serial})`);
    record(stream.serial, () => {
      info(`${label} stopped playing`);
      pollTimer = setTimeout(() => void followApplication(query), APP_POLL_INTERVAL_MS / 4);
    });
  };

  return {
    stream: output,
    ffmpegInput: rawPcmInput("f32le", `ffmpeg is still waiting for audio from ${label}. Make sure something is playing.`),
    start: (): void => {
      if (started || stopping) {
        return;
      }

      started = true;
      switch (target.kind) {
        case "default":
          captureOnce("");
          return;
        case "device":
        case "unchecked":
          captureOnce(target.name);
          return;
        case "application":
          void followApplication(target.query);
          return;
      }
    },
    stop: (): void => {
      if (stopping) {
        return;
      }

      stopping = true;
      clearTimeout(pollTimer);
      output.end();
      if (child && child.exitCode === null && child.signalCode === null) {
        child.stdout?.unpipe(output);
        child.kill("SIGTERM");
      }
    },
    startupMessage: `starting PipeWire capture from ${label}`,
    awaitInitialPlayback: false,
    pacing: "drop",
  };
}
