import { describe, expect, test } from "bun:test";
import {
  UsageError,
  defaultDeviceListSource,
  helpText,
  parseCli,
  resolveSettings,
  validateRunSettings,
} from "../ts/cli.ts";
import { AUDIO_SOURCES, type StdinmanConfig, defaultConfig } from "../ts/config.ts";

const CHANNEL = "123456789012345678";

function config(overrides: Partial<StdinmanConfig> = {}): StdinmanConfig {
  return { ...defaultConfig(), ...overrides };
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
    expect(() => resolve(["--input-format", "mp3"])).toThrow(/--input-format/);
    expect(() => resolve(["--sample-rate", "fast"])).toThrow(/--sample-rate/);
    expect(() => resolve(["--follow-user", "bob"])).toThrow(/Copy User ID/);
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

describe("voice target", () => {
  const USER = "223456789012345678";

  test("follow mode replaces the channel from lower layers", () => {
    const cfg = config({ voice_channel_id: CHANNEL });
    expect(resolve(["--follow-user", USER], cfg).settings).toMatchObject({ followUserId: USER, voiceChannelId: "" });
    expect(resolve([], cfg, { STDINMAN_FOLLOW_USER_ID: USER }).settings.followUserId).toBe(USER);
  });

  test("a CLI channel replaces a configured follow user", () => {
    const cfg = config({ follow_user_id: USER });
    expect(resolve(["--voice-channel-id", CHANNEL], cfg).settings).toMatchObject({
      followUserId: "",
      voiceChannelId: CHANNEL,
    });
  });

  test("both on the same layer follows the user with a warning", () => {
    const { settings, warnings } = resolve(["--voice-channel-id", CHANNEL, "--follow-user", USER]);
    expect(settings.followUserId).toBe(USER);
    expect(warnings.join()).toMatch(/following the user/);
  });

  test("now playing flags", () => {
    expect(resolve([]).settings.nowPlaying).toBe(true);
    expect(resolve(["--no-now-playing"]).settings.nowPlaying).toBe(false);
    expect(resolve(["--now-playing"], config({ now_playing: false })).settings.nowPlaying).toBe(true);
    expect(() => resolve(["--now-playing", "--no-now-playing"])).toThrow(/conflicts/);
  });
});

describe("source specific options", () => {
  test("media inputs and loop", () => {
    const { settings } = resolve(["-s", "media", "-i", "a.mp3", "-i", "dir", "--loop"]);
    expect(settings.inputs).toEqual(["a.mp3", "dir"]);
    expect(settings.loop).toBe(true);
  });

  test("warns about options that do not apply", () => {
    const warnings = resolve(["-s", "spotify", "-i", "a.mp3", "--command", "x", "--sample-rate", "44100"]).warnings;
    expect(warnings.join("\n")).toMatch(/--input/);
    expect(warnings.join("\n")).toMatch(/--command/);
    expect(warnings.join("\n")).toMatch(/--sample-rate/);
  });

  test("command source reads PCM options", () => {
    const { settings, warnings } = resolve(["-s", "command", "--command", "x", "--input-format", "s16le", "--channels", "1"]);
    expect(settings).toMatchObject({ command: "x", inputFormat: "s16le", channels: 1 });
    expect(warnings).toEqual([]);
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
    expect(() => validateRunSettings({ ...base(), voiceChannelId: "" }, "cfg")).toThrow(/--follow-user/);
  });

  test("follow mode does not need a channel", () => {
    expect(() =>
      validateRunSettings({ ...base(), voiceChannelId: "", followUserId: "223456789012345678" }, "cfg", "linux"),
    ).not.toThrow();
  });

  test("media and command need their inputs", () => {
    expect(() => validateRunSettings({ ...base(), audioSource: "media" }, "cfg")).toThrow(/--input/);
    expect(() => validateRunSettings({ ...base(), audioSource: "media", inputs: ["a"] }, "cfg")).not.toThrow();
    expect(() => validateRunSettings({ ...base(), audioSource: "command" }, "cfg")).toThrow(/--command/);
  });

  test("default-device sources do not need --audio-device", () => {
    expect(() => validateRunSettings({ ...base(), audioSource: "pipewire" }, "cfg", "linux")).not.toThrow();
    expect(() => validateRunSettings({ ...base(), audioSource: "windows-loopback" }, "cfg", "win32")).not.toThrow();
    expect(() => validateRunSettings({ ...base(), audioSource: "macos-avfoundation" }, "cfg", "darwin")).toThrow(
      /audio-device/,
    );
    expect(() => validateRunSettings({ ...base(), audioSource: "pipewire" }, "cfg", "darwin")).toThrow(/Linux/);
    expect(() => validateRunSettings({ ...base(), audioSource: "windows-loopback" }, "cfg", "linux")).toThrow(/Windows/);
  });

  test("spotify rejects conflicting librespot args", () => {
    expect(() =>
      validateRunSettings({ ...base(), audioSource: "spotify", librespotArgs: ["--format", "S16"] }, "cfg"),
    ).toThrow(UsageError);
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
  expect(defaultDeviceListSource("spotify", "darwin")).toBe("macos-avfoundation");
  expect(defaultDeviceListSource("spotify", "freebsd")).toBe("spotify");
  expect(defaultDeviceListSource("windows-dshow", "linux")).toBe("windows-dshow");
});

test("help text mentions every source", () => {
  const text = helpText("1.2.3");
  for (const source of AUDIO_SOURCES) {
    expect(text).toContain(source);
  }
});
