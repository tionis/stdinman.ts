import { spawn } from "node:child_process";
import type { AudioSource } from "./config.ts";
import { warn } from "./log.ts";

export type CapturedCommandResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
};

export class CommandNotFoundError extends Error {
  override name = "CommandNotFoundError";
}

export async function runCommandCapture(
  command: string,
  args: string[],
  timeoutMs = 15_000,
): Promise<CapturedCommandResult> {
  return await new Promise<CapturedCommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdoutText = "";
    let stderrText = "";
    const timer = setTimeout(() => {
      child.kill();
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutText += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderrText += chunk;
    });

    child.on("error", (childError: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (childError.code === "ENOENT") {
        reject(new CommandNotFoundError(`"${command}" was not found`));
        return;
      }

      reject(new Error(`failed to start ${command}: ${childError.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ stdout: stdoutText, stderr: stderrText, code, signal });
    });
  });
}

export type PulseSource = {
  id: string;
  name: string;
  driver: string;
  spec: string;
  state: string;
  isMonitor: boolean;
};

export function isMonitorSourceName(sourceName: string): boolean {
  return sourceName.endsWith(".monitor") || sourceName.toLowerCase().includes("monitor");
}

/** Parses `pactl list short sources` output, monitors first. */
export function parsePulseSources(stdout: string): PulseSource[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\t+/))
    .filter((columns) => columns.length >= 5)
    .map(([id, name, driver, spec, state]) => ({
      id,
      name,
      driver,
      spec,
      state,
      isMonitor: isMonitorSourceName(name),
    }))
    .sort((left, right) => Number(right.isMonitor) - Number(left.isMonitor) || left.name.localeCompare(right.name));
}

/** Extracts audio device names from `ffmpeg -list_devices true -f dshow -i dummy` stderr. */
export function parseDirectShowAudioDevices(stderr: string): string[] {
  const devices: string[] = [];
  let inAudioSection = false;

  const add = (name: string): void => {
    if (!devices.includes(name)) {
      devices.push(name);
    }
  };

  for (const line of stderr.split(/\r?\n/)) {
    // Newer ffmpeg builds tag every device with its type.
    const taggedAudioMatch = line.match(/"([^"]+)"\s+\(audio\)/i);
    if (taggedAudioMatch) {
      add(taggedAudioMatch[1]);
      continue;
    }

    // Older builds list devices in "DirectShow video devices" / "DirectShow audio devices" sections.
    if (line.includes("DirectShow audio devices")) {
      inAudioSection = true;
      continue;
    }

    if (line.includes("DirectShow video devices")) {
      inAudioSection = false;
      continue;
    }

    if (!inAudioSection || /Alternative name/i.test(line) || /\((video|none)\)/i.test(line)) {
      continue;
    }

    const sectionMatch = line.match(/"([^"]+)"/);
    if (sectionMatch) {
      add(sectionMatch[1]);
    }
  }

  return devices;
}

export const SOURCE_DESCRIPTIONS: Record<AudioSource, string> = {
  stdin: "Read raw PCM or WAV from stdin",
  command: "Run a command and read raw PCM or WAV from its stdout",
  media: "Play files, directories or URLs with ffmpeg",
  spotify: "Spawn librespot and stream Spotify Connect audio",
  "pulse-monitor": "Capture a PulseAudio/PipeWire source via parec (Linux)",
  pipewire: "Capture a PipeWire device or application via pw-record (Linux)",
  "windows-dshow": "Capture a DirectShow audio device via ffmpeg (Windows)",
  "windows-loopback": "Capture what a Windows output device plays (Windows)",
  "macos-avfoundation": "Capture an AVFoundation audio device via ffmpeg (macOS)",
};

export function printAvailableSources(): void {
  console.log("Available source modes:");
  for (const [source, description] of Object.entries(SOURCE_DESCRIPTIONS)) {
    console.log(`  ${source.padEnd(20)}${description}`);
  }
}

/** Extracts audio devices from `ffmpeg -f avfoundation -list_devices true -i ""` stderr. */
export function parseAvfoundationAudioDevices(stderr: string): Array<{ index: string; name: string }> {
  const devices: Array<{ index: string; name: string }> = [];
  let inAudioSection = false;
  for (const line of stderr.split(/\r?\n/)) {
    if (/AVFoundation audio devices/i.test(line)) {
      inAudioSection = true;
      continue;
    }

    if (/AVFoundation video devices/i.test(line)) {
      inAudioSection = false;
      continue;
    }

    const match = line.match(/\[(\d+)\]\s+(.+?)\s*$/);
    if (inAudioSection && match) {
      devices.push({ index: match[1], name: match[2] });
    }
  }

  return devices;
}

async function listPulseSources(pactlPath: string): Promise<void> {
  const printPulseListingWarning = (message: string): void => {
    printAvailableSources();
    console.log("");
    warn(message);
    console.log("You can still use --source pulse-monitor --audio-device <SOURCE_NAME> if you already know the source name.");
  };

  let result: CapturedCommandResult;
  try {
    result = await runCommandCapture(pactlPath, ["list", "short", "sources"]);
  } catch (captureError) {
    printPulseListingWarning(
      captureError instanceof CommandNotFoundError
        ? `PulseAudio/PipeWire source listing is unavailable because "${pactlPath}" was not found. Install pactl (pulseaudio-utils) to list sources.`
        : `PulseAudio/PipeWire source listing is unavailable: ${String(captureError)}`,
    );
    return;
  }

  if (result.code !== 0) {
    printPulseListingWarning(
      `PulseAudio/PipeWire source listing is unavailable: ${result.stderr.trim() || `exit code ${result.code ?? "null"}`}`,
    );
    return;
  }

  const rows = parsePulseSources(result.stdout);

  printAvailableSources();
  console.log("");
  console.log("PulseAudio/PipeWire sources (use the name with --audio-device):");

  if (rows.length === 0) {
    console.log("  (none found)");
    return;
  }

  for (const row of rows) {
    const kind = row.isMonitor ? "monitor" : "source";
    console.log(`  ${row.name}  [${kind}]  ${row.spec}  ${row.state}`);
  }
}

async function listDirectShowAudioDevices(ffmpegPath: string): Promise<void> {
  let result: CapturedCommandResult;
  try {
    result = await runCommandCapture(ffmpegPath, ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"]);
  } catch (captureError) {
    if (captureError instanceof CommandNotFoundError) {
      throw new Error(`cannot list DirectShow devices: ${captureError.message}. Install ffmpeg or pass --ffmpeg-path.`);
    }

    throw captureError;
  }

  const devices = parseDirectShowAudioDevices(result.stderr);
  if (devices.length === 0) {
    throw new Error(
      `failed to list DirectShow audio devices using ${ffmpegPath}: ${result.stderr.trim() || `exit code ${result.code ?? "null"}`}`,
    );
  }

  printAvailableSources();
  console.log("");
  console.log("DirectShow audio devices (use the name with --audio-device):");
  for (const device of devices) {
    console.log(`  ${device}`);
  }
}

async function listAvfoundationAudioDevices(ffmpegPath: string): Promise<void> {
  let result: CapturedCommandResult;
  try {
    result = await runCommandCapture(ffmpegPath, ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""]);
  } catch (captureError) {
    if (captureError instanceof CommandNotFoundError) {
      throw new Error(`cannot list AVFoundation devices: ${captureError.message}. Install ffmpeg or pass --ffmpeg-path.`);
    }

    throw captureError;
  }

  const devices = parseAvfoundationAudioDevices(result.stderr);
  printAvailableSources();
  console.log("");
  console.log("AVFoundation audio devices (use the name or index with --audio-device):");
  if (devices.length === 0) {
    console.log("  (none found)");
  }

  for (const device of devices) {
    console.log(`  [${device.index}] ${device.name}`);
  }

  console.log("");
  console.log("To stream what your Mac plays, route its output to a loopback device such as BlackHole and capture that.");
}

async function listPipeWireNodes(pwDumpPath: string): Promise<void> {
  const { parsePwDump, isApplicationOutput } = await import("./pipewire.ts");
  printAvailableSources();
  console.log("");

  let result: CapturedCommandResult;
  try {
    result = await runCommandCapture(pwDumpPath, []);
  } catch (captureError) {
    warn(
      captureError instanceof CommandNotFoundError
        ? `PipeWire node listing is unavailable because "${pwDumpPath}" was not found.`
        : `PipeWire node listing is unavailable: ${String(captureError)}`,
    );
    return;
  }

  if (result.code !== 0) {
    warn(`PipeWire node listing is unavailable: ${result.stderr.trim() || `exit code ${result.code ?? "null"}`}`);
    return;
  }

  const nodes = parsePwDump(result.stdout);
  const print = (title: string, rows: string[]): void => {
    console.log(title);
    console.log(rows.length > 0 ? rows.join("\n") : "  (none found)");
    console.log("");
  };

  print(
    "Output devices (captures what they play):",
    nodes.filter((node) => node.mediaClass === "Audio/Sink").map((node) => `  ${node.name}  (${node.description})`),
  );
  print(
    "Input devices:",
    nodes
      .filter((node) => node.mediaClass.startsWith("Audio/Source"))
      .map((node) => `  ${node.name}  (${node.description})`),
  );
  print(
    "Applications currently playing (capture by application name):",
    [
      ...new Set(
        nodes
          .filter(isApplicationOutput)
          .map((node) => `  ${node.applicationName || node.name}${node.mediaName ? `  (${node.mediaName})` : ""}`),
      ),
    ],
  );
  console.log("Without --audio-device, the pipewire source captures the default output device.");
}

async function listWindowsLoopbackDevices(powershellPath: string): Promise<void> {
  const { runLoopbackHelper, parseLoopbackDeviceList } = await import("./windows-loopback.ts");
  const result = await runLoopbackHelper(powershellPath, "list");
  if (result.code !== 0) {
    throw new Error(`failed to list Windows output devices: ${result.stderr.trim() || `exit code ${result.code ?? "null"}`}`);
  }

  printAvailableSources();
  console.log("");
  console.log("Windows output devices (use the name with --audio-device; default is used when omitted):");
  const devices = parseLoopbackDeviceList(result.stdout);
  if (devices.length === 0) {
    console.log("  (none found)");
  }

  for (const device of devices) {
    console.log(`  ${device.name}${device.isDefault ? "  [default]" : ""}`);
  }
}

export async function listDevices(options: {
  audioSource: AudioSource;
  ffmpegPath: string;
  pactlPath: string;
  powershellPath: string;
}): Promise<void> {
  switch (options.audioSource) {
    case "pulse-monitor":
      if (process.platform !== "linux") {
        throw new Error("pulse-monitor source listing is only supported on Linux");
      }

      await listPulseSources(options.pactlPath);
      return;
    case "windows-dshow":
      if (process.platform !== "win32") {
        throw new Error("windows-dshow source listing is only supported on Windows");
      }

      await listDirectShowAudioDevices(options.ffmpegPath);
      return;
    case "pipewire":
      if (process.platform !== "linux") {
        throw new Error("pipewire source listing is only supported on Linux");
      }

      await listPipeWireNodes("pw-dump");
      return;
    case "windows-loopback":
      if (process.platform !== "win32") {
        throw new Error("windows-loopback source listing is only supported on Windows");
      }

      await listWindowsLoopbackDevices(options.powershellPath);
      return;
    case "macos-avfoundation":
      if (process.platform !== "darwin") {
        throw new Error("macos-avfoundation source listing is only supported on macOS");
      }

      await listAvfoundationAudioDevices(options.ffmpegPath);
      return;
    case "stdin":
    case "command":
    case "media":
    case "spotify":
      printAvailableSources();
      console.log("");
      console.log(`source "${options.audioSource}" does not use a device list`);
      return;
  }
}
