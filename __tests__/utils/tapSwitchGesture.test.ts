import { createTapSwitchGesture } from '../../src/utils/tapSwitchGesture';

global.fetch = jest.fn();

describe('createTapSwitchGesture', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('fires after 5 taps within the interval (simple-mode switch gesture)', () => {
    const onThresholdReached = jest.fn();
    const gesture = createTapSwitchGesture(5, 2000, onThresholdReached);

    gesture.registerTap();
    gesture.registerTap();
    gesture.registerTap();
    gesture.registerTap();
    expect(onThresholdReached).not.toHaveBeenCalled();

    gesture.registerTap();
    expect(onThresholdReached).toHaveBeenCalledTimes(1);
  });

  test('does not fire with fewer than the threshold taps', () => {
    const onThresholdReached = jest.fn();
    const gesture = createTapSwitchGesture(5, 2000, onThresholdReached);

    gesture.registerTap();
    gesture.registerTap();
    gesture.registerTap();

    expect(onThresholdReached).not.toHaveBeenCalled();
  });

  test('resets the count when a gap exceeds the interval', () => {
    const onThresholdReached = jest.fn();
    const gesture = createTapSwitchGesture(5, 2000, onThresholdReached);

    gesture.registerTap();
    gesture.registerTap();
    gesture.registerTap();
    gesture.registerTap();

    jest.advanceTimersByTime(2001);

    gesture.registerTap();

    expect(onThresholdReached).not.toHaveBeenCalled();
  });

  test('counts again from zero after firing', () => {
    const onThresholdReached = jest.fn();
    const gesture = createTapSwitchGesture(5, 2000, onThresholdReached);

    for (let i = 0; i < 5; i += 1) gesture.registerTap();
    expect(onThresholdReached).toHaveBeenCalledTimes(1);

    gesture.registerTap();
    gesture.registerTap();
    expect(onThresholdReached).toHaveBeenCalledTimes(1);
  });

  test('dispose clears any pending reset timer without throwing', () => {
    const onThresholdReached = jest.fn();
    const gesture = createTapSwitchGesture(5, 2000, onThresholdReached);

    gesture.registerTap();
    expect(() => gesture.dispose()).not.toThrow();
  });
});
