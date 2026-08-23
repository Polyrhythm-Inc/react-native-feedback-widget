export interface TapSwitchGesture {
  /** Register a tap. Fires `onThresholdReached` once `threshold` taps have
   * each arrived within `intervalMs` of the previous one. */
  registerTap(): void;
  /** Clear any pending reset timer (call on unmount). */
  dispose(): void;
}

/**
 * Tracks rapid repeated taps and fires a callback once `threshold` taps
 * have each arrived within `intervalMs` of the previous one; a gap longer
 * than `intervalMs` resets the count. Used by SimpleFeedbackPanel's
 * header-title switch gesture (5 taps within 2s switches to the full
 * feedback widget), mirroring the web version's simple-widget.ts.
 */
export function createTapSwitchGesture(
  threshold: number,
  intervalMs: number,
  onThresholdReached: () => void,
): TapSwitchGesture {
  let count = 0;
  let resetTimer: ReturnType<typeof setTimeout> | null = null;

  function clearResetTimer(): void {
    if (resetTimer !== null) {
      clearTimeout(resetTimer);
      resetTimer = null;
    }
  }

  return {
    registerTap(): void {
      count += 1;
      clearResetTimer();

      if (count >= threshold) {
        count = 0;
        onThresholdReached();
        return;
      }

      resetTimer = setTimeout(() => {
        count = 0;
      }, intervalMs);
    },

    dispose(): void {
      clearResetTimer();
    },
  };
}
