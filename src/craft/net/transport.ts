/**
 * How messages get between players.
 *
 * Online play rides Supabase Realtime broadcast channels — no tables, no
 * migration, nothing stored; a room exists while someone is in it. Two browser
 * tabs on one device can also play together over BroadcastChannel ("this
 * device" in the multiplayer screen), which needs no network at all and is how
 * the multiplayer code is tested.
 *
 * Messages are batched by the session to about eight a second per player —
 * well inside Realtime's per-project rate limits — and anything large (chunk
 * data) is split into parts under the broadcast payload limit.
 */
import { supabase } from "@/integrations/supabase/client";
import type { RealtimeChannel } from "@supabase/supabase-js";

export interface NetMessage {
  t: string;
  /** Sender's client id. */
  from: string;
  /** Recipient; absent means everyone. */
  to?: string;
  [key: string]: unknown;
}

export interface Transport {
  readonly kind: "online" | "device";
  send(msg: NetMessage): void;
  onMessage(cb: (msg: NetMessage) => void): void;
  close(): void;
}

/** Room codes avoid letters that read alike (0/O, 1/I/L). */
export function newRoomCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

export function normalizeRoomCode(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
}

export class DeviceTransport implements Transport {
  readonly kind = "device" as const;
  private channel: BroadcastChannel;
  private handlers: ((msg: NetMessage) => void)[] = [];
  constructor(room: string) {
    if (typeof BroadcastChannel === "undefined") throw new Error("This browser cannot link tabs (no BroadcastChannel). Use online play instead.");
    this.channel = new BroadcastChannel(`blockcraft:${room}`);
    this.channel.onmessage = (e: MessageEvent<NetMessage>) => {
      for (const h of this.handlers) h(e.data);
    };
  }
  send(msg: NetMessage): void {
    this.channel.postMessage(msg);
  }
  onMessage(cb: (msg: NetMessage) => void): void {
    this.handlers.push(cb);
  }
  close(): void {
    this.channel.close();
  }
}

export class OnlineTransport implements Transport {
  readonly kind = "online" as const;
  private channel: RealtimeChannel;
  private handlers: ((msg: NetMessage) => void)[] = [];
  private queue: NetMessage[] = [];
  private live = false;
  readonly ready: Promise<void>;

  constructor(room: string) {
    this.channel = supabase.channel(`blockcraft:${room}`, { config: { broadcast: { self: false, ack: false } } });
    this.channel.on("broadcast", { event: "m" }, ({ payload }) => {
      for (const h of this.handlers) h(payload as NetMessage);
    });
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Could not reach the online server in 12 seconds. Check your connection, or play with tabs on this device.")), 12000);
      this.channel.subscribe((status, err) => {
        if (status === "SUBSCRIBED") {
          clearTimeout(timer);
          this.live = true;
          for (const m of this.queue.splice(0)) this.send(m);
          resolve();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          clearTimeout(timer);
          this.live = false;
          reject(new Error(status === "TIMED_OUT"
            ? "The online server did not answer in time. Try again in a moment."
            : `The online server refused the room (${err?.message ?? status}). Realtime may be switched off for this project.`));
        }
      });
    });
    // A rejected ready promise nobody awaited should not surface as an unhandled rejection.
    this.ready.catch(() => {});
  }

  send(msg: NetMessage): void {
    if (!this.live) { this.queue.push(msg); return; }
    void this.channel.send({ type: "broadcast", event: "m", payload: msg });
  }
  onMessage(cb: (msg: NetMessage) => void): void {
    this.handlers.push(cb);
  }
  close(): void {
    this.live = false;
    void supabase.removeChannel(this.channel);
  }
}

/** Largest single broadcast we send; chunk data above this is split. */
export const MAX_PART = 48 * 1024;

/** A stable id for this browser, so a host can give a returning guest their inventory back. */
export function clientId(): string {
  const key = "blockcraft.client.v1";
  try {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const id = `c${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
    localStorage.setItem(key, id);
    return id;
  } catch {
    return `c${Math.random().toString(36).slice(2, 12)}`;
  }
}
