import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(process.platform === "win32")("child cleanup", () => {
  test("tracked children are killed when the process exits abruptly", async () => {
    const childrenModule = join(import.meta.dir, "..", "ts", "children.ts");
    const script = `
      import { spawn } from "node:child_process";
      import { trackChild } from ${JSON.stringify(childrenModule)};
      const child = trackChild(spawn("sleep", ["30"], { stdio: "ignore" }));
      child.once("spawn", () => {
        console.log(child.pid);
        process.exit(130);
      });
    `;
    const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
    const pid = Number(result.stdout.trim());
    expect(pid).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(isAlive(pid)).toBe(false);
  });
});
