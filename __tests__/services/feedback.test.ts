import { FeedbackService } from '../../src/services/feedback';

// Mock AsyncStorage
const mockStorage: Record<string, string> = {};
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn((key: string) =>
    Promise.resolve(mockStorage[key] ?? null),
  ),
  setItem: jest.fn((key: string, value: string) => {
    mockStorage[key] = value;
    return Promise.resolve();
  }),
  removeItem: jest.fn((key: string) => {
    delete mockStorage[key];
    return Promise.resolve();
  }),
}));

// Mock expo-constants
jest.mock('expo-constants', () => ({
  expoConfig: { version: '1.0.0' },
}));

// Mock fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('FeedbackService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.keys(mockStorage).forEach((key) => delete mockStorage[key]);
    FeedbackService.configure({
      apiUrl: 'https://test-api.example.com',
      projectId: 'test-project',
      appTitle: 'Test App',
    });
  });

  describe('configure', () => {
    test('sets config', () => {
      // configure was called in beforeEach, just verify no error
      expect(FeedbackService.requiresAuth).toBe(false);
    });

    test('requiresAuth returns true when authUrl is set', () => {
      FeedbackService.configure({
        apiUrl: 'https://test-api.example.com',
        projectId: 'test-project',
        authUrl: 'https://auth.example.com',
      });
      expect(FeedbackService.requiresAuth).toBe(true);
    });
  });

  describe('getSessionInfo', () => {
    test('returns session info with expected fields', async () => {
      const info = await FeedbackService.getSessionInfo();

      expect(info).toHaveProperty('sessionId');
      expect(info).toHaveProperty('platform');
      expect(info).toHaveProperty('osVersion');
      expect(info).toHaveProperty('deviceModel');
      expect(info).toHaveProperty('screenWidth');
      expect(info).toHaveProperty('screenHeight');
      expect(info).toHaveProperty('devicePixelRatio');
      expect(info).toHaveProperty('locale', 'ja_JP');
      expect(info).toHaveProperty('appVersion', '1.0.0');
      expect(info).toHaveProperty('pageLoadTimeMs');
    });

    test('returns consistent sessionId across calls', async () => {
      const info1 = await FeedbackService.getSessionInfo();
      const info2 = await FeedbackService.getSessionInfo();

      expect(info1.sessionId).toBe(info2.sessionId);
    });
  });

  describe('uploadScreenshot', () => {
    test('sends base64 screenshot to API', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: 'upload-123' }),
      });

      const id = await FeedbackService.uploadScreenshot('base64data');

      expect(id).toBe('upload-123');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://test-api.example.com/api/feedback/upload-screenshot-dom',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
        }),
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.screenshot).toBe('data:image/png;base64,base64data');
      expect(body.domTree).toBe('<react-native-app />');
      expect(body.pageInfo).toHaveProperty('title', 'Test App');
    });

    test('throws on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      await expect(
        FeedbackService.uploadScreenshot('data'),
      ).rejects.toThrow('Screenshot upload failed: 500');
    });
  });

  describe('submitFeedback', () => {
    test('sends feedback with comment and projectId', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      await FeedbackService.submitFeedback('Great app!');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://test-api.example.com/api/feedback',
        expect.objectContaining({ method: 'POST' }),
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.comment).toBe('Great app!');
      expect(body.projectId).toBe('test-project');
      expect(body.sessionInfo).toBeDefined();
    });

    test('includes uploadedDataId when provided', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      await FeedbackService.submitFeedback('Bug report', 'upload-456');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.uploadedDataId).toBe('upload-456');
    });

    test('uses projectIdOverride when provided', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      await FeedbackService.submitFeedback('widget bug', undefined, 'my-widget');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.comment).toBe('widget bug');
      expect(body.projectId).toBe('my-widget');
    });

    test('falls back to configured projectId when override is not provided', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      await FeedbackService.submitFeedback('app feedback', undefined, undefined);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.projectId).toBe('test-project');
    });

    test('throws on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });

      await expect(
        FeedbackService.submitFeedback('test'),
      ).rejects.toThrow('Feedback submission failed: 403');
    });
  });

  describe('trackEvent', () => {
    test('sends the simple-mode rating payload to /api/events with no auth header', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, id: 'event-1' }),
      });

      const result = await FeedbackService.trackEvent({
        eventType: 'rating',
        projectId: 'test-project',
        rating: 'good',
        reason: 'Works great',
      });

      expect(result).toEqual({ success: true, id: 'event-1' });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://test-api.example.com/api/events',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toEqual({
        projectId: 'test-project',
        eventType: 'rating',
        rating: 'good',
        reason: 'Works great',
      });
      expect(body.url).toBeUndefined();
    });

    test('omits the reason key entirely when not provided (no default text filled in)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, id: 'event-2' }),
      });

      await FeedbackService.trackEvent({
        eventType: 'rating',
        projectId: 'test-project',
        rating: 'bad',
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect('reason' in body).toBe(false);
      expect(body).toEqual({
        projectId: 'test-project',
        eventType: 'rating',
        rating: 'bad',
      });
    });

    test('falls back to the configured projectId when not provided', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ success: true, id: 'event-3' }) });

      await FeedbackService.trackEvent({ eventType: 'page_view' });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.projectId).toBe('test-project');
    });

    test('does not include an Authorization header even when authenticated', async () => {
      FeedbackService.configure({
        apiUrl: 'https://test-api.example.com',
        projectId: 'test-project',
        authUrl: 'https://auth.example.com',
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            accessToken: 'token-abc',
            refreshToken: 'refresh-xyz',
            expiresIn: 3600,
          }),
      });
      await FeedbackService.login('test@example.com', 'pass');

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, id: 'event-4' }),
      });
      await FeedbackService.trackEvent({ eventType: 'rating', rating: 'good' });

      const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
      expect(lastCall[1].headers).toEqual({ 'Content-Type': 'application/json' });
    });

    test('throws on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      await expect(
        FeedbackService.trackEvent({ eventType: 'rating' }),
      ).rejects.toThrow('Event submission failed: 500');
    });
  });

  describe('login', () => {
    test('returns error when authUrl is not configured', async () => {
      FeedbackService.configure({
        apiUrl: 'https://test-api.example.com',
        projectId: 'test-project',
      });

      const result = await FeedbackService.login('test@example.com', 'pass');
      expect(result).not.toBeNull();
    });

    test('returns true and saves tokens on success', async () => {
      FeedbackService.configure({
        apiUrl: 'https://test-api.example.com',
        projectId: 'test-project',
        authUrl: 'https://auth.example.com',
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            accessToken: 'token-abc',
            refreshToken: 'refresh-xyz',
            expiresIn: 3600,
          }),
      });

      const result = await FeedbackService.login('test@example.com', 'pass');

      expect(result).toBeNull();
      expect(FeedbackService.isAuthenticated).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://auth.example.com/api/auth/login',
        expect.objectContaining({ method: 'POST' }),
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.userType).toBe('user');
      expect(body.hostname).toBe('auth.example.com');
    });

    test('returns error message on failed login', async () => {
      FeedbackService.configure({
        apiUrl: 'https://test-api.example.com',
        projectId: 'test-project',
        authUrl: 'https://auth.example.com',
      });

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: 'Invalid credentials' }),
      });

      const result = await FeedbackService.login('test@example.com', 'wrong');
      expect(result).toBe('Invalid credentials');
    });

    test('returns status code when no error body', async () => {
      FeedbackService.configure({
        apiUrl: 'https://test-api.example.com',
        projectId: 'test-project',
        authUrl: 'https://auth.example.com',
      });

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.reject(new Error('no json')),
      });

      const result = await FeedbackService.login('test@example.com', 'wrong');
      expect(result).toBe('Login failed: 500');
    });
  });
});
