# Changelog

## Unreleased

### Added

- New sources:
  - `media`: plays files, directories (recursively, in name order) and URLs such as internet radio, with `--loop`. Broken inputs are skipped.
  - `command`: reads PCM or WAV from any command line.
  - `pipewire`: captures the default output, any device, or a single application by name. It re-attaches when the application starts a new stream.
  - `windows-loopback`: captures what a Windows output device plays via WASAPI loopback, with no virtual cable needed. It uses a small C# helper that PowerShell compiles at runtime.
  - `macos-avfoundation`: captures an AVFoundation audio device, such as BlackHole.
- Follow mode (`--follow-user` / `follow_user_id`): the bot joins the user's voice channel, moves with them, leaves when they leave, and rejoins when they come back.
- Now-playing activity for `spotify` (via librespot's `--onevent` hook) and `media` (tags and ICY titles). It can be turned off with `--no-now-playing`.
- Standalone binaries built with `bun build --compile` for Linux x64/arm64, macOS arm64 and Windows x64, attached to GitHub releases with `SHA256SUMS`. Use `bun run compile` to build one locally.
- stdin and the `command` source now accept `s32le` and `wav` input, plus `--sample-rate` and `--channels`.
- `doctor` checks that the DAVE library loads and covers the new sources.
- `--audio-filter` / `audio_filter` adds ffmpeg audio filters (EQ, bass boost, loudness normalization) before encoding.

### Fixed

- Live capture had small audible gaps: audio arrived just in time, so any timing jitter made the player miss 20 ms frames (2–9 per 10 s in measurements). A 150 ms jitter buffer now absorbs this, bringing it to zero in the same measurements.
- Live capture sources (`pipewire`, `pulse-monitor`, `windows-dshow`, `windows-loopback`, `macos-avfoundation`) slowly gained latency: the capture device's clock and the system clock that paces Discord playback never match exactly. A drift guard now drops about 150–250 ms of audio whenever more than 400 ms has built up. With typical clock differences, that happens roughly every 25 minutes to 2 hours.
- `stdin` and `command` are now held to real time as well, so `cat song.raw | stdinman` or a decoder without `-re` plays correctly without reading the whole input into memory. Under Bun, stdin is read through a pull-based file stream, and `command` output through a FIFO.
- Under Bun (`bun run`, and the standalone binaries), Spotify ignored pause and song changes: Bun reads child process output eagerly regardless of backpressure, so librespot decoded at about 100× real time and over an hour of audio queued up in memory. Fast sources (librespot, the media decoder) now write into a FIFO that stdinman reads only as fast as audio is played, on Linux and macOS. On Windows, media decoding runs at native speed instead; Spotify on Windows should run under Node until there is a fix there.
- Pausing, skipping and seeking in Spotify took many seconds to be heard: librespot's pipe backend runs faster than real time, so 13 s (under Node) to several minutes (under Bun / the standalone binary) of audio piled up in pipes and ffmpeg. Spotify and media audio is now released no faster than Discord plays it, which keeps the delay below a second.

- Spotify played quietly and thin: librespot defaulted to 50% volume, which is −30 dB on its log volume curve, with 16-bit dithered output. stdinman now starts it at 100% and uses 32-bit float output. The app's volume slider still works.
- Extra librespot arguments that clash with options stdinman sets itself (name, backend, bitrate, format) are rejected with a clear message. Before, librespot failed on the duplicate option.

- Live sources started streaming after many seconds instead of immediately: ffmpeg probed 5 MB of input first, about 13 s at 48 kHz float and about 30 s for Spotify.
- `pw-record` no longer falls back to a different device when the target is missing.

### Changed

- Streaming now starts once the bot has joined a channel, for every source.
- The Spotify Connect device is named after the bot by default (`discord: {bot}`; `{bot}` is replaced with the bot's display name). Config files created by 0.2.0 contain `librespot_name = "stdinman_connect"` explicitly and keep that name; remove the line to get the new default.
- A capture or command process that exits successfully now ends the stream normally, instead of being reported as an error.

## 0.2.0

### Added

- `stdinman doctor` checks the config, the bot token / channel ID, ffmpeg (including libopus), and the tools the selected source needs.
- `stdinman config path` and `stdinman config init`.
- `--config` / `STDINMAN_CONFIG` to use a different config file.
- `STDINMAN_BOT_TOKEN` and `STDINMAN_VOICE_CHANNEL_ID` environment variables, so the token does not have to be passed on the command line.
- `--volume` / `volume` and `--opus-bitrate` / `opus_bitrate`.
- `-v/--verbose`, `-V/--version`, and short flags `-s`, `-d`, `-c`.
- Unit and integration tests (`bun test`), GitHub Actions CI on Linux/macOS/Windows, a tag-driven release workflow with optional npm trusted publishing (OIDC), and Dependabot.

### Fixed

- Live capture had small audible gaps: audio arrived just in time, so any timing jitter made the player miss 20 ms frames (2–9 per 10 s in measurements). A 150 ms jitter buffer now absorbs this, bringing it to zero in the same measurements.
- Live capture sources (`pipewire`, `pulse-monitor`, `windows-dshow`, `windows-loopback`, `macos-avfoundation`) slowly gained latency: the capture device's clock and the system clock that paces Discord playback never match exactly. A drift guard now drops about 150–250 ms of audio whenever more than 400 ms has built up. With typical clock differences, that happens roughly every 25 minutes to 2 hours.
- `stdin` and `command` are now held to real time as well, so `cat song.raw | stdinman` or a decoder without `-re` plays correctly without reading the whole input into memory. Under Bun, stdin is read through a pull-based file stream, and `command` output through a FIFO.
- Under Bun (`bun run`, and the standalone binaries), Spotify ignored pause and song changes: Bun reads child process output eagerly regardless of backpressure, so librespot decoded at about 100× real time and over an hour of audio queued up in memory. Fast sources (librespot, the media decoder) now write into a FIFO that stdinman reads only as fast as audio is played, on Linux and macOS. On Windows, media decoding runs at native speed instead; Spotify on Windows should run under Node until there is a fix there.
- Pausing, skipping and seeking in Spotify took many seconds to be heard: librespot's pipe backend runs faster than real time, so 13 s (under Node) to several minutes (under Bun / the standalone binary) of audio piled up in pipes and ffmpeg. Spotify and media audio is now released no faster than Discord plays it, which keeps the delay below a second.

- Spotify played quietly and thin: librespot defaulted to 50% volume, which is −30 dB on its log volume curve, with 16-bit dithered output. stdinman now starts it at 100% and uses 32-bit float output. The app's volume slider still works.
- Extra librespot arguments that clash with options stdinman sets itself (name, backend, bitrate, format) are rejected with a clear message. Before, librespot failed on the duplicate option.

- Live sources no longer end playback during short silences: pausing Spotify for more than 100 ms used to make the bot disconnect and exit.
- Ogg pages are now flushed every 20 ms instead of every second, which makes live audio smoother and lowers latency.
- The bot now exits with an error when ffmpeg cannot start or crashes. Before, it kept running without sound, and an EPIPE could crash it with an unhandled error.
- Error messages for crashed child processes (ffmpeg, librespot, parec) now include the last lines they wrote to stderr.
- Invalid `--source`, `--input-format`, `--librespot-bitrate` values, and invalid config values, are now errors. Before, they silently fell back to defaults.
- An unquoted `voice_channel_id` in the config no longer fails to parse.
- The config file is created with owner-only permissions (it contains the bot token).
- The built `dist/stdinman.js` has a Node shebang, so the `stdinman` bin works after `npm install -g`.
- Before joining, the bot checks that it can access the channel and has the View Channel / Connect / Speak permissions, and explains what is missing.
- Running with the `stdin` source and nothing piped in now gives an explanation instead of waiting forever.
- A second Ctrl+C exits immediately, and shutdown no longer hangs if Discord teardown stalls.

### Changed

- Split the single source file into modules under `ts/`.
- Updated discord.js, @discordjs/voice, @snazzah/davey and smol-toml.

## 0.1.0

- Initial TypeScript reimplementation of the Rust [`ckcr4lyf/stdinman`](https://github.com/ckcr4lyf/stdinman), with DAVE support and Spotify, PulseAudio/PipeWire and DirectShow sources.
