import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { launchCommand, launchdPlist, systemdQuote, systemdUnit, windowsQuote, windowsTaskScript } from "../ts/service.ts";

test("launch command for scripts and standalone binaries", () => {
  expect(launchCommand("/usr/bin/node", "/opt/stdinman/dist/stdinman.js")).toEqual([
    "/usr/bin/node",
    resolve("/opt/stdinman/dist/stdinman.js"),
  ]);
  expect(launchCommand("/usr/local/bin/stdinman", "/$bunfs/root/stdinman")).toEqual(["/usr/local/bin/stdinman"]);
  expect(launchCommand("C:\\stdinman.exe", "B:\\~BUN\\root\\stdinman.exe")).toEqual(["C:\\stdinman.exe"]);
});

test("systemd unit quoting", () => {
  expect(systemdQuote("serve")).toBe("serve");
  expect(systemdQuote("/home/me/My Music/x")).toBe('"/home/me/My Music/x"');
  expect(systemdQuote("100%")).toBe("100%%");
  const unit = systemdUnit(["/usr/bin/stdinman", "serve", "--config", "/home/me/a b.toml"], "/usr/bin:/bin");
  expect(unit).toContain('ExecStart=/usr/bin/stdinman serve --config "/home/me/a b.toml"');
  expect(unit).toContain("Environment=PATH=/usr/bin:/bin");
  expect(systemdUnit(["x"], "/opt/my tools/bin")).toContain('Environment="PATH=/opt/my tools/bin"');
  expect(unit).toContain("WantedBy=default.target");
});

test("launchd plist escapes values", () => {
  const plist = launchdPlist(["/Applications/stdinman", "serve", "--config", "/Users/me/a&b.toml"], "/usr/bin", "/tmp/log");
  expect(plist).toContain("<string>/Users/me/a&amp;b.toml</string>");
  expect(plist).toContain("<string>serve</string>");
});

test("windows quoting and task script", () => {
  expect(windowsQuote("serve")).toBe("serve");
  expect(windowsQuote("C:\\Program Files\\stdinman\\stdinman.exe")).toBe('"C:\\Program Files\\stdinman\\stdinman.exe"');
  expect(windowsQuote('say "hi"')).toBe('"say \\"hi\\""');
  expect(windowsQuote("C:\\dir with space\\")).toBe('"C:\\dir with space\\\\"');
  const script = windowsTaskScript(["C:\\Users\\O'Neil\\stdinman.exe", "serve"]);
  expect(script).toContain("-Argument '--headless C:\\Users\\O''Neil\\stdinman.exe serve'");
  expect(script).toContain("-AtLogOn");
});
