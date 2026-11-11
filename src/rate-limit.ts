// Retry scheduling belongs to the archive so a stopped worker can resume the outbox.
export function retryDeadline(error: { retryAfterMs?: number }) {
  return Math.min(Date.now() + (error.retryAfterMs ?? 60000), 8640000000000000);
}
