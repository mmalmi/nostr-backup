export const api = globalThis.browser ?? chrome;
export const el = (id) => document.getElementById(id);
export function notice(message) {
  el('notice').textContent = message;
}
export async function send(type, body = {}) {
  const response = await api.runtime.sendMessage({ type, ...body });
  if (!response?.ok) throw Error(response?.error || 'Extension unavailable.');
  return response.value;
}
export function on(id, event, handler) {
  el(id).addEventListener(event, async (e) => {
    e.preventDefault();
    try {
      await handler();
    } catch (err) {
      notice(err.message);
    }
  });
}
