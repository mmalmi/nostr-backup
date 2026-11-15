import type { LastRun, Settings, Message, Result, Reply } from './types.ts';
import type { TabReport } from './site-status.ts';
import type { Event, EventTemplate } from 'nostr-tools/pure';

export interface Tab {
  id?: number;
  index?: number;
  url?: string;
}
export interface Sender {
  id?: string;
  frameId?: number;
  url?: string;
  origin?: string;
  tab?: Tab;
}
type Listener<F> = { addListener(listener: F): void };
export interface LocalData {
  settings?: Settings | null;
  lastRun?: LastRun | null;
  deletingAccount?: Settings;
  [key: `account:${string}`]: Settings | undefined;
}
interface SessionData {
  signingKey?: string;
  [key: `grant-${number}`]: { token: string; origin: string; loginPubkey?: string } | undefined;
}
/** What the backup is doing in each tab, for the popup. */
interface SiteStates {
  get(key: `site-${number}`): Promise<Record<string, TabReport | undefined>>;
  set(values: Record<`site-${number}`, TabReport>): Promise<void>;
  remove(key: `site-${number}`): Promise<void>;
}
interface Area<T> {
  get(key: null): Promise<Partial<T>>;
  get<K extends keyof T>(key: K): Promise<Pick<T, K>>;
  set(values: Partial<T>): Promise<void>;
  remove(key: keyof T): Promise<void>;
  clear(): Promise<void>;
}
interface ExtensionAPI {
  action: {
    onClicked: Listener<() => void>;
    setPopup(details: { popup: string }): Promise<void>;
    setBadgeText(details: { text: string; tabId: number }): Promise<void>;
    setBadgeBackgroundColor(details: { color: string; tabId: number }): Promise<void>;
    /** Missing in some browsers, which then choose the colour themselves. */
    setBadgeTextColor?(details: { color: string; tabId: number }): Promise<void>;
    setTitle(details: { title: string; tabId: number }): Promise<void>;
  };
  storage: {
    local: Area<LocalData & { settingsChanged?: string }>;
    session: Area<SessionData> & SiteStates;
    onChanged: Listener<
      (changes: { settingsChanged?: unknown }, area: string) => void
    >;
  };
  runtime: {
    id: string;
    getManifest?(): { browser_specific_settings?: { gecko?: unknown } };
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
    create(name: string, when: { when?: number; delayInMinutes?: number; periodInMinutes?: number }): Promise<void>;
    onAlarm: Listener<(a: { name: string }) => void>;
  };
  tabs: {
    query(options: { active: true; currentWindow: true } | {url: string | string[]}): Promise<Tab[]>;
    get(id: number): Promise<Tab>;
    create(options: { url: string; index?: number }): Promise<Tab>;
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
  permissions: {
    contains(options: { data_collection: string[] }): Promise<boolean>;
    request(options: { origins: string[] } | { data_collection: string[] }): Promise<boolean>;
  };
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
