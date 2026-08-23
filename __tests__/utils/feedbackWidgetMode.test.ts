import { resolveFeedbackWidgetVariant } from '../../src/utils/feedbackWidgetMode';

global.fetch = jest.fn();

// FeedbackWidget itself renders react-native host components, which this
// repo's current jest-expo + react-native/jest mock combination cannot
// mount (fails even for a bare <Text/>, unrelated to this feature). The
// routing decision that governs the mode prop is factored into a
// dependency-free pure function (src/utils/feedbackWidgetMode.ts) and
// exercised directly here instead of via full component rendering.
describe('resolveFeedbackWidgetVariant (FeedbackWidget mode routing)', () => {
  test('mode="full" (the default when the prop is omitted) always resolves to full', () => {
    expect(resolveFeedbackWidgetVariant('full', false)).toBe('full');
    expect(resolveFeedbackWidgetVariant('full', true)).toBe('full');
  });

  test('mode="simple" resolves to simple until switched to full', () => {
    expect(resolveFeedbackWidgetVariant('simple', false)).toBe('simple');
  });

  test('mode="simple" resolves to full once the switch gesture has fired', () => {
    expect(resolveFeedbackWidgetVariant('simple', true)).toBe('full');
  });
});
