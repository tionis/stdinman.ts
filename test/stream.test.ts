import { expect, test } from "bun:test";
import { reconnectDelayMs } from "../ts/stream.ts";

test("reconnect backoff is immediate, then exponential and capped", () => {
  expect([1, 2, 3, 4, 5, 6, 7, 20].map(reconnectDelayMs)).toEqual([0, 1000, 2000, 4000, 8000, 16000, 30000, 30000]);
});
