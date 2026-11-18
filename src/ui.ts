import type { Action, Approval, Message, Payloads, Result } from './types.ts';

export const api = globalThis.browser ?? chrome;
export function el(id: 'requestDetails'): HTMLDetailsElement;
export function el(id: 'kindMode'): HTMLSelectElement;
export function el(
  id:
    | 'indexAddress'
    | 'secret'
    | 'profileName'
    | 'loginKey'
    | 'customRelay'
    | 'downloadKinds'
    | 'relaySync'
    | 'instagramHandle' | 'facebookHandle' | 'instagramCapture' | 'facebookCapture'
    | 'handle'
    | 'capture'
    | 'skipCrossposts'
    | 'mediaMiB',
): HTMLElementTagNameMap['input'];
export function el(
  id:
    | 'open'
    | 'signer'
    | 'deny'
    | 'allow'
    | 'download'
    | 'sync'
    | 'broadcast'
    | 'rescan'
    | 'publishIndex'
    | 'copyIndex'
    | 'backupMedia'
    | 'uploadMedia'
    | 'moreMedia'
    | 'refreshStats'
    | 'lock'
    | 'logout'
    | 'copyProfileId'
    | 'copyPrivateKey'
    | 'deleteStart'
    | 'deleteAccount'
    | 'cancelDelete',
): HTMLElementTagNameMap['button'];
export function el(id: 'relays' | 'blossomServer' | 'profileAbout'): HTMLElementTagNameMap['textarea'];
export function el(
  id: 'nameForm' | 'accountsForm' | 'loginForm' | 'backupSettings' | 'unlock',
): HTMLFormElement;
export function el(id: string): HTMLElement;
export function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw Error('Missing page element ' + id);
  return node;
}
export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
export function notice(message: string) {
  el('notice').textContent = message;
}
export function send(
  type: 'approval',
  body: { id: string; decision?: undefined },
): Promise<Approval>;
export function send<K extends Action>(
  type: K,
  ...args: {} extends Payloads[K]
    ? [body?: Payloads[K] & { account?: string }]
    : [body: Payloads[K] & { account?: string }]
): Promise<Result<K>>;
export async function send(type: Action, body: object = {}) {
  const response = await api.runtime.sendMessage({ type, ...body } as Message);
  if (!response?.ok) throw Error(response?.error ?? 'Extension unavailable.');
  return response.value;
}
