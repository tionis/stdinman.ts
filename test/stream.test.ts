import { expect, test } from "bun:test";
import { reconnectDelayMs, truncateActivity } from "../ts/stream.ts";

test("reconnect backoff is immediate, then exponential and capped", () => {
  expect([1, 2, 3, 4, 5, 6, 7, 20].map(reconnectDelayMs)).toEqual([0, 1000, 2000, 4000, 8000, 16000, 30000, 30000]);
});

test("activity text is truncated to Discord's limit", () => {
  expect(truncateActivity("short")).toBe("short");
  const long = truncateActivity("x".repeat(300));
  expect(long).toHaveLength(128);
  expect(long.endsWith("…")).toBe(true);
});
