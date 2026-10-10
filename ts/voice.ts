import {
  type AudioPlayer,
  type VoiceConnection,
  VoiceConnectionDisconnectReason,
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
} from "@discordjs/voice";
import {
  ChannelType,
  type Client,
  DiscordAPIError,
  Events,
  type GuildBasedChannel,
  PermissionFlagsBits,
  type User,
  type VoiceState,
} from "discord.js";
import { EventEmitter } from "node:events";
import { debug, describeError, error, info, isDebugEnabled, warn } from "./log.ts";

const VOICE_READY_TIMEOUT_MS = 30_000;
const VOICE_RECONNECT_GRACE_MS = 5_000;
const VOICE_RECONNECT_INITIAL_DELAY_MS = 1_000;
const VOICE_RECONNECT_MAX_DELAY_MS = 30_000;

/** Delay before reconnect attempt `attempt` (1-based): immediate, then exponential backoff. */
export function reconnectDelayMs(attempt: number): number {
  if (attempt <= 1) {
    return 0;
  }

  return Math.min(VOICE_RECONNECT_INITIAL_DELAY_MS * 2 ** (attempt - 2), VOICE_RECONNECT_MAX_DELAY_MS);
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

export type VoiceTargetChannel = GuildBasedChannel & {
  type: ChannelType.GuildVoice | ChannelType.GuildStageVoice;
};

export function isVoiceTargetChannel(channel: unknown): channel is VoiceTargetChannel {
  if (!channel || typeof channel !== "object" || !("type" in channel)) {
    return false;
  }

  return channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice;
}

export async function waitForReady(client: Client): Promise<void> {
  if (client.isReady()) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const onReady = (): void => {
      cleanup();
      resolve();
    };

    const onError = (clientError: Error): void => {
      cleanup();
      reject(clientError);
    };

    const cleanup = (): void => {
      client.off(Events.ClientReady, onReady);
      client.off(Events.Error, onError);
    };

    client.once(Events.ClientReady, onReady);
    client.once(Events.Error, onError);
  });
}

/** Names of the voice permissions the bot lacks in `channel` (empty if it can join and speak). */
function missingVoicePermissions(channel: VoiceTargetChannel): string[] {
  const me = channel.guild.members.me;
  if (!me) {
    return [];
  }

  const permissions = channel.permissionsFor(me);
  const missing: string[] = (
    [
      ["View Channel", PermissionFlagsBits.ViewChannel],
      ["Connect", PermissionFlagsBits.Connect],
      ["Speak", PermissionFlagsBits.Speak],
    ] as const
  )
    .filter(([, flag]) => !permissions.has(flag))
    .map(([name]) => name);

  if (channel.full && !permissions.has(PermissionFlagsBits.MoveMembers)) {
    missing.push("a free slot (the channel is full)");
  }

  return missing;
}

async function fetchVoiceChannel(client: Client, voiceChannelId: string): Promise<VoiceTargetChannel> {
  let channel: unknown;
  try {
    channel = await client.channels.fetch(voiceChannelId);
  } catch (fetchError) {
    if (fetchError instanceof DiscordAPIError && (fetchError.code === 10003 || fetchError.code === 50001)) {
      throw new Error(
        `cannot access channel ${voiceChannelId}: ${fetchError.message}. Check the ID and make sure the bot was added to that server and can view the channel.`,
      );
    }

    throw fetchError;
  }

  if (!channel) {
    throw new Error(`failed to find voice channel ${voiceChannelId}`);
  }

  if (!isVoiceTargetChannel(channel)) {
    throw new Error(`channel ${voiceChannelId} is not a voice or stage channel`);
  }

  await channel.guild.members.fetchMe();
  const missing = missingVoicePermissions(channel);
  if (missing.length > 0) {
    throw new Error(`the bot is missing permissions in channel ${channel.name}: ${missing.join(", ")}`);
  }

  return channel;
}

async function fetchFollowedUser(client: Client, userId: string): Promise<User> {
  try {
    return await client.users.fetch(userId);
  } catch (fetchError) {
    if (fetchError instanceof DiscordAPIError && fetchError.code === 10013) {
      throw new Error(`unknown Discord user ${userId}`);
    }

    throw fetchError;
  }
}

function findUserVoiceChannel(client: Client, userId: string): VoiceTargetChannel | undefined {
  for (const guild of client.guilds.cache.values()) {
    const channel = guild.voiceStates.cache.get(userId)?.channel;
    if (isVoiceTargetChannel(channel)) {
      return channel;
    }
  }

  return undefined;
}

async function promoteStageSpeaker(channel: GuildBasedChannel): Promise<void> {
  if (channel.type !== ChannelType.GuildStageVoice) {
    return;
  }

  const me = await channel.guild.members.fetchMe();

  try {
    await me.voice.setSuppressed(false);
    info("unsuppressed bot in stage channel");
  } catch (unsuppressError) {
    warn(`failed to unsuppress the bot in the stage channel: ${describeError(unsuppressError)}. trying request-to-speak instead`);

    try {
      await me.voice.setRequestToSpeak(true);
      info("requested to speak in stage channel");
    } catch (requestError) {
      warn(`failed to request speaking privileges in the stage channel: ${describeError(requestError)}`);
    }
  }
}

function describeVoiceDisconnectedState(connection: VoiceConnection): string {
  const state = connection.state;
  if (state.status !== VoiceConnectionStatus.Disconnected) {
    return state.status;
  }

  switch (state.reason) {
    case VoiceConnectionDisconnectReason.WebSocketClose:
      return `websocket close ${state.closeCode}`;
    case VoiceConnectionDisconnectReason.AdapterUnavailable:
      return "adapter unavailable";
    case VoiceConnectionDisconnectReason.EndpointRemoved:
      return "endpoint removed";
    case VoiceConnectionDisconnectReason.Manual:
      return "manual disconnect";
  }

  return "unknown disconnect";
}


/** Where the bot should be: nowhere, a fixed channel, or wherever a user is. */
export type VoiceTarget = { kind: "none" } | { kind: "channel"; channelId: string } | { kind: "follow"; userId: string };

export type VoiceStatus = {
  target: VoiceTarget;
  followedUser?: string;
  /** The channel the target currently points at, whether or not the bot is wanted there. */
  desired?: { id: string; name: string; guild: string };
  wanted: boolean;
  connected?: { id: string; name: string; guild: string; status: string };
};

const describeChannel = (channel: VoiceTargetChannel) => ({ id: channel.id, name: channel.name, guild: channel.guild.name });

/**
 * Keeps the bot in the right voice channel: resolves the target (fixed channel or
 * followed user), joins when `wanted`, moves along with a followed user, leaves when
 * no longer wanted, and reconnects with backoff when the connection drops.
 */
export class VoiceManager extends EventEmitter<{ connected: [VoiceTargetChannel] }> {
  private target: VoiceTarget = { kind: "none" };
  private followedUser: User | undefined;
  private desired: VoiceTargetChannel | undefined;
  private wanted = false;
  /** The channel the connection is (or should be) in: `desired` while wanted. */
  private current: VoiceTargetChannel | undefined;
  private connection: VoiceConnection | undefined;
  private reconnecting: Promise<void> | undefined;
  private destroyed = false;
  private readonly handled = new WeakSet<VoiceConnection>();
  private readonly intentionallyDestroyed = new WeakSet<VoiceConnection>();

  constructor(
    private readonly client: Client,
    private readonly player: AudioPlayer,
  ) {
    super();
    client.on(Events.VoiceStateUpdate, (oldState, newState) => this.onVoiceStateUpdate(oldState, newState));
  }

  /** Validates and applies a new target. Throws if the channel or user cannot be used. */
  async setTarget(target: VoiceTarget): Promise<void> {
    switch (target.kind) {
      case "none":
        this.followedUser = undefined;
        this.target = target;
        this.setDesired(undefined, "no voice target");
        return;
      case "channel": {
        const channel = await fetchVoiceChannel(this.client, target.channelId);
        this.followedUser = undefined;
        this.target = target;
        this.setDesired(channel, "configured channel");
        return;
      }
      case "follow": {
        const user = await fetchFollowedUser(this.client, target.userId);
        this.followedUser = user;
        this.target = target;
        const channel = findUserVoiceChannel(this.client, target.userId);
        if (!channel) {
          info(`waiting for ${user.username} to join a voice channel the bot can see`);
        }
        this.setDesired(channel, `following ${user.username}`);
        return;
      }
    }
  }

  /** Whether the bot should be in the desired channel at all (join rules, manual overrides). */
  setWanted(wanted: boolean, reason: string): void {
    if (wanted === this.wanted) {
      return;
    }

    this.wanted = wanted;
    this.apply(reason);
  }

  status(): VoiceStatus {
    const state = this.connection?.state.status;
    return {
      target: this.target,
      followedUser: this.followedUser?.username,
      desired: this.desired ? describeChannel(this.desired) : undefined,
      wanted: this.wanted,
      connected:
        this.current && this.connection && state !== VoiceConnectionStatus.Destroyed
          ? { ...describeChannel(this.current), status: state ?? "unknown" }
          : undefined,
    };
  }

  destroy(): void {
    this.destroyed = true;
    this.current = undefined;
    this.leaveVoice();
  }

  private onVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): void {
    if (this.target.kind !== "follow" || newState.id !== this.target.userId || oldState.channelId === newState.channelId) {
      return;
    }

    const channel = isVoiceTargetChannel(newState.channel) ? newState.channel : undefined;
    // When switching servers, the "left" event for the old server can arrive after the "joined" event.
    if (!channel && this.desired && this.desired.guild.id !== newState.guild.id) {
      return;
    }

    const name = this.followedUser?.username ?? newState.id;
    this.setDesired(channel, channel ? `${name} joined it` : `${name} left voice`);
  }

  private setDesired(channel: VoiceTargetChannel | undefined, reason: string): void {
    if (channel) {
      const missing = missingVoicePermissions(channel);
      if (missing.length > 0) {
        warn(`cannot join "${channel.name}": the bot is missing ${missing.join(", ")}`);
        channel = undefined;
      }
    }

    this.desired = channel;
    this.apply(reason);
  }

  /** Moves the connection to `desired` if wanted, or out of voice otherwise. */
  private apply(reason: string): void {
    if (this.destroyed) {
      return;
    }

    const next = this.wanted ? this.desired : undefined;
    if (next?.id === this.current?.id) {
      return;
    }

    this.current = next;
    if (!next) {
      if (this.connection) {
        info(`leaving voice (${reason})`);
        this.leaveVoice();
      }
      return;
    }

    info(`${this.connection ? "moving" : "connecting"} to "${next.name}" in "${next.guild.name}" (${reason})`);
    void this.ensureConnection(reason);
  }

  private leaveVoice(): void {
    const connection = this.connection;
    if (!connection) {
      return;
    }

    this.intentionallyDestroyed.add(connection);
    try {
      connection.destroy();
    } catch (destroyError) {
      debug(`failed to destroy voice connection: ${describeError(destroyError)}`);
    }
    this.connection = undefined;
  }

  private attachHandlers(connection: VoiceConnection): void {
    if (this.handled.has(connection)) {
      return;
    }

    this.handled.add(connection);
    connection.on("debug", (message) => debug(`[voice] ${message}`));
    connection.on("error", (connectionError) => error(`[voice] ${connectionError.stack ?? connectionError}`));

    connection.on(VoiceConnectionStatus.Disconnected, () => {
      if (this.destroyed || this.reconnecting || !this.current || connection !== this.connection) {
        return;
      }

      warn(`voice connection disconnected (${describeVoiceDisconnectedState(connection)}); attempting recovery`);
      void this.ensureConnection("voice disconnect");
    });

    connection.on(VoiceConnectionStatus.Destroyed, () => {
      if (this.destroyed || this.intentionallyDestroyed.has(connection) || connection !== this.connection) {
        return;
      }

      this.connection = undefined;
      if (this.current && !this.reconnecting) {
        warn("voice connection was destroyed; attempting to create a fresh connection");
        void this.ensureConnection("voice destroyed");
      }
    });
  }

  private rejoin(existing: VoiceConnection, channel: VoiceTargetChannel): void {
    existing.rejoin({ channelId: channel.id, selfDeaf: true, selfMute: false });
  }

  /** Points the existing connection at `channel` (same guild) or creates a new one. */
  private async connectTo(channel: VoiceTargetChannel): Promise<VoiceConnection> {
    const existing = this.connection;
    if (
      existing &&
      existing.state.status !== VoiceConnectionStatus.Destroyed &&
      existing.joinConfig.guildId === channel.guild.id
    ) {
      if (existing.state.status === VoiceConnectionStatus.Disconnected) {
        if (
          existing.state.reason === VoiceConnectionDisconnectReason.WebSocketClose &&
          existing.state.closeCode === 4014 &&
          existing.joinConfig.channelId === channel.id
        ) {
          // 4014 can mean "moved to another channel"; give Discord a moment to reconnect on its own.
          try {
            await Promise.race([
              entersState(existing, VoiceConnectionStatus.Signalling, VOICE_RECONNECT_GRACE_MS),
              entersState(existing, VoiceConnectionStatus.Connecting, VOICE_RECONNECT_GRACE_MS),
              entersState(existing, VoiceConnectionStatus.Ready, VOICE_RECONNECT_GRACE_MS),
            ]);
          } catch {
            this.rejoin(existing, channel);
          }
        } else {
          this.rejoin(existing, channel);
        }
      } else if (existing.joinConfig.channelId !== channel.id) {
        this.rejoin(existing, channel);
      }

      return existing;
    }

    if (existing) {
      this.leaveVoice();
    }

    const connection = joinVoiceChannel({
      adapterCreator: channel.guild.voiceAdapterCreator,
      channelId: channel.id,
      daveEncryption: true,
      debug: isDebugEnabled(),
      guildId: channel.guild.id,
      selfDeaf: true,
      selfMute: false,
    });
    this.connection = connection;
    this.attachHandlers(connection);
    return connection;
  }

  /** Connects to the current channel, retrying with backoff until it is reached or no longer wanted. */
  private ensureConnection(trigger: string): Promise<void> {
    if (this.reconnecting) {
      return this.reconnecting;
    }

    this.reconnecting = (async () => {
      let attempt = 0;

      while (!this.destroyed && this.current) {
        attempt++;
        const channel = this.current;

        const delayMs = reconnectDelayMs(attempt);
        if (delayMs > 0) {
          warn(`voice connection attempt ${attempt} in ${delayMs}ms (${trigger})`);
          await sleep(delayMs);
          if (this.destroyed || this.current !== channel) {
            attempt = 0;
            continue;
          }
        }

        try {
          const connection = await this.connectTo(channel);
          await entersState(connection, VoiceConnectionStatus.Ready, VOICE_READY_TIMEOUT_MS);
          if (this.current !== channel) {
            // The target changed while connecting; go again for the new one.
            attempt = 0;
            continue;
          }

          if (!connection.subscribe(this.player)) {
            throw new Error("failed to subscribe the audio player to the voice connection");
          }

          await promoteStageSpeaker(channel);
          info(
            attempt === 1
              ? `joined "${channel.name}" in "${channel.guild.name}"`
              : `voice connection to "${channel.name}" recovered after ${attempt} attempt(s)`,
          );
          this.emit("connected", channel);
          return;
        } catch (connectError) {
          if (this.current !== channel) {
            attempt = 0;
            continue;
          }

          warn(`voice connection attempt ${attempt} failed: ${describeError(connectError)}`);
          if (this.connection?.state.status === VoiceConnectionStatus.Destroyed) {
            this.connection = undefined;
          }
        }
      }
    })().finally(() => {
      this.reconnecting = undefined;
    });

    return this.reconnecting;
  }
}
