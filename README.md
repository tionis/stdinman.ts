# stdinman.ts

[![CI](https://github.com/tionis/stdinman.ts/actions/workflows/ci.yml/badge.svg)](https://github.com/tionis/stdinman.ts/actions/workflows/ci.yml)

`stdinman.ts` streams audio into a Discord voice or stage channel through a bot. It is a standalone TypeScript implementation of `stdinman`.

This project was extracted from the TypeScript/DAVE-capable implementation inside the original [`ckcr4lyf/stdinman`](https://github.com/ckcr4lyf/stdinman) repository. The original project established the idea and shipped the earlier Rust implementation; this repository focuses only on the maintained TypeScript runtime.

Authors:
- `ckcr4lyf`
- `tionis.dev`

## What It Does

`stdinman.ts` connects a Discord bot to a voice channel and streams audio from one of these sources:

| Source          | Platform | What it plays                                               |
| --------------- | -------- | ----------------------------------------------------------- |
| `stdin`         | any      | Raw PCM piped into standard input (default)                 |
| `spotify`       | any      | A Spotify Connect device provided by `librespot`            |
| `pulse-monitor` | Linux    | A PulseAudio / PipeWire source or monitor, captured with `parec` |
| `windows-dshow` | Windows  | A DirectShow audio device, captured with `ffmpeg`           |

It uses `discord.js` and `@discordjs/voice` with DAVE support, so it can join Discord voice channels that require end-to-end encryption. If the voice connection drops, it reconnects with backoff and keeps the audio source running.

## Requirements

- Node.js `22.12.0` or newer
- `ffmpeg` with `libopus` support
- [Bun](https://bun.sh/) only if you build from source

Depending on the source:

- `librespot` for `spotify`
- `parec` and `pactl` (e.g. `pulseaudio-utils`) for `pulse-monitor`

Run `stdinman doctor` to check your setup.

## Installation

Install a release tarball from [GitHub Releases](https://github.com/tionis/stdinman.ts/releases):

```bash
npm install -g https://github.com/tionis/stdinman.ts/releases/download/v0.2.0/stdinman.ts-0.2.0.tgz
stdinman --help
```

Or build from source:

```bash
bun install
bun run build
node ./dist/stdinman.js --help
```

## Discord Setup

1. Create an application and bot in the [Discord Developer Portal](https://discord.com/developers/applications) and copy the bot token.
2. Invite the bot to your server with the `View Channels`, `Connect` and `Speak` permissions.
3. In Discord, turn on Developer Mode (Settings → Advanced), right-click the voice channel and choose **Copy Channel ID**.

## Quick Start

```bash
stdinman config init          # creates the config file and prints its path
$EDITOR "$(stdinman config path)"   # set bot_token and voice_channel_id
stdinman doctor               # check that everything is in place
```

Then pick a source:

```bash
# Play a file through stdin
ffmpeg -re -i song.mp3 -f f32le -ar 48000 -ac 2 - | stdinman

# Spotify Connect: start playback on the "stdinman_connect" device
stdinman --spotify

# Linux: stream whatever plays on a PulseAudio/PipeWire sink
stdinman devices list
stdinman --source pulse-monitor --audio-device alsa_output.pci-0000_00_1f.3.analog-stereo.monitor
```

```powershell
# Windows: stream a DirectShow capture device (e.g. VB-Audio Virtual Cable)
stdinman devices list
stdinman --source windows-dshow --audio-device "CABLE Output (VB-Audio Virtual Cable)"
```

## Commands

```text
stdinman [OPTIONS]                 Join the voice channel and start streaming
stdinman devices list [--source S] List capture devices for a source
stdinman doctor [OPTIONS]          Check config and external tools
stdinman config path               Print the config file location
stdinman config init               Create the config file if it does not exist
```

## Options

| Option                          | Config key          | Description                                               |
| ------------------------------- | ------------------- | --------------------------------------------------------- |
| `--bot-token <TOKEN>`           | `bot_token`         | Discord bot token (env: `STDINMAN_BOT_TOKEN`)             |
| `--voice-channel-id <ID>`       | `voice_channel_id`  | Target voice/stage channel (env: `STDINMAN_VOICE_CHANNEL_ID`) |
| `--bot-activity <TEXT>`         | `bot_activity`      | Activity shown on the bot profile                         |
| `-s, --source <SOURCE>`         | `audio_source`      | `stdin`, `spotify`, `pulse-monitor` or `windows-dshow`    |
| `--spotify`                     |                     | Same as `--source spotify`                                |
| `-d, --audio-device <NAME>`     | `audio_device`      | Capture device for `pulse-monitor` / `windows-dshow`      |
| `--input-format <FORMAT>`       | `input_format`      | stdin PCM format: `f32le` or `s16le` (48 kHz stereo)      |
| `--volume <FACTOR>`             | `volume`            | Volume multiplier, 0–10 (default 1)                       |
| `--opus-bitrate <KBPS>`         | `opus_bitrate`      | Opus bitrate in kbit/s, 6–510 (0 = encoder default)       |
| `--ffmpeg-path <PATH>`          | `ffmpeg_path`       | ffmpeg binary                                             |
| `--parec-path <PATH>`           | `parec_path`        | parec binary                                              |
| `--pactl-path <PATH>`           | `pactl_path`        | pactl binary                                              |
| `--librespot-path <PATH>`       | `librespot_path`    | librespot binary                                          |
| `--librespot-name <NAME>`       | `librespot_name`    | Spotify Connect device name                               |
| `--librespot-bitrate <KBPS>`    | `librespot_bitrate` | `96`, `160` or `320`                                      |
| `--librespot-arg <ARG>`         | `librespot_args`    | Extra librespot argument (repeatable / array)             |
| `-c, --config <PATH>`           |                     | Config file (env: `STDINMAN_CONFIG`)                      |
| `-v, --verbose`                 |                     | Debug logging (or `STDINMAN_LOG=debug`)                   |

Settings are taken from CLI flags first, then environment variables, then the config file.

## Config File

The default location is `$XDG_CONFIG_HOME/stdinman/stdinman.toml` (usually `~/.config/stdinman/stdinman.toml`), the same as the original stdinman. The file is created with owner-only permissions the first time you run stdinman, or when you run `stdinman config init`.

```toml
bot_token = ""
voice_channel_id = "123456789012345678"   # quote it
bot_activity = "stdinman"
audio_source = "stdin"
audio_device = ""
input_format = "f32le"
volume = 1
opus_bitrate = 0
ffmpeg_path = "ffmpeg"
parec_path = "parec"
pactl_path = "pactl"
librespot_path = "librespot"
librespot_name = "stdinman_connect"
librespot_bitrate = 320
librespot_args = []
```

Invalid values are reported as errors. Unknown keys produce a warning.

## Behavior Notes

- **stdin**: audio that arrives before the bot has joined the channel is dropped, so live streams start in sync. When you pipe a file, use `ffmpeg -re` so it plays in real time. When stdin ends, the bot disconnects and exits.
- **Silence**: gaps in a live source (for example, Spotify paused) are sent as silence. They do not end the session.
- **Reconnection**: voice connection failures are retried with exponential backoff (up to 30 s). The audio source and transcoder keep running, so `librespot` and `parec` are not restarted.
- **Stage channels**: the bot tries to become a speaker. If it cannot, it requests to speak.
- **Exit codes**: `0` for a normal end, `1` for runtime errors, `2` for usage or config errors.

## Development

```bash
bun install
bun run check   # typecheck
bun test        # unit + ffmpeg integration tests (the latter are skipped without ffmpeg)
bun run build   # bundle to dist/stdinman.js
bun run dev -- --help
```

Code layout:

- `ts/stdinman.ts`: entry point and command dispatch
- `ts/cli.ts`: argument parsing, settings resolution, help text
- `ts/config.ts`: config file handling and validation
- `ts/sources.ts`: audio sources and the ffmpeg Opus transcoder
- `ts/devices.ts`: device listing for PulseAudio/PipeWire and DirectShow
- `ts/stream.ts`: Discord client, voice connection, and reconnect logic
- `ts/doctor.ts`: `stdinman doctor`

CI runs the typecheck, tests, and build on Linux, macOS and Windows. To release, bump `version` in `package.json`, update `CHANGELOG.md`, and push a `vX.Y.Z` tag. The release workflow attaches the npm tarball to a GitHub release.

Publishing to npm uses [trusted publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC), so no npm token is stored in the repository. To enable it:

1. Publish the first version manually (`npm login && npm publish --access public`), because a trusted publisher can only be configured for a package that already exists.
2. On npmjs.com, open the package settings and add a trusted publisher: GitHub Actions, repository `tionis/stdinman.ts`, workflow `release.yml`.
3. Set the repository variable `NPM_PUBLISH` to `true` (Settings → Secrets and variables → Actions → Variables).

## Attribution

- Original project and concept: [`ckcr4lyf/stdinman`](https://github.com/ckcr4lyf/stdinman)
- This repository: standalone TypeScript continuation maintained by `tionis.dev`

## License

This project uses the same WTFPL license as the original project. See `LICENSE`.
