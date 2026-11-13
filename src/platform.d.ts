import type { LastRun, Settings, Message, Result, Reply } from './types.ts';
import type { Event, EventTemplate } from 'nostr-tools/pure';

export interface Tab {
  id?: number;
  url?: string;
}
export interface Sender {
  id?: string;
  frameId?: number;
  url?: string;
  tab?: Tab;
}
type Listener<F> = { addListener(listener: F): void };
interface LocalData {
  settings?: Settings | null;
  lastRun?: LastRun | null;
  deletingAccount?: Settings;
  [key: `account:${string}`]: Settings | undefined;
}
interface SessionData {
  signingKey?: string;
  [key: `grant-${number}`]: { token: string; origin: string; loginPubkey?: string } | undefined;
}
interface Area<T> {
  get<K extends keyof T>(key: K): Promise<Pick<T, K>>;
  set(values: Partial<T>): Promise<void>;
  remove(key: keyof T): Promise<void>;
  clear(): Promise<void>;
}
interface ExtensionAPI {
  action: {
    onClicked: Listener<() => void>;
    setPopup(details: { popup: string }): Promise<void>;
  };
  storage: {
    local: Area<LocalData>;
    session: Area<SessionData>;
    onChanged: Listener<
      (changes: { settings?: { newValue?: Settings | null } }, area: string) => void
    >;
  };
  runtime: {
    id: string;
    getURL(path: string): string;
    openOptionsPage(): Promise<void>;
    sendMessage<M extends Message>(message: M): Promise<Reply<Result<M['type']>>>;
    onMessage: Listener<
      (msg: Message, sender: Sender, respond: (response: Reply<unknown>) => void) => boolean
    >;
    onStartup: Listener<() => void>;
    onInstalled: Listener<() => void>;
  };
  alarms: {
    get(name: string): Promise<unknown>;
    create(name: string, when: { when?: number; periodInMinutes?: number }): Promise<void>;
    onAlarm: Listener<(a: { name: string }) => void>;
  };
  tabs: {
    query(options: { active: true; currentWindow: true } | {url: string | string[]}): Promise<Tab[]>;
    get(id: number): Promise<Tab>;
    onRemoved: Listener<(id: number) => void>;
  };
  windows: {
    create(options: {
      url: string;
      type: 'popup';
      width: number;
      height: number;
    }): Promise<{ id?: number }>;
    onRemoved: Listener<(id: number) => void>;
  };
  scripting: {
    executeScript(options: {target: {tabId: number}; files: string[]}): Promise<unknown[]>;
    executeScript<A extends unknown[], R>(options: {
      target: { tabId: number };
      world?: 'MAIN';
      func: (...args: A) => R;
      args?: A;
    }): Promise<{ result: R }[]>;
  };
  permissions: { request(options: { origins: string[] }): Promise<boolean> };
}
interface Provider {
  getPublicKey(): Promise<string>;
  signEvent(event: EventTemplate): Promise<Event>;
}
declare global {
  var chrome: ExtensionAPI;
  var browser: ExtensionAPI | undefined;
  var nostrBackupCapture: boolean | undefined;
  var nostrBackupBridge: AbortController | undefined;
  interface Window {
    nostr?: Provider;
    nostrBackupProvider?: Provider;
  }
}
