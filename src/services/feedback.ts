import { Dimensions, Platform } from 'react-native';
import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface FeedbackConfig {
  apiUrl: string;
  projectId: string;
  authUrl?: string;
  appTitle?: string;
}

export interface TrackEventInput {
  eventType: string;
  projectId?: string;
  targetType?: string;
  targetId?: string;
  rating?: 'good' | 'bad' | number;
  reason?: string;
  fields?: Record<string, unknown>;
}

interface TrackEventResponse {
  success: boolean;
  id: string;
}

interface SessionInfo {
  sessionId: string;
  platform: string;
  osVersion: string;
  deviceModel: string;
  screenWidth: number;
  screenHeight: number;
  devicePixelRatio: number;
  locale: string;
  appVersion: string;
  pageLoadTimeMs: number;
}

const SESSION_ID_KEY = 'feedback_session_id';
const AUTH_ACCESS_TOKEN_KEY = 'feedback-widget-auth:accessToken';
const AUTH_REFRESH_TOKEN_KEY = 'feedback-widget-auth:refreshToken';
const AUTH_EXPIRES_AT_KEY = 'feedback-widget-auth:expiresAt';
const REQUEST_TIMEOUT_MS = 15_000;
const REFRESH_BUFFER_SECONDS = 300;

const appStartTime = Date.now();

let config: FeedbackConfig | null = null;
let accessToken: string | null = null;
let refreshTimerId: ReturnType<typeof setTimeout> | null = null;

function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

async function getSessionId(): Promise<string> {
  let sessionId = await AsyncStorage.getItem(SESSION_ID_KEY);
  if (!sessionId) {
    sessionId = generateUUID();
    await AsyncStorage.setItem(SESSION_ID_KEY, sessionId);
  }
  return sessionId;
}

function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  return fetch(url, { ...options, signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
}

function getAuthHost(): string {
  try {
    return new URL(config!.authUrl!).host;
  } catch {
    return config!.authUrl!;
  }
}

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }
  return headers;
}

async function loadSavedAuth(): Promise<void> {
  try {
    const [saved, expiresAtStr] = await Promise.all([
      AsyncStorage.getItem(AUTH_ACCESS_TOKEN_KEY),
      AsyncStorage.getItem(AUTH_EXPIRES_AT_KEY),
    ]);

    if (!saved || !expiresAtStr) return;

    const expiresAt = parseInt(expiresAtStr, 10);
    if (Date.now() / 1000 >= expiresAt) {
      await performRefresh();
    } else {
      accessToken = saved;
      scheduleRefresh(expiresAt);
    }
  } catch {
    await clearAuth();
  }
}

async function performRefresh(): Promise<boolean> {
  if (!config?.authUrl) return false;

  try {
    const refreshToken = await AsyncStorage.getItem(AUTH_REFRESH_TOKEN_KEY);
    if (!refreshToken) return false;

    const authHost = getAuthHost();
    const response = await fetchWithTimeout(
      `${config.authUrl}/api/auth/refresh`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          refreshToken,
          hostname: authHost,
        }),
      },
    );

    if (!response.ok) {
      await clearAuth();
      return false;
    }

    const data = await response.json();
    await saveAuth(data.accessToken, data.refreshToken, data.expiresIn);
    return true;
  } catch {
    await clearAuth();
    return false;
  }
}

async function saveAuth(
  token: string,
  refreshToken: string,
  expiresIn: number,
): Promise<void> {
  accessToken = token;
  const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;

  await Promise.all([
    AsyncStorage.setItem(AUTH_ACCESS_TOKEN_KEY, token),
    AsyncStorage.setItem(AUTH_REFRESH_TOKEN_KEY, refreshToken),
    AsyncStorage.setItem(AUTH_EXPIRES_AT_KEY, String(expiresAt)),
  ]);

  scheduleRefresh(expiresAt);
}

function scheduleRefresh(expiresAt: number): void {
  if (refreshTimerId) clearTimeout(refreshTimerId);

  const delayMs =
    (expiresAt - REFRESH_BUFFER_SECONDS - Date.now() / 1000) * 1000;

  if (delayMs > 0) {
    refreshTimerId = setTimeout(() => {
      performRefresh();
    }, delayMs);
  }
}

async function clearAuth(): Promise<void> {
  accessToken = null;
  if (refreshTimerId) {
    clearTimeout(refreshTimerId);
    refreshTimerId = null;
  }
  await Promise.all([
    AsyncStorage.removeItem(AUTH_ACCESS_TOKEN_KEY),
    AsyncStorage.removeItem(AUTH_REFRESH_TOKEN_KEY),
    AsyncStorage.removeItem(AUTH_EXPIRES_AT_KEY),
  ]);
}

export const FeedbackService = {
  configure(cfg: FeedbackConfig): void {
    config = cfg;
    if (cfg.authUrl) {
      loadSavedAuth();
    }
  },

  get isAuthenticated(): boolean {
    return accessToken != null;
  },

  get requiresAuth(): boolean {
    return config?.authUrl != null;
  },

  async login(email: string, password: string): Promise<string | null> {
    if (!config?.authUrl) return 'Auth URL not configured';

    try {
      const authHost = getAuthHost();
      const response = await fetchWithTimeout(
        `${config.authUrl}/api/auth/login`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email,
            password,
            userType: 'user',
            hostname: authHost,
          }),
        },
      );

      if (!response.ok) {
        try {
          const errorData = await response.json();
          return errorData.error || errorData.message || `Login failed: ${response.status}`;
        } catch {
          return `Login failed: ${response.status}`;
        }
      }

      const data = await response.json();
      if (data.requiresTwoFactor) return '2FA required';

      await saveAuth(data.accessToken, data.refreshToken, data.expiresIn);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : 'Login failed';
    }
  },

  async logout(): Promise<void> {
    if (config?.authUrl && accessToken) {
      try {
        await fetchWithTimeout(`${config.authUrl}/api/auth/logout`, {
          method: 'POST',
          headers: buildHeaders(),
        });
      } catch {
        // Server-side logout failure is non-critical
      }
    }
    await clearAuth();
  },

  async getSessionInfo(): Promise<SessionInfo> {
    const { width, height, scale } = Dimensions.get('window');
    const sessionId = await getSessionId();

    return {
      sessionId,
      platform: Platform.OS,
      osVersion: String(Platform.Version),
      deviceModel: `${Platform.OS} device`,
      screenWidth: width,
      screenHeight: height,
      devicePixelRatio: scale,
      locale: 'ja_JP',
      appVersion: Constants.expoConfig?.version ?? '1.0.0',
      pageLoadTimeMs: Date.now() - appStartTime,
    };
  },

  async uploadScreenshot(base64: string): Promise<string> {
    if (!config) throw new Error('FeedbackService not configured');

    const response = await fetchWithTimeout(
      `${config.apiUrl}/api/feedback/upload-screenshot-dom`,
      {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify({
          screenshot: `data:image/png;base64,${base64}`,
          domTree: '<react-native-app />',
          pageInfo: {
            url: `app://${Platform.OS}`,
            title: config.appTitle ?? 'App',
          },
          timestamp: Date.now(),
        }),
      },
    );

    if (!response.ok) {
      let detail = '';
      try {
        const errorData = await response.json();
        detail = errorData.error || errorData.message || '';
      } catch { /* ignore */ }
      throw new Error(detail || `Screenshot upload failed: ${response.status}`);
    }

    const data = await response.json();
    return data.id;
  },

  async submitFeedback(
    comment: string,
    uploadedDataId?: string,
    projectIdOverride?: string,
  ): Promise<void> {
    if (!config) throw new Error('FeedbackService not configured');

    const sessionInfo = await this.getSessionInfo();

    const body: Record<string, unknown> = {
      comment,
      timestamp: Date.now(),
      url: `app://${Platform.OS}`,
      projectId: projectIdOverride || config.projectId,
      sessionInfo,
    };

    if (uploadedDataId) {
      body.uploadedDataId = uploadedDataId;
    }

    const response = await fetchWithTimeout(`${config.apiUrl}/api/feedback`, {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      let detail = '';
      try {
        const errorData = await response.json();
        detail = errorData.error || errorData.message || '';
      } catch { /* ignore */ }
      throw new Error(detail || `Feedback submission failed: ${response.status}`);
    }
  },

  async trackEvent(input: TrackEventInput): Promise<TrackEventResponse> {
    if (!config) throw new Error('FeedbackService not configured');

    const body: Record<string, unknown> = {
      projectId: input.projectId ?? config.projectId,
      eventType: input.eventType,
      targetType: input.targetType,
      targetId: input.targetId,
      rating: input.rating,
      reason: input.reason,
      fields: input.fields,
    };

    const response = await fetchWithTimeout(`${config.apiUrl}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      let detail = '';
      try {
        const errorData = await response.json();
        detail = errorData.error || errorData.message || '';
      } catch { /* ignore */ }
      throw new Error(detail || `Event submission failed: ${response.status}`);
    }

    return response.json();
  },
};
