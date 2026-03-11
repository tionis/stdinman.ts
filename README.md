# stdinman.ts

`stdinman.ts` is a standalone TypeScript implementation of `stdinman`: a tool that streams audio to a Discord voice channel through a bot.

This project was extracted from the TypeScript/DAVE-capable implementation inside the original [`ckcr4lyf/stdinman`](https://github.com/ckcr4lyf/stdinman) repository. The original project established the idea and shipped the earlier Rust implementation; this repository focuses only on the maintained TypeScript runtime.

Authors:
- `ckcr4lyf`
- `tionis.dev`

## What It Does

`stdinman.ts` connects a Discord bot to a target voice channel and streams audio from one of several source modes:

- `stdin`: read raw PCM from standard input
- `spotify`: spawn `librespot` and stream Spotify Connect audio
- `pulse-monitor`: capture a PulseAudio / PipeWire source via `parec` on Linux
- `windows-dshow`: capture a Windows DirectShow audio device via `ffmpeg`

Internally, the app uses `discord.js` plus `@discordjs/voice` with DAVE support so it can join modern Discord voice channels that require end-to-end encryption.

## Requirements

- Node.js `22.12.0` or newer for runtime
- [Bun](https://bun.sh/) for dependency management and builds
- `ffmpeg`

Depending on the selected source mode, you may also need:

- `librespot` for `--source spotify`
- `parec` and `pactl` for `--source pulse-monitor`
- a DirectShow-capable audio device for `--source windows-dshow`

## Installation

```bash
bun install
bun run build
```

Run the compiled entrypoint with:

```bash
node ./dist/stdinman.js --help
```

## Discord Setup

The bot must:

- be added to the target server
- have the `Connect` and `Speak` voice permissions

You need:

- the bot token
- the target voice channel ID

## Usage

Basic usage:

```bash
node ./dist/stdinman.js --bot-token <BOT_TOKEN> --voice-channel-id <VOICE_CHANNEL_ID>
```

The app keeps compatibility with the original config location:

```text
$XDG_CONFIG_HOME/stdinman/stdinman.toml
```

If the config file does not exist, it will be created automatically.

## Source Modes

`stdin` expects raw PCM on standard input. Default format is `f32le` at 48 kHz stereo.

```bash
ffmpeg -re -i sample.mp3 -map 0:a:0 -c:a:0 pcm_f32le -ar 48000 -ac 2 -f f32le - | node ./dist/stdinman.js
```

`spotify` starts `librespot` internally:

```bash
node ./dist/stdinman.js --source spotify
```

`pulse-monitor` captures a PulseAudio / PipeWire source directly:

```bash
node ./dist/stdinman.js devices list --source pulse-monitor
node ./dist/stdinman.js --source pulse-monitor --audio-device Virtual_Sink.monitor
```

If `pactl` is unavailable or cannot talk to a Pulse/PipeWire session, device listing degrades to a warning and you can still pass `--audio-device` manually.

`windows-dshow` captures a DirectShow audio device:

```powershell
node .\dist\stdinman.js devices list --source windows-dshow
node .\dist\stdinman.js --source windows-dshow --audio-device "CABLE Output (VB-Audio Virtual Cable)"
```

## Useful Options

- `--source <stdin|spotify|pulse-monitor|windows-dshow>`
- `--audio-device <DEVICE_NAME>`
- `--input-format <f32le|s16le>`
- `--ffmpeg-path <PATH>`
- `--parec-path <PATH>`
- `--pactl-path <PATH>`
- `--librespot-path <PATH>`
- `--librespot-name <DEVICE_NAME>`
- `--librespot-bitrate <BITRATE>`
- `--librespot-arg <ARG>` repeatable

## Config Keys

```toml
bot_token = ""
voice_channel_id = ""
bot_activity = "stdinman"
audio_source = "stdin"
audio_device = ""
input_format = "f32le"
ffmpeg_path = "ffmpeg"
parec_path = "parec"
pactl_path = "pactl"
librespot_path = "librespot"
librespot_name = "stdinman_connect"
librespot_bitrate = 320
librespot_args = []
```

## Reconnection Behavior

Voice connection failures are retried internally with backoff. The reconnect logic keeps the active audio source and transcoder alive so ordinary Discord voice disconnects do not force a restart of `librespot`, `parec`, or the stdin pipeline.

## Development

```bash
bun run check
bun run build
```

The main implementation lives in `ts/stdinman.ts`.

## Attribution

- Original project and concept: [`ckcr4lyf/stdinman`](https://github.com/ckcr4lyf/stdinman)
- This repository: standalone TypeScript continuation maintained by `tionis.dev`

## License

This project uses the same WTFPL license as the original project. See `LICENSE`.
