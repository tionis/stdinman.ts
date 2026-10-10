import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommandCapture } from "./devices.ts";
import { debug } from "./log.ts";
import { type PreparedAudioSource, createProcessAudioSource, rawPcmInput } from "./sources.ts";
import helperSource from "./windows-loopback.cs" with { type: "text" };

export type LoopbackMode = "capture" | "list" | "check";

/** PowerShell script that compiles the C# helper with Add-Type and runs it. */
export function loopbackScript(): string {
  return `param([Parameter(Mandatory = $true)][string]$Mode, [string]$Device = "")
$ErrorActionPreference = "Stop"
$Source = @'
${helperSource}
'@
try {
  Add-Type -TypeDefinition $Source -Language CSharp
  switch ($Mode) {
    "list" { exit ([Stdinman.Loopback]::List()) }
    "check" { exit 0 }
    default { exit ([Stdinman.Loopback]::Capture($Device)) }
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.GetBaseException().Message)
  exit 1
}
`;
}

function writeLoopbackScript(): { path: string; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "stdinman-"));
  const path = join(dir, "windows-loopback.ps1");
  // The BOM makes Windows PowerShell 5.1 read the script as UTF-8.
  writeFileSync(path, `﻿${loopbackScript()}`, { encoding: "utf8", mode: 0o600 });
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

export function loopbackArgs(scriptPath: string, mode: LoopbackMode, device = ""): string[] {
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-Mode",
    mode,
    ...(device ? ["-Device", device] : []),
  ];
}

export async function runLoopbackHelper(
  powershellPath: string,
  mode: Exclude<LoopbackMode, "capture">,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const script = writeLoopbackScript();
  try {
    return await runCommandCapture(powershellPath, loopbackArgs(script.path, mode), 60_000);
  } finally {
    script.remove();
  }
}

export type LoopbackDevice = { name: string; id: string; isDefault: boolean };

export function parseLoopbackDeviceList(stdout: string): LoopbackDevice[] {
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const [name = "", id = "", flag = ""] = line.split("\t");
      return { name: name.trim(), id: id.trim(), isDefault: flag.trim() === "default" };
    })
    .filter((device) => device.name || device.id);
}

export function createWindowsLoopbackSource(options: { powershellPath: string; audioDevice: string }): PreparedAudioSource {
  const script = writeLoopbackScript();
  const label = options.audioDevice ? `output device "${options.audioDevice}"` : "the default output device";
  return createProcessAudioSource({
    command: options.powershellPath,
    args: loopbackArgs(script.path, "capture", options.audioDevice),
    ffmpegInput: rawPcmInput(
      "wav",
      `ffmpeg is still waiting for audio from ${label}. Windows only delivers loopback audio while something is playing.`,
    ),
    startupMessage: `starting WASAPI loopback capture of ${label}`,
    startedMessage: `WASAPI loopback helper started for ${label}`,
    logPrefix: "wasapi-loopback",
    awaitInitialPlayback: false,
    cleanup: script.remove,
  });
}
