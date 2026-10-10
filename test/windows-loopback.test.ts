import { describe, expect, test } from "bun:test";
import { loopbackArgs, loopbackScript, parseLoopbackDeviceList, runLoopbackHelper } from "../ts/windows-loopback.ts";

test("script embeds the C# helper in a literal here-string", () => {
  const script = loopbackScript();
  expect(script).toContain("namespace Stdinman");
  expect(script).toContain("@'\n");
  // A line starting with '@ inside the helper would terminate the here-string early.
  const body = script.slice(script.indexOf("@'\n") + 3, script.lastIndexOf("\n'@"));
  expect(body.split("\n").some((line) => line.startsWith("'@"))).toBe(false);
});

test("helper arguments", () => {
  expect(loopbackArgs("x.ps1", "capture", "Speakers")).toEqual([
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    "x.ps1",
    "-Mode",
    "capture",
    "-Device",
    "Speakers",
  ]);
  expect(loopbackArgs("x.ps1", "capture")).not.toContain("-Device");
});

test("device list parsing", () => {
  expect(parseLoopbackDeviceList("Speakers (Realtek)\t{0.0.0}.{abc}\tdefault\r\nHeadset\t{0.0.0}.{def}\t\r\n")).toEqual([
    { name: "Speakers (Realtek)", id: "{0.0.0}.{abc}", isDefault: true },
    { name: "Headset", id: "{0.0.0}.{def}", isDefault: false },
  ]);
});

describe.skipIf(process.platform !== "win32")("on Windows", () => {
  test(
    "the helper compiles under Windows PowerShell and can enumerate devices",
    async () => {
      const check = await runLoopbackHelper("powershell.exe", "check");
      expect(check.stderr).toBe("");
      expect(check.code).toBe(0);
      const list = await runLoopbackHelper("powershell.exe", "list");
      expect(list.code).toBe(0);
    },
    120_000,
  );
});
