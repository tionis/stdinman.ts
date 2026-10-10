# stdinman.ts

[![CI](https://github.com/tionis/stdinman.ts/actions/workflows/ci.yml/badge.svg)](https://github.com/tionis/stdinman.ts/actions/workflows/ci.yml)

`stdinman.ts` streams audio into a Discord voice or stage channel through a bot.

It is a TypeScript reimplementation inspired by [`ckcr4lyf/stdinman`](https://github.com/ckcr4lyf/stdinman), a small Rust tool that pipes audio from stdin into Discord. `stdinman.ts` keeps that core idea and the same config file location. It adds support for Discord's DAVE end-to-end encryption, and goes beyond stdin with built-in sources for Spotify, PulseAudio/PipeWire and Windows audio devices. More sources may follow.

Authors:
- `tionis.dev`
- `ckcr4lyf` (original Rust `stdinman`)

## What It Does

`stdinman.ts` connects a Discord bot to a voice channel and streams audio from this computer. It is not an interactive Discord bot: there are no slash commands, and everything is controlled locally from the command line.

| Source               | Platform | What it plays                                                          |
| -------------------- | -------- | ---------------------------------------------------------------------- |
| `stdin`              | any      | Raw PCM or WAV piped into standard input (default)                     |
| `command`            | any      | Raw PCM or WAV written to stdout by a command you give                 |
| `media`              | any      | Files, directories and URLs (internet radio, HTTP streams), via ffmpeg |
| `spotify`            | any      | A Spotify Connect device provided by `librespot`                       |
| `pipewire`           | Linux    | A PipeWire output, input, or a single application, via `pw-record`     |
| `pulse-monitor`      | Linux    | A PulseAudio / PipeWire source or monitor, via `parec`                 |
| `windows-loopback`   | Windows  | Whatever a Windows output device plays (no virtual cable needed)       |
| `windows-dshow`      | Windows  | A DirectShow capture device, via `ffmpeg`                              |
| `macos-avfoundation` | macOS    | An AVFoundation audio device (e.g. BlackHole), via `ffmpeg`            |

It uses `discord.js` and `@discordjs/voice` with DAVE support, so it can join Discord voice channels that require end-to-end encryption. The bot can stay in one channel, or follow a user from channel to channel. It can also show the current track (for Spotify and media) as its activity. If the voice connection drops, it reconnects with backoff and keeps the audio source running.

## Requirements

- `ffmpeg` with `libopus` support
- Node.js `22.12.0` or newer, unless you use a standalone binary
- [Bun](https://bun.sh/) only if you build from source

Depending on the source:

- `spotify`: `librespot`
- `pipewire`: `pw-record` and `pw-dump` (usually in `pipewire-bin` / `pipewire-tools`)
- `pulse-monitor`: `parec` and `pactl` (e.g. `pulseaudio-utils`)
- `windows-loopback`: Windows PowerShell, which ships with Windows. The capture helper is compiled on first use, which adds a second or two to startup.

Run `stdinman doctor` to check your setup.

## Installation

**Standalone binary**: download `stdinman-<platform>` from [GitHub Releases](https://github.com/tionis/stdinman.ts/releases) (Linux x64/arm64, macOS arm64, Windows x64), make it executable and put it on your `PATH`. It needs no Node.js install, but ffmpeg is still required. Checksums are in `SHA256SUMS`.

```bash
curl -Lo stdinman https://github.com/tionis/stdinman.ts/releases/latest/download/stdinman-linux-x64
chmod +x stdinman && ./stdinman --help
```

On macOS, browsers quarantine downloaded binaries. Clear it with `xattr -d com.apple.quarantine stdinman`, or download with `curl` as above.

**npm** (needs Node.js):

```bash
npm install -g stdinman.ts
stdinman --help
```

**From source**:

```bash
bun install
bun run build     # dist/stdinman.js, run with node
bun run compile   # dist/bin/stdinman, standalone binary for this platform
```

## Discord Setup

1. Create an application and bot in the [Discord Developer Portal](https://discord.com/developers/applications) and copy the bot token.
2. Invite the bot to your server with the `View Channels`, `Connect` and `Speak` permissions.
3. In Discord, turn on Developer Mode (Settings → Advanced). Then right-click the voice channel and choose **Copy Channel ID**, or right-click a user and choose **Copy User ID** for follow mode.

## Quick Start

```bash
stdinman config init          # creates the config file
$EDITOR "$(stdinman config path)"   # set bot_token and voice_channel_id (or follow_user_id)
stdinman doctor               # check that everything is in place
```

Then pick a source:

```bash
# Files, folders, playlists and streams
stdinman -s media -i ~/Music/album -i https://radio.example/stream.mp3 --loop

# Anything that can write PCM to stdout
ffmpeg -re -i song.mp3 -f f32le -ar 48000 -ac 2 - | stdinman
stdinman -s command --command "arecord -f S16_LE -r 48000 -c 2 -t raw" --input-format s16le

# Spotify Connect: start playback on the "discord: <bot name>" device
stdinman --spotify

# Linux: stream what your speakers play, or only one application
stdinman -s pipewire
stdinman devices list -s pipewire
stdinman -s pipewire -d Firefox
```

```powershell
# Windows: stream what your speakers play, or a specific output device
stdinman -s windows-loopback
stdinman devices list -s windows-loopback
stdinman -s windows-loopback -d "Headphones"
```

```bash
# macOS: route audio into a loopback device such as BlackHole, then capture it
stdinman devices list
stdinman -s macos-avfoundation -d "BlackHole 2ch"
```

## Follow Mode

With `--follow-user <USER_ID>` (or `follow_user_id` in the config), the bot follows one user instead of staying in a fixed channel:

- it joins the voice channel that user is in, in any server the bot is in;
- it moves along when they switch channels or servers;
- it leaves when they leave voice, and joins again when they come back.

Streaming starts the first time the bot joins. After that, live sources keep running while the bot is out of voice, and that audio is simply not sent. The `media` source pauses instead and continues where it left off. Channels where the bot lacks permissions are skipped, with a warning.

## Now Playing

By default, the bot's activity shows what is playing ("Listening to …"):

- **spotify**: the current track and artists, from librespot's event hook. It is cleared while playback is paused. If you pass your own `--onevent` via `--librespot-arg`, stdinman leaves it alone and shows no track info.
- **media**: the title/artist tags or ICY stream title of each input, or else the file name.

Turn it off with `--no-now-playing` or `now_playing = false`. Then, and for sources without track information, the bot shows `bot_activity`.

## Commands

```text
stdinman [OPTIONS]                 Join the voice channel and start streaming
stdinman devices list [--source S] List capture devices for a source
stdinman doctor [OPTIONS]          Check config and external tools
stdinman config path               Print the config file location
stdinman config init               Create the config file if it does not exist
```

## Options

| Option                       | Config key          | Description                                                          |
| ---------------------------- | ------------------- | -------------------------------------------------------------------- |
| `--bot-token <TOKEN>`        | `bot_token`         | Discord bot token (env: `STDINMAN_BOT_TOKEN`)                        |
| `--voice-channel-id <ID>`    | `voice_channel_id`  | Voice/stage channel to join (env: `STDINMAN_VOICE_CHANNEL_ID`)       |
| `--follow-user <ID>`         | `follow_user_id`    | Follow this user instead (env: `STDINMAN_FOLLOW_USER_ID`)            |
| `--bot-activity <TEXT>`      | `bot_activity`      | Activity shown when nothing else is                                  |
| `--[no-]now-playing`         | `now_playing`       | Show the current track as the activity (default on)                  |
| `-s, --source <SOURCE>`      | `audio_source`      | One of the sources above (default `stdin`)                           |
| `--spotify`                  |                     | Same as `--source spotify`                                           |
| `-d, --audio-device <NAME>`  | `audio_device`      | Device to capture; for `pipewire` also an application name           |
| `-i, --input <PATH\|URL>`    | `inputs`            | `media` input: file, directory or URL (repeatable / array)           |
| `--loop`                     | `loop`              | Repeat the `media` inputs                                            |
| `--command <CMDLINE>`        | `command`           | `command` source command line, run through the shell                 |
| `--input-format <FORMAT>`    | `input_format`      | stdin/command format: `f32le`, `s16le`, `s32le` or `wav`             |
| `--sample-rate <HZ>`         | `sample_rate`       | stdin/command sample rate (default 48000)                            |
| `--channels <N>`             | `channels`          | stdin/command channel count (default 2)                              |
| `--volume <FACTOR>`          | `volume`            | Volume multiplier, 0–10 (default 1)                                  |
| `--opus-bitrate <KBPS>`      | `opus_bitrate`      | Opus bitrate in kbit/s, 6–510 (0 = encoder default)                  |
| `--librespot-path <PATH>`    | `librespot_path`    | librespot binary                                                     |
| `--librespot-name <NAME>`    | `librespot_name`    | Spotify Connect device name; `{bot}` is the bot's name (default `discord: {bot}`) |
| `--librespot-bitrate <KBPS>` | `librespot_bitrate` | `96`, `160` or `320`                                                 |
| `--librespot-arg <ARG>`      | `librespot_args`    | Extra librespot argument (repeatable / array)                        |
| `--ffmpeg-path <PATH>`       | `ffmpeg_path`       | ffmpeg binary                                                        |
| `--pw-record-path <PATH>`    | `pw_record_path`    | pw-record binary                                                     |
| `--parec-path <PATH>`        | `parec_path`        | parec binary                                                         |
| `--pactl-path <PATH>`        | `pactl_path`        | pactl binary                                                         |
| `--powershell-path <PATH>`   | `powershell_path`   | PowerShell used by `windows-loopback` (default `powershell.exe`)     |
| `-c, --config <PATH>`        |                     | Config file (env: `STDINMAN_CONFIG`)                                 |
| `-v, --verbose`              |                     | Debug logging (or `STDINMAN_LOG=debug`)                              |

Settings are taken from CLI flags first, then environment variables, then the config file. The voice target works the same way: a channel or follow user set at a higher level replaces the other mode set at a lower level.

## Config File

The default location is `$XDG_CONFIG_HOME/stdinman/stdinman.toml` (usually `~/.config/stdinman/stdinman.toml`), the same as the Rust stdinman. The file is created with owner-only permissions the first time you run stdinman, or when you run `stdinman config init`.

```toml
bot_token = ""
voice_channel_id = "123456789012345678"   # quote IDs
follow_user_id = ""                       # set this instead to follow a user
bot_activity = "stdinman"
now_playing = true
audio_source = "media"
audio_device = ""
inputs = ["~/Music/playlist", "https://radio.example/stream.mp3"]
loop = true
command = ""
input_format = "f32le"
sample_rate = 48000
channels = 2
volume = 1
opus_bitrate = 0
librespot_name = "discord: {bot}"        # {bot} = the bot's display name
librespot_bitrate = 320
librespot_args = []
```

Tool paths (`ffmpeg_path`, `pw_record_path`, `parec_path`, `pactl_path`, `powershell_path`, `librespot_path`) can be set too. Invalid values are reported as errors. Unknown keys produce a warning.

## Behavior Notes

- **When streaming starts**: audio streaming starts once the bot first joins a channel. With `stdin`, audio that arrives before that is dropped, so live streams start in sync. When you pipe a file, use `ffmpeg -re` so it plays in real time.
- **When it ends**: when the source ends (stdin EOF, the command exits successfully, the last `media` input finishes without `--loop`), the bot disconnects and exits.
- **Silence**: gaps in a live source (for example, Spotify paused, or nothing playing on Windows) are sent as silence. They do not end the session.
- **PipeWire applications**: `-d <name>` first looks for a device with that name or description. Otherwise it is treated as an application name (e.g. `Firefox`, `spotify`, `mpv`). stdinman waits for that application to play, and re-attaches whenever it starts a new stream.
- **Reconnection**: voice connection failures are retried with exponential backoff (up to 30 s). The audio source and transcoder keep running.
- **Stage channels**: the bot tries to become a speaker. If it cannot, it requests to speak.
- **Exit codes**: `0` for a normal end, `1` for runtime errors, `2` for usage or config errors.

## Development

```bash
bun install
bun run check   # typecheck
bun test        # unit + ffmpeg integration tests (the latter are skipped without ffmpeg)
bun run build   # bundle to dist/stdinman.js
bun run compile # standalone binary in dist/bin/
bun run dev -- --help
```

Code layout:

- `ts/stdinman.ts`: entry point and command dispatch
- `ts/cli.ts`: argument parsing, settings resolution, help text
- `ts/config.ts`: config file handling and validation
- `ts/sources.ts`: shared source plumbing, the simpler sources and the ffmpeg Opus transcoder
- `ts/media.ts`, `ts/spotify.ts`, `ts/pipewire.ts`, `ts/windows-loopback.ts` (+ `.cs` helper): the larger sources
- `ts/devices.ts`: device listing for every source
- `ts/stream.ts`: Discord client, voice target (fixed or follow), reconnect logic, now-playing status
- `ts/doctor.ts`: `stdinman doctor`
- `scripts/compile.ts`: standalone binary build

CI runs the typecheck, tests, the build and a binary smoke test on Linux, macOS and Windows. To release, bump `version` in `package.json`, update `CHANGELOG.md`, and push a `vX.Y.Z` tag. The release workflow builds the binaries on each platform and attaches them, the npm tarball and `SHA256SUMS` to a GitHub release.

Publishing to npm uses [trusted publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC), so no npm token is stored in the repository. To enable it:

1. Publish the first version manually (`npm login && npm publish --access public`), because a trusted publisher can only be configured for a package that already exists.
2. On npmjs.com, open the package settings and add a trusted publisher: GitHub Actions, repository `tionis/stdinman.ts`, workflow `release.yml`.
3. Set the repository variable `NPM_PUBLISH` to `true` (Settings → Secrets and variables → Actions → Variables).

## Attribution

- Original idea and Rust implementation: [`ckcr4lyf/stdinman`](https://github.com/ckcr4lyf/stdinman)
- This TypeScript reimplementation and its additional sources: `tionis.dev`

## License

This project uses the same WTFPL license as the original project. See `LICENSE`.
