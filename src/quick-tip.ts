/** The maximum fee shown when the user enables one-click payments. */
export function quickTipFeeLimit(sats: number) {
  return Math.max(2, Math.ceil(sats / 100));
}
