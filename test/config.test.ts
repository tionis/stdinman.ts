import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  defaultConfig,
  loadConfig,
  parseConfig,
  parseLibrespotBitrate,
  parseDuration,
  parseOpusBitrate,
  parseVolume,
  renderDefaultConfig,
  resolveConfigPath,
} from "../ts/config.ts";

describe("parseConfig", () => {
  test("empty document yields defaults", () => {
    const { config, warnings } = parseConfig("");
    expect(config).toEqual(defaultConfig());
    expect(warnings).toEqual([]);
  });

  test("generated default config round-trips", () => {
    expect(parseConfig(renderDefaultConfig()).config).toEqual(defaultConfig());
  });

  test("reads all supported keys", () => {
    const { config } = parseConfig(`
bot_token = "token"
voice_channel_id = "123456789012345678"
audio_source = "pulse-monitor"
audio_device = "sink.monitor"
input_format = "s16le"
volume = 0.5
opus_bitrate = 128
librespot_bitrate = 160
librespot_args = ["--initial-volume", "50"]
`);
    expect(config.bot_token).toBe("token");
    expect(config.voice_channel_id).toBe("123456789012345678");
    expect(config.audio_source).toBe("pulse-monitor");
    expect(config.audio_device).toBe("sink.monitor");
    expect(config.input_format).toBe("s16le");
    expect(config.volume).toBe(0.5);
    expect(config.opus_bitrate).toBe(128);
    expect(config.librespot_bitrate).toBe(160);
    expect(config.librespot_args).toEqual(["--initial-volume", "50"]);
  });

  test("accepts unquoted snowflake IDs without losing precision", () => {
    expect(parseConfig("voice_channel_id = 1234567890123456789").config.voice_channel_id).toBe("1234567890123456789");
  });

  test("reads source and follow settings", () => {
    const { config } = parseConfig(`
inputs = ["a.mp3", "https://example.com/stream"]
loop = true
command = "arecord -f S16_LE"
sample_rate = 44100
channels = 1
follow_user_id = 123456789012345678
now_playing = false
audio_filter = "bass=g=3"
`);
    expect(config.inputs).toEqual(["a.mp3", "https://example.com/stream"]);
    expect(config.loop).toBe(true);
    expect(config.command).toBe("arecord -f S16_LE");
    expect(config.sample_rate).toBe(44100);
    expect(config.channels).toBe(1);
    expect(config.follow_user_id).toBe("123456789012345678");
    expect(config.now_playing).toBe(false);
    expect(config.audio_filter).toBe("bass=g=3");
  });

  test("rejects small numeric channel IDs with a hint to quote them", () => {
    expect(() => parseConfig("voice_channel_id = 42")).toThrow(/quoted string/);
  });

  test("empty strings fall back to defaults", () => {
    const { config } = parseConfig('ffmpeg_path = ""\naudio_source = ""');
    expect(config.ffmpeg_path).toBe("ffmpeg");
    expect(config.audio_source).toBe("stdin");
  });

  test("warns about unknown keys", () => {
    expect(parseConfig("bot_tokn = 'x'").warnings).toEqual(['unknown config key "bot_tokn" will be ignored']);
  });

  test.each([
    ['audio_source = "spotfy"', /audio_source/],
    ['input_format = "mp3"', /input_format/],
    ["sample_rate = 100", /sample_rate/],
    ["channels = 0", /channels/],
    ['loop = "yes"', /loop/],
    ["inputs = [1]", /inputs/],
    ["librespot_bitrate = 128", /librespot_bitrate/],
    ['librespot_args = "--foo"', /librespot_args/],
    ["bot_token = 5", /bot_token/],
    ["volume = -1", /volume/],
    ["this is not toml", /invalid TOML/],
  ])("rejects invalid value %p", (text, message) => {
    expect(() => parseConfig(text)).toThrow(ConfigError);
    expect(() => parseConfig(text)).toThrow(message);
  });
});

describe("durations", () => {
  test.each([
    ["90", 90_000],
    [90, 90_000],
    ["30s", 30_000],
    ["5m", 300_000],
    ["1h30m", 5_400_000],
    ["250ms", 250],
    ["0", 0],
  ])("%p -> %p ms", (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  test.each(["", "5 minutes", "-1", "m5", "5x"])("rejects %p", (input) => {
    expect(() => parseDuration(input)).toThrow(/duration/);
  });
});

describe("value parsers", () => {
  test("librespot bitrate accepts strings and numbers", () => {
    expect(parseLibrespotBitrate("96")).toBe(96);
    expect(parseLibrespotBitrate(320)).toBe(320);
    expect(() => parseLibrespotBitrate("abc")).toThrow();
  });

  test("volume bounds", () => {
    expect(parseVolume("0")).toBe(0);
    expect(parseVolume("2.5")).toBe(2.5);
    expect(() => parseVolume("11")).toThrow();
    expect(() => parseVolume("loud")).toThrow();
  });

  test("opus bitrate bounds", () => {
    expect(parseOpusBitrate("0")).toBe(0);
    expect(parseOpusBitrate("96")).toBe(96);
    expect(() => parseOpusBitrate("5")).toThrow();
    expect(() => parseOpusBitrate("96.5")).toThrow();
    expect(() => parseOpusBitrate("600")).toThrow();
  });
});

describe("config files", () => {
  test("resolveConfigPath honours STDINMAN_CONFIG and XDG_CONFIG_HOME", () => {
    expect(resolveConfigPath({ STDINMAN_CONFIG: "/x/y.toml" })).toBe("/x/y.toml");
    expect(resolveConfigPath({ XDG_CONFIG_HOME: "/cfg" })).toBe(join("/cfg", "stdinman", "stdinman.toml"));
  });

  test("loadConfig creates a private config file once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stdinman-test-"));
    const path = join(dir, "nested", "stdinman.toml");

    const first = await loadConfig(path, { create: true });
    expect(first.created).toBe(true);
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }

    await writeFile(path, 'bot_token = "abc"\n');
    const second = await loadConfig(path, { create: true });
    expect(second.created).toBe(false);
    expect(second.config.bot_token).toBe("abc");
    expect(await readFile(path, "utf8")).toBe('bot_token = "abc"\n');
  });

  test("loadConfig without create returns defaults for missing files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stdinman-test-"));
    const loaded = await loadConfig(join(dir, "missing.toml"), { create: false });
    expect(loaded.created).toBe(false);
    expect(loaded.config.audio_source).toBe("stdin");
  });

  test("loadConfig errors mention the file path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stdinman-test-"));
    const path = join(dir, "bad.toml");
    await writeFile(path, 'audio_source = "nope"');
    expect(loadConfig(path, { create: false })).rejects.toThrow(path);
  });
});
