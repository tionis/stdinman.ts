import { describe, expect, test } from "bun:test";
import {
  CommandNotFoundError,
  isMonitorSourceName,
  parseDirectShowAudioDevices,
  parsePulseSources,
  runCommandCapture,
} from "../ts/devices.ts";

describe("parsePulseSources", () => {
  test("parses pactl output and lists monitors first", () => {
    const rows = parsePulseSources(
      [
        "50\talsa_input.pci.analog-stereo\tPipeWire\ts32le 2ch 48000Hz\tSUSPENDED",
        "49\talsa_output.pci.analog-stereo.monitor\tPipeWire\ts32le 2ch 48000Hz\tRUNNING",
        "garbage line",
        "",
      ].join("\n"),
    );
    expect(rows.map((row) => row.name)).toEqual(["alsa_output.pci.analog-stereo.monitor", "alsa_input.pci.analog-stereo"]);
    expect(rows[0]).toMatchObject({ id: "49", isMonitor: true, state: "RUNNING" });
    expect(rows[1].isMonitor).toBe(false);
  });

  test("monitor detection", () => {
    expect(isMonitorSourceName("sink.monitor")).toBe(true);
    expect(isMonitorSourceName("Virtual_Monitor_Source")).toBe(true);
    expect(isMonitorSourceName("mic")).toBe(false);
  });
});

describe("parseDirectShowAudioDevices", () => {
  test("newer ffmpeg output with type tags", () => {
    const stderr = `[dshow @ 0000] "Integrated Camera" (video)
[dshow @ 0000]   Alternative name "@device_pnp_\\\\?\\usb#vid"
[dshow @ 0000] "Microphone (Realtek(R) Audio)" (audio)
[dshow @ 0000]   Alternative name "@device_cm_{33D9A762}\\wave_{ABC}"
[dshow @ 0000] "CABLE Output (VB-Audio Virtual Cable)" (audio)
dummy: Immediate exit requested`;
    expect(parseDirectShowAudioDevices(stderr)).toEqual([
      "Microphone (Realtek(R) Audio)",
      "CABLE Output (VB-Audio Virtual Cable)",
    ]);
  });

  test("older ffmpeg output with sections", () => {
    const stderr = `[dshow @ 0000] DirectShow video devices (some may be both video and audio devices)
[dshow @ 0000]  "Integrated Camera"
[dshow @ 0000]     Alternative name "@device_pnp_cam"
[dshow @ 0000] DirectShow audio devices
[dshow @ 0000]  "Stereo Mix (Realtek Audio)"
[dshow @ 0000]     Alternative name "@device_cm_mix"
[dshow @ 0000]  "Stereo Mix (Realtek Audio)"`;
    expect(parseDirectShowAudioDevices(stderr)).toEqual(["Stereo Mix (Realtek Audio)"]);
  });

  test("no devices", () => {
    expect(parseDirectShowAudioDevices("Could not enumerate audio only devices (or none found).")).toEqual([]);
  });
});

describe("runCommandCapture", () => {
  test("captures stdout, stderr and exit code", async () => {
    const result = await runCommandCapture(process.execPath, [
      "-e",
      "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)",
    ]);
    expect(result).toMatchObject({ stdout: "out", stderr: "err", code: 3 });
  });

  test("reports missing commands", async () => {
    expect(runCommandCapture("stdinman-definitely-missing-binary", [])).rejects.toBeInstanceOf(CommandNotFoundError);
  });
});
