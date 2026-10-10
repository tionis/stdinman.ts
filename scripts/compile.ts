// Builds a standalone stdinman executable with `bun build --compile`.
// Usage: bun scripts/compile.ts [outfile]
// Native modules (the DAVE library) are embedded for the platform this runs on,
// so each platform's binary has to be built on that platform.

// Optional dependencies that discord.js / @discordjs/voice / prism-media probe for at
// runtime and handle being absent. Bundling would fail on them since they are not installed.
const OPTIONAL_DEPENDENCIES = [
  "@discordjs/opus",
  "@noble/ciphers",
  "@stablelib/xchacha20poly1305",
  "bufferutil",
  "ffmpeg-static",
  "libsodium-wrappers",
  "node-opus",
  "opusscript",
  "sodium",
  "sodium-native",
  "tweetnacl",
  "utf-8-validate",
  "zlib-sync",
];

const defaultName = process.platform === "win32" ? "stdinman.exe" : "stdinman";
const outfile = process.argv[2] ?? `dist/bin/${defaultName}`;

const result = Bun.spawnSync(
  [
    process.execPath,
    "build",
    "./ts/stdinman.ts",
    "--compile",
    "--minify",
    ...OPTIONAL_DEPENDENCIES.flatMap((name) => ["--external", name]),
    "--outfile",
    outfile,
  ],
  { stdout: "inherit", stderr: "inherit" },
);

process.exit(result.exitCode ?? 1);
