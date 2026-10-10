import type { Settings } from "./cli.ts";
import { CommandNotFoundError, runCommandCapture } from "./devices.ts";
import { expandInputs } from "./media.ts";
import { resolvePipeWireTarget } from "./pipewire.ts";
import { runLoopbackHelper } from "./windows-loopback.ts";

type CheckResult = { ok: boolean; label: string; detail?: string };

async function checkTool(label: string, command: string, args: string[]): Promise<CheckResult & { output: string }> {
  try {
    const result = await runCommandCapture(command, args);
    const output = `${result.stdout}\n${result.stderr}`;
    const firstLine = output.split(/\r?\n/).find((line) => line.trim()) ?? "";
    return { ok: true, label, detail: `${command}: ${firstLine.trim()}`, output };
  } catch (toolError) {
    const detail =
      toolError instanceof CommandNotFoundError
        ? `"${command}" not found on PATH`
        : toolError instanceof Error
          ? toolError.message
          : String(toolError);
    return { ok: false, label, detail, output: "" };
  }
}

/** Loads the native DAVE (end-to-end encryption) library that voice connections need. */
async function checkDave(): Promise<CheckResult> {
  try {
    const davey = (await import("@snazzah/davey")).default;
    return { ok: true, label: "DAVE library", detail: `protocol version ${davey.DAVE_PROTOCOL_VERSION}` };
  } catch (daveError) {
    return {
      ok: false,
      label: "DAVE library",
      detail: `failed to load @snazzah/davey: ${daveError instanceof Error ? daveError.message : String(daveError)}`,
    };
  }
}

/** Checks that the configuration and external tools needed for the selected source are usable. */
export async function runDoctor(settings: Settings, configPath: string, configExists: boolean): Promise<boolean> {
  const results: CheckResult[] = [];

  results.push({
    ok: configExists,
    label: "config file",
    detail: configExists ? configPath : `${configPath} does not exist (run "stdinman config init")`,
  });
  results.push({
    ok: Boolean(settings.botToken),
    label: "bot token",
    detail: settings.botToken ? "set" : "missing (--bot-token, STDINMAN_BOT_TOKEN or bot_token)",
  });
  results.push(
    settings.followUserId
      ? { ok: true, label: "voice target", detail: `following user ${settings.followUserId}` }
      : {
          ok: Boolean(settings.voiceChannelId),
          label: "voice target",
          detail: settings.voiceChannelId
            ? `channel ${settings.voiceChannelId}`
            : "missing (--voice-channel-id or --follow-user, or voice_channel_id / follow_user_id in the config)",
        },
  );

  results.push(await checkDave());

  const ffmpeg = await checkTool("ffmpeg", settings.ffmpegPath, ["-hide_banner", "-version"]);
  results.push(ffmpeg);
  if (ffmpeg.ok) {
    const encoders = await checkTool("ffmpeg libopus encoder", settings.ffmpegPath, ["-hide_banner", "-encoders"]);
    const hasOpus = /\blibopus\b/.test(encoders.output);
    results.push({
      ok: hasOpus,
      label: "ffmpeg libopus encoder",
      detail: hasOpus ? "available" : "missing; install an ffmpeg build with libopus support",
    });
  }

  const deviceCheck = (required: boolean, fallback: string): CheckResult => ({
    ok: Boolean(settings.audioDevice) || !required,
    label: "audio device",
    detail: settings.audioDevice || (required ? 'missing (run "stdinman devices list")' : fallback),
  });

  switch (settings.audioSource) {
    case "spotify":
      results.push(await checkTool("librespot", settings.librespotPath, ["--version"]));
      break;
    case "pulse-monitor":
      results.push(await checkTool("parec", settings.parecPath, ["--version"]));
      results.push(await checkTool("pactl", settings.pactlPath, ["--version"]));
      results.push(deviceCheck(true, ""));
      break;
    case "pipewire": {
      results.push(await checkTool("pw-record", settings.pwRecordPath, ["--version"]));
      results.push(await checkTool("pw-dump", "pw-dump", ["--version"]));
      if (settings.audioDevice) {
        const target = await resolvePipeWireTarget(settings.audioDevice);
        results.push({
          ok: true,
          label: "audio device",
          detail:
            target.kind === "device"
              ? `PipeWire device ${target.name}`
              : target.kind === "application"
                ? `no device named "${settings.audioDevice}"; will capture the application with that name when it plays`
                : settings.audioDevice,
        });
      } else {
        results.push(deviceCheck(false, "default output device"));
      }
      break;
    }
    case "windows-dshow":
      results.push(deviceCheck(true, ""));
      break;
    case "windows-loopback": {
      const helper = await runLoopbackHelper(settings.powershellPath, "check").catch((helperError: unknown) => ({
        code: 1,
        stderr: helperError instanceof Error ? helperError.message : String(helperError),
      }));
      results.push({
        ok: helper.code === 0,
        label: "WASAPI loopback helper",
        detail: helper.code === 0 ? `compiles with ${settings.powershellPath}` : helper.stderr.trim(),
      });
      results.push(deviceCheck(false, "default output device"));
      break;
    }
    case "macos-avfoundation":
      if (ffmpeg.ok) {
        const devices = await checkTool("ffmpeg avfoundation", settings.ffmpegPath, ["-hide_banner", "-devices"]);
        const hasAvfoundation = /\bavfoundation\b/.test(devices.output);
        results.push({
          ok: hasAvfoundation,
          label: "ffmpeg avfoundation input",
          detail: hasAvfoundation ? "available" : "missing; install an ffmpeg build with AVFoundation support",
        });
      }
      results.push(deviceCheck(true, ""));
      break;
    case "media": {
      results.push({ ok: settings.inputs.length > 0, label: "inputs", detail: settings.inputs.join(", ") || "missing (--input)" });
      if (settings.inputs.length > 0) {
        try {
          const inputs = await expandInputs(settings.inputs);
          results.push({ ok: inputs.length > 0, label: "playable inputs", detail: `${inputs.length} found` });
        } catch (inputError) {
          results.push({ ok: false, label: "playable inputs", detail: inputError instanceof Error ? inputError.message : String(inputError) });
        }
      }
      break;
    }
    case "command":
      results.push({ ok: Boolean(settings.command), label: "command", detail: settings.command || "missing (--command)" });
      break;
    case "stdin":
      break;
  }

  console.log(`Checking setup for source "${settings.audioSource}":`);
  for (const result of results) {
    console.log(`  ${result.ok ? "ok  " : "FAIL"}  ${result.label}${result.detail ? ` - ${result.detail}` : ""}`);
  }

  return results.every((result) => result.ok);
}
