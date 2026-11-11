import type { CID } from '@hashtree/core';
import type { DBSchema, IDBPDatabase } from 'idb';
import type { Event, EventTemplate } from 'nostr-tools/pure';

export interface Settings {
  pubkey: string;
  archiveName?: string;
  handle: string;
  capture: boolean;
  relaySync: boolean;
  relays: string[];
  blossomServer?: string;
  mediaMiB?: number;
}

export interface Capture {
  id: string;
  author: string;
  time: number;
  timeMs?: number;
  text: string;
  posters?: string[];
}
export interface Entry {
  event: Event;
  source?: string;
  targets?: string[];
  posters?: string[];
}
export interface Delivery {
  id: string;
  relay: string;
  broadcast?: boolean;
  created_at?: number;
}
export interface MediaReference {
  eventId: string;
  url: string;
  mime?: string;
  expected?: string;
  invalidHash: boolean;
  poster: boolean;
  servers: string[];
  fallbacks: string[];
  status: 'pending' | 'saved' | 'unavailable' | 'poster only';
  sha256?: string;
  error?: string;
}
export interface MediaFile {
  sha256: string;
  size: number;
  mime: string;
  cid: { hash: string; key: string };
  blocks: string[];
  copies: string[];
}
export interface IndexPointer {
  hash: string;
  server: string;
  event: Event;
  pending: string[];
  acknowledged: string[];
}
export interface ArchiveSchema extends DBSchema {
  blocks: { key: string; value: Uint8Array };
  meta: { key: string | string[]; value: CID | IndexPointer | number };
  events: { key: string; value: Event; indexes: { created_at: number } };
  drafts: { key: string; value: Capture };
  sources: { key: string; value: string };
  outbox: { key: [string, string]; value: Delivery };
  cursors: {
    key: string[];
    value: { through?: number; started?: number; next?: { until?: number; limit?: number } };
  };
  mediaRefs: { key: [string, string]; value: MediaReference; indexes: { url: string } };
  mediaFiles: { key: string; value: MediaFile };
}
export type Archive = IDBPDatabase<ArchiveSchema>;
export interface LastRun {
  at: number;
  reports: Record<string, string>;
}
export interface Status {
  conf: Settings;
  unlocked: boolean;
  events: number;
  drafts: number;
  pending: number;
  running: boolean;
  indexHash?: string;
  pointer?: IndexPointer;
  lastRun?: LastRun | null;
  preparingIndex?: boolean;
}
export interface CaptureConfig {
  handle: string;
  capture: boolean;
  pubkey?: string;
}
export type Sign = (template: EventTemplate) => Promise<Event> | Event;
export interface Approval {
  origin: string;
  event: EventTemplate;
  pubkey: string;
}
export type SettingsForm = Omit<Settings, 'relays' | 'archiveName' | 'mediaMiB'> & {
  relays: string;
  mediaMiB?: string | number;
};
export interface Payloads {
  status: {};
  captureConfig: {};
  capture: { posts: Capture[] };
  settings: SettingsForm;
  watch: { pubkey: string };
  unlock: { key: string };
  login: { key: string };
  createProfile: { key: string; name: string };
  logout: { pubkey: string };
  deleteAccount: { pubkey: string; confirmed: boolean };
  lock: {};
  sync: {};
  rescan: {};
  publishIndex: {};
  broadcast: {};
  enableSigner: {};
  authorizeMediaUpload: { hash: string; server: string };
  nip07: { token: string; method: string; event?: unknown };
  approval: { id: string; decision?: boolean };
}
export type Action = keyof Payloads;
export type Message<K extends Action = Action> = {
  [T in K]: { type: T; account?: string } & Payloads[T];
}[K];
interface ActionResults {
  status: Status;
  captureConfig: CaptureConfig;
  authorizeMediaUpload: Event;
  enableSigner: string;
  nip07: string | Event;
  approval: Approval | void;
  broadcast: number;
}
export type Result<K extends Action> = K extends keyof ActionResults ? ActionResults[K] : void;
export type Reply<T> = { ok: true; value: T } | { ok: false; error: string };
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
