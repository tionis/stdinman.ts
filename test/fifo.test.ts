import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Readable } from "node:stream";
import { spawnWithBackpressure } from "../ts/fifo.ts";

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

describe.skipIf(process.platform === "win32")("spawnWithBackpressure", () => {
  test("delivers all output and reports the exit after the data", async () => {
    const spawned = spawnWithBackpressure("sh", ["-c", "head -c 300000 /dev/zero; exit 3"]);
    let closedAfter = -1;
    const output = collect(spawned.stdout);
    const exit = new Promise<number | null>((resolve) =>
      spawned.onClose((code) => {
        closedAfter = spawned.stdout.readableEnded ? 1 : 0;
        resolve(code);
      }),
    );
    expect((await output).length).toBe(300_000);
    expect(await exit).toBe(3);
    expect(closedAfter).toBe(1);
  });

  test("a missing command ends the stream", async () => {
    const spawned = spawnWithBackpressure("stdinman-definitely-missing-binary", []);
    spawned.child.on("error", () => {});
    await new Promise<void>((resolve) => spawned.onClose(() => resolve()));
    expect(spawned.stdout.destroyed || spawned.stdout.readableEnded).toBe(true);
  });

  test.skipIf(process.platform !== "linux")("holds a fast producer back to what is read", async () => {
    const spawned = spawnWithBackpressure("cat", ["/dev/zero"]);
    let consumed = 0;
    // Read about 64 KiB every 50 ms.
    const timer = setInterval(() => {
      const chunk = spawned.stdout.read(65_536) as Buffer | null;
      consumed += chunk?.length ?? 0;
    }, 50);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    clearInterval(timer);
    const written = Number(readFileSync(`/proc/${spawned.child.pid}/io`, "utf8").match(/wchar: (\d+)/)![1]);
    spawned.child.kill();
    spawned.stdout.destroy();
    // Without backpressure Bun lets cat write hundreds of megabytes in this time.
    expect(written - consumed).toBeLessThan(512 * 1024);
  });
});
