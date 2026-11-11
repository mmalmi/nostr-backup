import type { Filter } from 'nostr-tools/filter';
import { Reconciliation } from 'nostr-pubsub-reconcile';
import { hex, unhex } from './model.ts';
import { parseRelayRateLimit } from 'nostr-pubsub';

const MAX_FRAME_BYTES = 65536;

// Each window has its own socket. Closing it also releases the relay's NEG session
// on timeout, protocol error or interruption. Only a complete diff can skip a send.
export async function compareEvents(
  url: string,
  filter: Filter & { since: number; until: number },
  rows: { id: string; created_at: number }[],
  pull: boolean,
) {
  const { since, until } = filter;
  const engine = new Reconciliation(
    rows.map(({ id, created_at }) => ({ id: unhex(id), timestamp: BigInt(created_at) })),
    { since: BigInt(since), until: BigInt(until) },
    { maxFrameBytes: MAX_FRAME_BYTES },
  );
  const opening = hex(await engine.initiate({ fingerprintFirst: true }));
  const socket = new WebSocket(url);
  const id = 'archive';
  const have = new Set<string>(),
    need = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined,
    finished = false;
  try {
    return await new Promise<{ have: Set<string>; need: Set<string> }>((resolve, reject) => {
      const fail = () => reject(Error('Relay comparison unavailable.'));
      timer = setTimeout(fail, 8000);
      socket.onerror = socket.onclose = fail;
      socket.onopen = () => socket.send(JSON.stringify(['NEG-OPEN', id, filter, opening]));
      let busy = false;
      socket.onmessage = async ({ data }) => {
        try {
          if (typeof data !== 'string' || data.length > MAX_FRAME_BYTES * 2 + 1024) return fail();
          const [type, sub, frame, hint] = JSON.parse(data);
          if (type === 'NOTICE') {
            const throttle = parseRelayRateLimit(url, sub);
            if (throttle) reject(throttle);
            return;
          }
          if (sub !== id) return;
          if (type === 'NEG-ERR')
            return reject(
              parseRelayRateLimit(url, frame, hint) ?? Error('Relay declined Negentropy.'),
            );
          if (
            busy ||
            type !== 'NEG-MSG' ||
            typeof frame !== 'string' ||
            frame.length > MAX_FRAME_BYTES * 2 ||
            frame.length % 2 ||
            !/^[0-9a-f]+$/i.test(frame)
          )
            return fail();
          busy = true;
          const step = await engine.reconcile(unhex(frame));
          if (finished) return;
          for (const eventId of step.have) have.add(hex(eventId));
          if (pull) {
            for (const eventId of step.need) need.add(hex(eventId));
            if (need.size > 16384) return fail(); // Continue large imports with the paged reader.
          }
          busy = false;
          if (step.next) socket.send(JSON.stringify(['NEG-MSG', id, hex(step.next)]));
          else {
            socket.send(JSON.stringify(['NEG-CLOSE', id]));
            resolve({ have, need });
          }
        } catch {
          fail();
        }
      };
    });
  } finally {
    finished = true;
    clearTimeout(timer);
    socket.onopen = socket.onerror = socket.onclose = socket.onmessage = null;
    socket.close();
  }
}
