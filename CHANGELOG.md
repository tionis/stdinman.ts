# Changelog

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

- Initial standalone TypeScript release, extracted from `ckcr4lyf/stdinman`.
