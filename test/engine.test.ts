import { describe, expect, test } from "bun:test";
import { ActivityTracker, truncateActivity } from "../ts/engine.ts";

describe("ActivityTracker", () => {
  function tracker(idleMs: number) {
    let now = 1_000_000;
    const changes: boolean[] = [];
    const activity = new ActivityTracker(() => idleMs, () => now);
    activity.on("change", (active) => changes.push(active));
    return {
      activity,
      changes,
      advance: (ms: number) => {
        now += ms;
        activity.check();
      },
    };
  }

  test("state reports hold until changed, then the idle timeout runs", () => {
    const { activity, changes, advance } = tracker(5_000);
    activity.report(true, "state");
    advance(60_000);
    expect(activity.active).toBe(true);
    activity.report(false, "state");
    advance(4_000);
    expect(activity.active).toBe(true);
    advance(2_000);
    expect(activity.active).toBe(false);
    expect(changes).toEqual([true, false]);
    activity.stop();
  });

  test("pulses keep the source active for the idle timeout", () => {
    const { activity, changes, advance } = tracker(3_000);
    activity.report(true, "pulse");
    advance(2_000);
    activity.report(true, "pulse");
    advance(2_000);
    expect(activity.active).toBe(true);
    advance(2_000);
    expect(activity.active).toBe(false);
    expect(changes).toEqual([true, false]);
    activity.stop();
  });

  test("a zero idle timeout goes idle as soon as playback stops", () => {
    const { activity, advance } = tracker(0);
    activity.report(true, "state");
    activity.report(false, "state");
    advance(1);
    expect(activity.active).toBe(false);
    activity.stop();
  });

  test("reset forgets earlier activity", () => {
    const { activity } = tracker(60_000);
    activity.report(true, "pulse");
    activity.reset();
    expect(activity.active).toBe(false);
    activity.stop();
  });
});

test("activity text is truncated to Discord's limit", () => {
  expect(truncateActivity("short")).toBe("short");
  expect(truncateActivity("x".repeat(300))).toHaveLength(128);
});
