import { describe, expect, test } from "bun:test";
import { findApplicationStream, findDevice, parsePwDump } from "../ts/pipewire.ts";
import { pwRecordArgs } from "../ts/sources.ts";

const DUMP = JSON.stringify([
  { id: 0, type: "PipeWire:Interface:Core", info: {} },
  {
    id: 52,
    type: "PipeWire:Interface:Node",
    info: { props: { "object.serial": 52, "node.name": "alsa_output.analog", "node.description": "Speakers", "media.class": "Audio/Sink" } },
  },
  {
    id: 53,
    type: "PipeWire:Interface:Node",
    info: { props: { "object.serial": 53, "node.name": "alsa_input.analog", "node.description": "Mic", "media.class": "Audio/Source" } },
  },
  {
    id: 90,
    type: "PipeWire:Interface:Node",
    info: {
      props: {
        "object.serial": 2547,
        "node.name": "Firefox",
        "application.name": "Firefox",
        "application.process.binary": "firefox",
        "media.name": "Video",
        "media.class": "Stream/Output/Audio",
      },
    },
  },
  {
    id: 91,
    type: "PipeWire:Interface:Node",
    info: { props: { "object.serial": 2600, "node.name": "stdinman", "media.class": "Stream/Output/Audio" } },
  },
]);

describe("pw-dump parsing", () => {
  const nodes = parsePwDump(DUMP);

  test("keeps nodes only", () => {
    expect(nodes.map((node) => node.serial)).toEqual(["52", "53", "2547", "2600"]);
  });

  test("finds devices by name, description or serial", () => {
    expect(findDevice(nodes, "alsa_output.analog")?.serial).toBe("52");
    expect(findDevice(nodes, "Mic")?.name).toBe("alsa_input.analog");
    expect(findDevice(nodes, "52")?.name).toBe("alsa_output.analog");
    expect(findDevice(nodes, "Firefox")).toBeUndefined();
  });

  test("finds application streams case-insensitively, never itself", () => {
    expect(findApplicationStream(nodes, "firefox")?.serial).toBe("2547");
    expect(findApplicationStream(nodes, "FIREFOX")?.serial).toBe("2547");
    expect(findApplicationStream(nodes, "stdinman")).toBeUndefined();
  });
});

test("pw-record args capture monitors and never fall back", () => {
  const args = pwRecordArgs("alsa_output.analog");
  expect(args).toContain("stream.capture.sink=true");
  expect(args).toContain("node.dont-fallback=true");
  expect(args.slice(-3)).toEqual(["--target", "alsa_output.analog", "-"]);
  expect(pwRecordArgs("")).not.toContain("--target");
});
