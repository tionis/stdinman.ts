import type { ChildProcess } from "node:child_process";

const running = new Set<ChildProcess>();
let exitHookInstalled = false;

function killAll(): void {
  for (const child of running) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  }
}

/**
 * Registers a long-running child so it is killed when stdinman exits, even on
 * paths that skip the normal shutdown (a second Ctrl+C, a crash). Without this a
 * leftover librespot keeps announcing the same Spotify Connect device.
 */
export function trackChild<T extends ChildProcess>(child: T): T {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", killAll);
  }

  running.add(child);
  child.once("close", () => running.delete(child));
  child.once("error", () => running.delete(child));
  return child;
}

export function runningChildCount(): number {
  return running.size;
}
