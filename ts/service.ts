import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { info, warn } from "./log.ts";

export type ServiceAction = "install" | "uninstall" | "status";

const SERVICE_NAME = "stdinman";
const LAUNCHD_LABEL = "dev.tionis.stdinman";

/** The command that starts this stdinman: the standalone binary, or the runtime plus script. */
export function launchCommand(execPath = process.execPath, script = process.argv[1]): string[] {
  // Bun's standalone binaries report an embedded script path like /$bunfs/root/... or B:\~BUN\...
  const compiled = !script || script.includes("$bunfs") || script.includes("~BUN");
  return compiled ? [execPath] : [execPath, resolve(script)];
}

/** Quotes an argument for a systemd ExecStart line. */
export function systemdQuote(arg: string): string {
  const escaped = arg.replace(/%/g, "%%");
  return /[\s"\\]/.test(escaped) ? `"${escaped.replace(/[\\"]/g, "\\$&")}"` : escaped;
}

export function systemdUnit(command: string[], path: string): string {
  return `[Unit]
Description=stdinman: stream audio from this computer into Discord
After=network-online.target pipewire.service pipewire-pulse.service
Wants=network-online.target

[Service]
ExecStart=${command.map(systemdQuote).join(" ")}
Restart=on-failure
RestartSec=10
# The PATH from installation, so ffmpeg, librespot and pw-record are found.
Environment=${systemdQuote(`PATH=${path}`)}

[Install]
WantedBy=default.target
`;
}

function xmlEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function launchdPlist(command: string[], path: string, logFile: string): string {
  const strings = (values: string[]) => values.map((value) => `    <string>${xmlEscape(value)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${strings(command)}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(path)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logFile)}</string>
</dict>
</plist>
`;
}

/** Quotes for a Windows command line (CommandLineToArgvW rules). */
export function windowsQuote(arg: string): string {
  if (arg && !/[\s"]/.test(arg)) {
    return arg;
  }

  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

function powershellString(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

/** PowerShell that registers a logon task running stdinman without a console window. */
export function windowsTaskScript(command: string[]): string {
  const argument = `--headless ${command.map(windowsQuote).join(" ")}`;
  // %USERDOMAIN% is not reliable (e.g. "WORKGROUP" over SSH); the current identity always maps to an account.
  return `$ErrorActionPreference = 'Stop'
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument ${powershellString(argument)}
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName ${powershellString(SERVICE_NAME)} -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName ${powershellString(SERVICE_NAME)}
`;
}

function run(command: string, args: string[], options: { inherit?: boolean } = {}): number {
  const result = spawnSync(command, args, { stdio: options.inherit ? "inherit" : "pipe", encoding: "utf8" });
  if (result.error) {
    throw new Error(`failed to run ${command}: ${result.error.message}`);
  }

  if (!options.inherit && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }

  return result.status ?? 1;
}

function powershell(script: string, inherit = false): number {
  return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    inherit,
  });
}

function serveCommand(configPath: string | undefined, extra: string[] = []): string[] {
  return [...launchCommand(), "serve", ...(configPath ? ["--config", resolve(configPath)] : []), ...extra];
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { encoding: "utf8", mode: 0o644 });
  info(`wrote ${path}`);
}

function systemdUnitPath(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user", `${SERVICE_NAME}.service`);
}

function launchdPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

/**
 * Installs, removes or inspects the background service running `stdinman serve`
 * for the current user. `configPath` is passed along only if it was given explicitly.
 */
export function runService(action: ServiceAction, configPath: string | undefined): number {
  const path = process.env.PATH ?? "";
  switch (process.platform) {
    case "linux": {
      const unitPath = systemdUnitPath();
      if (action === "install") {
        writeFile(unitPath, systemdUnit(serveCommand(configPath), path));
        run("systemctl", ["--user", "daemon-reload"]);
        run("systemctl", ["--user", "enable", "--now", `${SERVICE_NAME}.service`]);
        info(`installed and started the ${SERVICE_NAME} systemd user service`);
        info(`logs: journalctl --user -u ${SERVICE_NAME} -f`);
        info(`to keep it running while you are logged out: loginctl enable-linger ${userInfo().username}`);
        return 0;
      }

      if (action === "uninstall") {
        if (existsSync(unitPath)) {
          run("systemctl", ["--user", "disable", "--now", `${SERVICE_NAME}.service`]);
          unlinkSync(unitPath);
          run("systemctl", ["--user", "daemon-reload"]);
          info(`removed ${unitPath}`);
        } else {
          warn(`${unitPath} does not exist`);
        }
        return 0;
      }

      return run("systemctl", ["--user", "status", "--no-pager", `${SERVICE_NAME}.service`], { inherit: true });
    }
    case "darwin": {
      const plistPath = launchdPlistPath();
      const domain = `gui/${userInfo().uid}`;
      if (action === "install") {
        const logFile = join(homedir(), "Library", "Logs", "stdinman.log");
        if (existsSync(plistPath)) {
          spawnSync("launchctl", ["bootout", `${domain}/${LAUNCHD_LABEL}`]);
        }
        writeFile(plistPath, launchdPlist(serveCommand(configPath), path, logFile));
        run("launchctl", ["bootstrap", domain, plistPath]);
        info(`installed and started the ${LAUNCHD_LABEL} launch agent; logs: ${logFile}`);
        return 0;
      }

      if (action === "uninstall") {
        spawnSync("launchctl", ["bootout", `${domain}/${LAUNCHD_LABEL}`]);
        if (existsSync(plistPath)) {
          unlinkSync(plistPath);
          info(`removed ${plistPath}`);
        }
        return 0;
      }

      return run("launchctl", ["print", `${domain}/${LAUNCHD_LABEL}`], { inherit: true });
    }
    case "win32": {
      if (action === "install") {
        const logFile = join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "stdinman", "stdinman.log");
        powershell(windowsTaskScript(serveCommand(configPath, ["--log-file", logFile])));
        info(`installed and started the "${SERVICE_NAME}" logon task; logs: ${logFile}`);
        return 0;
      }

      if (action === "uninstall") {
        powershell(
          `$task = Get-ScheduledTask -TaskName ${powershellString(SERVICE_NAME)} -ErrorAction SilentlyContinue
if ($task) { Stop-ScheduledTask -TaskName ${powershellString(SERVICE_NAME)}; Unregister-ScheduledTask -TaskName ${powershellString(SERVICE_NAME)} -Confirm:$false }`,
        );
        info(`removed the "${SERVICE_NAME}" logon task`);
        return 0;
      }

      return powershell(
        `$task = Get-ScheduledTask -TaskName ${powershellString(SERVICE_NAME)} -ErrorAction SilentlyContinue
if (-not $task) { Write-Output 'not installed'; exit 3 }
$info = $task | Get-ScheduledTaskInfo
Write-Output ("state:       " + $task.State)
Write-Output ("last run:    " + $info.LastRunTime + " (result " + $info.LastTaskResult + ")")
Write-Output ("command:     " + $task.Actions[0].Execute + " " + $task.Actions[0].Arguments)`,
        true,
      );
    }
    default:
      throw new Error(`stdinman service is not supported on ${process.platform}; see the README for running it yourself`);
  }
}
