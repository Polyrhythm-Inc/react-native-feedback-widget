/**
 * Pure routing decision for FeedbackWidget's `mode` prop, kept dependency
 * free (no react-native import) so it can be unit tested without mounting
 * any component: `mode="full"` (the default when the prop is omitted)
 * always resolves to 'full'; `mode="simple"` resolves to 'simple' until the
 * switch gesture flips `switchedToFull`.
 */
export function resolveFeedbackWidgetVariant(
  mode: 'simple' | 'full',
  switchedToFull: boolean,
): 'simple' | 'full' {
  return mode === 'simple' && !switchedToFull ? 'simple' : 'full';
}
