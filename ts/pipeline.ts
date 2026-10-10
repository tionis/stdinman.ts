import { type AudioPlayer, type AudioResource, StreamType, createAudioResource } from "@discordjs/voice";
import { EventEmitter } from "node:events";
import type { Settings } from "./cli.ts";
import { debug, info, warn } from "./log.ts";
import { createMediaSource, expandInputs } from "./media.ts";
import { createPacer } from "./pacer.ts";
import { createPipeWireSource, resolvePipeWireTarget } from "./pipewire.ts";
import {
  type PreparedAudioSource,
  createAvfoundationSource,
  createCommandSource,
  createFfmpegOpusStream,
  createPulseMonitorSource,
  createSwitchingStdinStream,
  createWindowsDshowSource,
  pcmLayout,
} from "./sources.ts";
import { createSpotifySource, formatLibrespotName } from "./spotify.ts";
import { createWindowsLoopbackSource } from "./windows-loopback.ts";

const LEVEL_ACTIVITY_INTERVAL_MS = 1_000;

export async function createAudioSource(settings: Settings, botName: string): Promise<PreparedAudioSource> {
  switch (settings.audioSource) {
    case "spotify":
      return createSpotifySource({
        ...settings,
        librespotName: formatLibrespotName(settings.librespotName, botName),
      });
    case "pulse-monitor":
      return createPulseMonitorSource(settings);
    case "pipewire":
      return createPipeWireSource({
        pwRecordPath: settings.pwRecordPath,
        target: await resolvePipeWireTarget(settings.audioDevice),
      });
    case "windows-dshow":
      return createWindowsDshowSource(settings);
    case "windows-loopback":
      return createWindowsLoopbackSource(settings);
    case "macos-avfoundation":
      return createAvfoundationSource(settings);
    case "media": {
      const inputs = await expandInputs(settings.inputs);
      if (inputs.length === 0) {
        throw new Error("no playable audio files were found in the given inputs");
      }

      return createMediaSource({ ffmpegPath: settings.ffmpegPath, inputs, loop: settings.loop });
    }
    case "command":
      return createCommandSource(settings);
    case "stdin":
      return createSwitchingStdinStream(settings);
  }
}

export type PipelineEvents = {
  /** The source ended normally (stdin EOF, playlist finished, command exited cleanly). */
  ended: [];
  failed: [error: Error];
  /**
   * Activity reports. `state` reports (Spotify playing/paused, a running source) hold until the
   * next report; pulses (audio above the silence threshold) count as activity at that moment.
   */
  activity: [active: boolean, kind: "state" | "pulse"];
  nowPlaying: [title: string | null];
};

export type PipelineOptions = {
  /** Linear volume, read continuously. */
  gain: () => number;
  /** Peak level (0..1) above which a capture source counts as active. */
  silenceThreshold: () => number;
};

/**
 * One running audio chain: source → pacer (gain, levels) → ffmpeg Opus encoder →
 * Discord audio resource, played by a player that outlives it. `start` replaces
 * any running chain, so sources can be switched without leaving the channel.
 */
export class AudioPipeline extends EventEmitter<PipelineEvents> {
  private source: PreparedAudioSource | undefined;
  private sourceSettings: Settings | undefined;
  private resource: AudioResource<null> | undefined;
  private stopTranscoder: (() => void) | undefined;
  private generation = 0;

  constructor(
    private readonly player: AudioPlayer,
    private readonly options: PipelineOptions,
  ) {
    super();
  }

  get running(): boolean {
    return this.source !== undefined;
  }

  get settings(): Settings | undefined {
    return this.sourceSettings;
  }

  get continuous(): boolean {
    return this.source?.continuous ?? false;
  }

  /** Called by the owner for every player Idle transition with the resource that stopped. */
  handleIdle(resource: AudioResource | undefined): void {
    if (resource && resource === this.resource) {
      info("audio input ended");
      this.stop();
      this.emit("ended");
    }
  }

  async start(settings: Settings, botName: string): Promise<void> {
    this.stop();
    const generation = ++this.generation;
    const current = (): boolean => generation === this.generation;

    const source = await createAudioSource(settings, botName);
    if (!current()) {
      source.stop();
      return;
    }

    this.source = source;
    this.sourceSettings = settings;

    const fail = (failure: Error): void => {
      if (current()) {
        this.stop();
        this.emit("failed", failure);
      }
    };

    source.stream.on("error", (sourceError) => fail(new Error(`[source] ${sourceError.message}`)));
    source.nowPlaying?.on("change", (title) => current() && this.emit("nowPlaying", title));

    switch (source.activity) {
      case "events":
        source.activityEvents?.on("change", (active) => current() && this.emit("activity", active, "state"));
        break;
      case "running":
        this.emit("activity", true, "state");
        break;
      case "level":
        break;
    }

    let lastLevelActivity = 0;
    const transcoderInput = source.pacing
      ? createPacer(source.stream, {
          mode: source.pacing,
          layout: pcmLayout(source.ffmpegInput),
          playedMs: () => (current() ? (this.resource?.playbackDuration ?? 0) : 0),
          gain: this.options.gain,
          onLevel: (peak) => {
            const now = Date.now();
            if (
              source.activity === "level" &&
              peak > this.options.silenceThreshold() &&
              now - lastLevelActivity >= LEVEL_ACTIVITY_INTERVAL_MS &&
              current()
            ) {
              lastLevelActivity = now;
              this.emit("activity", true, "pulse");
            }
          },
          onDrop: (droppedMs) => {
            // Early drops discard audio captured while the encoder and playback were starting.
            const log = (this.resource?.playbackDuration ?? 0) < 5_000 ? debug : info;
            log(`dropped ${Math.round(droppedMs)} ms of audio to keep latency low (the capture device's clock runs ahead)`);
          },
          onUnpaced: (reason) => warn(`cannot pace the audio input (${reason}); latency and volume control are unavailable`),
        })
      : source.stream;

    info(source.startupMessage);
    const transcoder = createFfmpegOpusStream(settings.ffmpegPath, transcoderInput, source.ffmpegInput, {
      opusBitrate: settings.opusBitrate,
      audioFilter: settings.audioFilter,
    });
    this.stopTranscoder = transcoder.stop;
    transcoder.events.on("error", (transcoderError) => fail(transcoderError));

    this.resource = createAudioResource(transcoder.stream, { inputType: StreamType.OggOpus, metadata: null });
    this.player.play(this.resource);
    source.start();
  }

  stop(): void {
    this.generation++;
    const source = this.source;
    const stopTranscoder = this.stopTranscoder;
    const hadResource = this.resource !== undefined;
    this.source = undefined;
    this.sourceSettings = undefined;
    this.resource = undefined;
    this.stopTranscoder = undefined;

    try {
      stopTranscoder?.();
    } catch (transcoderError) {
      debug(`failed to stop ffmpeg transcoder cleanly: ${String(transcoderError)}`);
    }

    try {
      source?.stop();
    } catch (sourceError) {
      debug(`failed to stop audio source cleanly: ${String(sourceError)}`);
    }

    if (hadResource) {
      this.player.stop(true);
      this.emit("nowPlaying", null);
    }
  }
}
