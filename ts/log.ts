export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const LOGGER_NAME = "stdinman.ts";

let debugOverride: boolean | undefined;

export function setDebugEnabled(enabled: boolean): void {
  debugOverride = enabled;
}

export function isDebugEnabled(): boolean {
  if (debugOverride !== undefined) {
    return debugOverride;
  }

  const value = `${process.env.STDINMAN_LOG ?? process.env.RUST_LOG ?? ""}`.toLowerCase();
  return value.includes("debug") || value.includes("trace");
}

export function log(level: LogLevel, message: string): void {
  const line = `[${new Date().toISOString()}] ${level} ${LOGGER_NAME} ${message}`;
  if (level === "ERROR" || level === "WARN") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export function debug(message: string): void {
  if (isDebugEnabled()) {
    log("DEBUG", message);
  }
}

export function info(message: string): void {
  log("INFO", message);
}

export function warn(message: string): void {
  log("WARN", message);
}

export function error(message: string): void {
  log("ERROR", message);
}

export function describeError(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/**
 * Keeps the last few lines a child process wrote to stderr so failures can be
 * reported with context even when debug logging is off.
 */
export class LineTail {
  private readonly lines: string[] = [];
  private partial = "";

  constructor(private readonly maxLines = 10) {}

  push(chunk: string): string[] {
    const parts = (this.partial + chunk).split(/\r?\n|\r/);
    this.partial = parts.pop() ?? "";
    const complete = parts.map((line) => line.trim()).filter(Boolean);
    for (const line of complete) {
      this.lines.push(line);
      if (this.lines.length > this.maxLines) {
        this.lines.shift();
      }
    }

    return complete;
  }

  text(): string {
    const pending = this.partial.trim();
    return [...this.lines, ...(pending ? [pending] : [])].join("\n");
  }
}
