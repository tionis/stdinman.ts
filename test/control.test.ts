import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSocketPath, sendControl, startControlServer } from "../ts/control.ts";

const socketPath = (name: string) =>
  process.platform === "win32"
    ? `\\\\.\\pipe\\stdinman-test-${process.pid}-${name}`
    : join(mkdtempSync(join(tmpdir(), "stdinman-ctl-")), `${name}.sock`);

describe("control socket", () => {
  test("round trip", async () => {
    const path = socketPath("roundtrip");
    const server = await startControlServer(path, async (args) => ({ ok: args[0] !== "fail", message: args.join(" ") }));
    try {
      expect(await sendControl(path, ["volume", "0.5"])).toEqual({ ok: true, message: "volume 0.5" });
      expect((await sendControl(path, ["fail"])).ok).toBe(false);
      if (process.platform !== "win32") {
        expect(statSync(path).mode & 0o777).toBe(0o600);
      }
    } finally {
      server.close();
    }
    if (process.platform !== "win32") {
      expect(existsSync(path)).toBe(false);
    }
  });

  test("handler errors become error responses", async () => {
    const path = socketPath("errors");
    const server = await startControlServer(path, async () => {
      throw new Error("boom");
    });
    try {
      expect(await sendControl(path, ["x"])).toEqual({ ok: false, message: "boom" });
    } finally {
      server.close();
    }
  });

  test("a second instance is refused", async () => {
    const path = socketPath("twice");
    const server = await startControlServer(path, async () => ({ ok: true }));
    try {
      expect(startControlServer(path, async () => ({ ok: true }))).rejects.toThrow(/already running/);
    } finally {
      server.close();
    }
  });

  test.skipIf(process.platform === "win32")("a socket left behind by a killed instance is replaced", async () => {
    const path = socketPath("stale");
    // A process that listens on the socket and is then killed without cleaning up.
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, [
      "-e",
      `require("node:net").createServer().listen(${JSON.stringify(path)}, () => console.log("listening"))`,
    ]);
    await new Promise((resolve) => child.stdout.once("data", resolve));
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    expect(existsSync(path)).toBe(true);

    const server = await startControlServer(path, async () => ({ ok: true, message: "new instance" }));
    try {
      expect((await sendControl(path, [])).message).toBe("new instance");
    } finally {
      server.close();
    }
  });

  test("no instance running", async () => {
    expect(sendControl(socketPath("missing"), ["status"])).rejects.toThrow(/no running stdinman instance/);
  });

  test("default paths", () => {
    expect(defaultSocketPath({ XDG_RUNTIME_DIR: "/run/user/1000" }, "linux")).toBe(join("/run/user/1000", "stdinman.sock"));
    expect(defaultSocketPath({ USERNAME: "Some User" }, "win32")).toBe("\\\\.\\pipe\\stdinman-Some_User");
  });
});
