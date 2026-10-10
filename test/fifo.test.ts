import { describe, expect, test } from "bun:test";
import type { Readable } from "node:stream";
import { spawnWithBackpressure } from "../ts/fifo.ts";

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

describe("spawnWithBackpressure", () => {
  test("delivers all output and reports the exit after the data", async () => {
    const spawned = spawnWithBackpressure(process.execPath, [
      "-e",
      "process.stdout.write(Buffer.alloc(300000), () => process.exit(3))",
    ]);
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

  test("holds a fast producer back to what is read", async () => {
    // The producer reports how much it has written on stderr.
    const spawned = spawnWithBackpressure(process.execPath, [
      "-e",
      `const chunk = Buffer.alloc(65536); let written = 0;
       const write = () => { const ok = process.stdout.write(chunk); written += chunk.length; process.stderr.write(written + "\\n");
         if (ok) setImmediate(write); else process.stdout.once("drain", write); };
       process.stdout.on("error", () => process.exit(0)); write();`,
    ]);
    let written = 0;
    spawned.child.stderr!.setEncoding("utf8");
    spawned.child.stderr!.on("data", (text: string) => {
      const last = text.trim().split("\n").pop();
      written = Number(last) || written;
    });
    let consumed = 0;
    // Read about 64 KiB every 50 ms.
    const timer = setInterval(() => {
      const chunk = spawned.stdout.read(65_536) as Buffer | null;
      consumed += chunk?.length ?? 0;
    }, 50);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    clearInterval(timer);
    spawned.child.kill();
    spawned.stdout.destroy();
    // Without backpressure Bun lets the producer write hundreds of megabytes in this time.
    expect(written).toBeGreaterThan(0);
    expect(written - consumed).toBeLessThan(1024 * 1024);
  });
});
