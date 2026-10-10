import type { Settings } from "./cli.ts";
import { CommandNotFoundError, runCommandCapture } from "./devices.ts";

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
  results.push({
    ok: Boolean(settings.voiceChannelId),
    label: "voice channel ID",
    detail: settings.voiceChannelId || "missing (--voice-channel-id, STDINMAN_VOICE_CHANNEL_ID or voice_channel_id)",
  });

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

  switch (settings.audioSource) {
    case "spotify":
      results.push(await checkTool("librespot", settings.librespotPath, ["--version"]));
      break;
    case "pulse-monitor": {
      results.push(await checkTool("parec", settings.parecPath, ["--version"]));
      results.push(await checkTool("pactl", settings.pactlPath, ["--version"]));
      results.push({
        ok: Boolean(settings.audioDevice),
        label: "audio device",
        detail: settings.audioDevice || 'missing (run "stdinman devices list")',
      });
      break;
    }
    case "windows-dshow":
      results.push({
        ok: Boolean(settings.audioDevice),
        label: "audio device",
        detail: settings.audioDevice || 'missing (run "stdinman devices list")',
      });
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
