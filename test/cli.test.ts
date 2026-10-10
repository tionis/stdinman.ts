import { describe, expect, test } from "bun:test";
import {
  UsageError,
  defaultDeviceListSource,
  helpText,
  parseCli,
  resolveSettings,
  validateRunSettings,
} from "../ts/cli.ts";
import { DEFAULT_CONFIG, type StdinmanConfig } from "../ts/config.ts";

const CHANNEL = "123456789012345678";

function config(overrides: Partial<StdinmanConfig> = {}): StdinmanConfig {
  return { ...DEFAULT_CONFIG, librespot_args: [], ...overrides };
}

function resolve(argv: string[], cfg = config(), env: NodeJS.ProcessEnv = {}) {
  return resolveSettings(parseCli(argv).values, cfg, env);
}

describe("parseCli", () => {
  test.each([
    [[], "run"],
    [["--help"], "help"],
    [["help"], "help"],
    [["-V"], "version"],
    [["devices"], "devices-list"],
    [["devices", "list"], "devices-list"],
    [["config", "path"], "config-path"],
    [["config", "init"], "config-init"],
    [["doctor"], "doctor"],
  ])("%p -> %s", (argv, kind) => {
    expect(parseCli(argv).command.kind as string).toBe(kind);
  });

  test("unknown commands and flags are usage errors", () => {
    expect(() => parseCli(["play"])).toThrow(UsageError);
    expect(() => parseCli(["--nope"])).toThrow(UsageError);
  });

  test("repeatable librespot args", () => {
    expect(parseCli(["--librespot-arg", "a", "--librespot-arg", "b"]).values["librespot-arg"]).toEqual(["a", "b"]);
  });
});

describe("resolveSettings", () => {
  test("defaults come from the config", () => {
    const { settings, warnings } = resolve([]);
    expect(settings.audioSource).toBe("stdin");
    expect(settings.librespotBitrate).toBe(320);
    expect(settings.volume).toBe(1);
    expect(warnings).toEqual([]);
  });

  test("precedence is CLI > env > config", () => {
    const cfg = config({ bot_token: "from-config", voice_channel_id: CHANNEL });
    expect(resolve([], cfg).settings.botToken).toBe("from-config");
    expect(resolve([], cfg, { STDINMAN_BOT_TOKEN: "from-env" }).settings.botToken).toBe("from-env");
    expect(resolve(["--bot-token", "from-cli"], cfg, { STDINMAN_BOT_TOKEN: "from-env" }).settings.botToken).toBe(
      "from-cli",
    );
    expect(resolve([], cfg, { STDINMAN_BOT_TOKEN: "" }).settings.botToken).toBe("from-config");
  });

  test("--spotify selects the spotify source", () => {
    expect(resolve(["--spotify"]).settings.audioSource).toBe("spotify");
    expect(resolve(["--spotify", "--source", "spotify"]).settings.audioSource).toBe("spotify");
    expect(() => resolve(["--spotify", "--source", "stdin"])).toThrow(/conflicts/);
  });

  test("invalid flag values are rejected instead of silently replaced", () => {
    expect(() => resolve(["--source", "spotfy"])).toThrow(/--source/);
    expect(() => resolve(["--input-format", "wav"])).toThrow(/--input-format/);
    expect(() => resolve(["--librespot-bitrate", "128"])).toThrow(/--librespot-bitrate/);
    expect(() => resolve(["--volume", "x"])).toThrow(/--volume/);
    expect(() => resolve(["--voice-channel-id", "general"])).toThrow(/Discord ID/);
  });

  test("warns about options that do not apply to the source", () => {
    const { warnings } = resolve(["--source", "spotify", "--input-format", "s16le", "-d", "x"]);
    expect(warnings).toHaveLength(2);
    expect(resolve(["--librespot-name", "x"]).warnings[0]).toMatch(/librespot/);
  });

  test("input format applies to stdin", () => {
    expect(resolve(["--input-format", "s16le"]).settings.inputFormat).toBe("s16le");
  });
});

describe("validateRunSettings", () => {
  const base = () => resolve(["--bot-token", "t", "--voice-channel-id", CHANNEL]).settings;

  test("accepts a complete stdin setup", () => {
    expect(() => validateRunSettings(base(), "cfg", "linux")).not.toThrow();
  });

  test("requires token and channel", () => {
    expect(() => validateRunSettings({ ...base(), botToken: "" }, "cfg")).toThrow(/bot token/);
    expect(() => validateRunSettings({ ...base(), voiceChannelId: "" }, "cfg")).toThrow(/voice channel/);
  });

  test("capture sources require a device and the right platform", () => {
    const pulse = { ...base(), audioSource: "pulse-monitor" as const };
    expect(() => validateRunSettings(pulse, "cfg", "linux")).toThrow(/audio-device/);
    expect(() => validateRunSettings({ ...pulse, audioDevice: "x" }, "cfg", "linux")).not.toThrow();
    expect(() => validateRunSettings({ ...pulse, audioDevice: "x" }, "cfg", "darwin")).toThrow(/Linux/);
    const dshow = { ...base(), audioSource: "windows-dshow" as const, audioDevice: "x" };
    expect(() => validateRunSettings(dshow, "cfg", "linux")).toThrow(/Windows/);
    expect(() => validateRunSettings(dshow, "cfg", "win32")).not.toThrow();
  });
});

test("defaultDeviceListSource", () => {
  expect(defaultDeviceListSource("stdin", "linux")).toBe("pulse-monitor");
  expect(defaultDeviceListSource("stdin", "win32")).toBe("windows-dshow");
  expect(defaultDeviceListSource("spotify", "darwin")).toBe("spotify");
  expect(defaultDeviceListSource("windows-dshow", "linux")).toBe("windows-dshow");
});

test("help text mentions every source", () => {
  const text = helpText("1.2.3");
  for (const source of ["stdin", "spotify", "pulse-monitor", "windows-dshow"]) {
    expect(text).toContain(source);
  }
});
