#!/usr/bin/env node
import { generateDependencyReport } from "@discordjs/voice";
import { access } from "node:fs/promises";
import { isatty } from "node:tty";
import packageJson from "../package.json" with { type: "json" };
import {
  UsageError,
  defaultDeviceListSource,
  helpText,
  parseCli,
  resolveSettings,
  validateRunSettings,
} from "./cli.ts";
import { ConfigError, ensureConfigFile, loadConfig, parseAudioSource, resolveConfigPath } from "./config.ts";
import { listDevices } from "./devices.ts";
import { runDoctor } from "./doctor.ts";
import { CONTROL_HELP, runEngine } from "./engine.ts";
import { defaultSocketPath, sendControl } from "./control.ts";
import { debug, describeError, error, info, isDebugEnabled, setDebugEnabled, setLogFile, warn } from "./log.ts";
import { runService } from "./service.ts";

const VERSION: string = packageJson.version;

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function main(argv: string[]): Promise<number> {
  const { command, values } = parseCli(argv);

  if (values.verbose) {
    setDebugEnabled(true);
  }

  switch (command.kind) {
    case "help":
      console.log(helpText(VERSION));
      return 0;
    case "version":
      console.log(VERSION);
      return 0;
    default:
      break;
  }

  const configPath = values.config ?? resolveConfigPath();

  if (command.kind === "config-path") {
    console.log(configPath);
    return 0;
  }

  if (command.kind === "config-init") {
    if (await ensureConfigFile(configPath)) {
      info(`created config file at ${configPath}`);
    } else {
      info(`config file already exists at ${configPath}`);
    }
    return 0;
  }

  if (command.kind === "ctl") {
    if (command.args.length === 0 || command.args[0] === "help") {
      console.log(CONTROL_HELP);
      return 0;
    }

    const optional = await loadConfig(configPath, { create: false });
    const socketPath = values.socket ?? (optional.config.socket_path || defaultSocketPath());
    const response = await sendControl(socketPath, command.args);
    if (response.message) {
      (response.ok ? console.log : console.error)(response.message);
    }
    return response.ok ? 0 : 1;
  }

  // Only the streaming commands create the config file implicitly, matching the original stdinman.
  const loaded = await loadConfig(configPath, { create: command.kind === "run" || command.kind === "serve" });
  if (loaded.created) {
    info(`created config file at ${configPath}`);
  }
  for (const message of loaded.warnings) {
    warn(`${configPath}: ${message}`);
  }

  const { settings, warnings } = resolveSettings(values, loaded.config);

  if (command.kind === "devices-list") {
    await listDevices({
      audioSource: values.source
        ? parseAudioSource(values.source)
        : defaultDeviceListSource(loaded.config.audio_source),
      ffmpegPath: settings.ffmpegPath,
      pactlPath: settings.pactlPath,
      powershellPath: settings.powershellPath,
    });
    return 0;
  }

  if (command.kind === "doctor") {
    if (isDebugEnabled()) {
      console.log(generateDependencyReport());
    }
    return (await runDoctor(settings, configPath, await fileExists(configPath))) ? 0 : 1;
  }

  if (command.kind === "service") {
    if (command.action === "install") {
      // Fail now rather than in a background service nobody watches.
      validateRunSettings(settings, configPath, process.platform, { requireVoiceTarget: false });
    }

    if (command.action === "uninstall") {
      // Stop a running instance gracefully before removing the service.
      await sendControl(settings.socketPath || defaultSocketPath(), ["stop"], 5_000).catch(() => undefined);
    }

    return runService(command.action, values.config);
  }

  for (const message of warnings) {
    warn(message);
  }

  const mode = command.kind === "serve" ? "serve" : "oneshot";
  validateRunSettings(settings, configPath, process.platform, { requireVoiceTarget: mode === "oneshot" });

  if (settings.audioSource === "stdin" && isatty(0)) {
    throw new UsageError(
      "stdin is a terminal. Pipe raw PCM into stdinman (see --help), or choose another --source such as spotify or pulse-monitor",
    );
  }

  if (settings.logFile) {
    setLogFile(settings.logFile);
  }

  debug(generateDependencyReport());
  await runEngine({ mode, settings, cliValues: values, config: loaded.config, configPath });
  // The engine keeps the process alive and exits through its own shutdown path.
  return -1;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) {
      process.exitCode = code;
    }
  },
  (mainError: unknown) => {
    if (mainError instanceof UsageError || mainError instanceof ConfigError) {
      error(mainError.message);
      process.exitCode = 2;
      return;
    }

    error(mainError instanceof Error && isDebugEnabled() ? (mainError.stack ?? mainError.message) : describeError(mainError));
    process.exitCode = 1;
  },
);
