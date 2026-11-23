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
/** 429 / 一時エラー時の最大再試行回数 */
const MAX_REFRESH_RETRIES = 3;
/** 1 回の待機の上限(ms)。Retry-After が大きくてもこれを超えて待たない */
const MAX_RETRY_WAIT_MS = 30_000;
/** Retry-After が無い場合の指数バックオフの基準(ms): 1s, 2s, 4s */
const BACKOFF_BASE_MS = 1_000;
/** 再試行を使い切った後に、改めて refresh を試みるまでの待機(ms) */
const TRANSIENT_RESCHEDULE_MS = 60_000;
/** 一時的な失敗が続いた場合の再スケジュール通算回数の上限(成功でリセット)。超えたら自動再試行を止める */
const MAX_TRANSIENT_RESCHEDULES = 5;

/**
 * ok: 更新済み / invalid: 401 などの直らない 4xx で token を消した /
 * transient: 429・408・5xx・ネットワーク断など一時的な失敗(token は保持) /
 * aborted: 通信中にログアウト・再ログインがあり、結果を保存せず中止(ストレージには触らない)、または更新できる token が無い
 */
type RefreshOutcome = 'ok' | 'invalid' | 'transient' | 'aborted';

const appStartTime = Date.now();

let config: FeedbackConfig | null = null;
let accessToken: string | null = null;
let refreshTimerId: ReturnType<typeof setTimeout> | null = null;
/** logout・再ログインで増やす世代番号。進行中の refresh が古い世代の結果を保存・消去しないために使う */
let generation = 0;
let transientReschedules = 0;
/** 進行中の refresh。タイマー・起動時の復元・configure の再呼び出しが重なっても、API は 1 本にまとめる */
let refreshInFlight: { gen: number; promise: Promise<RefreshOutcome> } | null = null;

/** 再試行で回復しうる HTTP ステータス(429・408・5xx)。これ以外の 4xx は再試行しない */
function isTransientStatus(status: number | undefined): boolean {
  return status === 429 || status === 408 || (status !== undefined && status >= 500);
}

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

/**
 * 待機時間(ms)。Retry-After ヘッダ(秒)を優先し、無ければ 429 本文の retryAfter(秒)、
 * それも無い・不正(負値・非数・非有限)なら指数バックオフ。上限は MAX_RETRY_WAIT_MS。
 */
async function computeWaitMs(response: Response | null, attempt: number): Promise<number> {
  const header = response?.headers?.get('Retry-After');
  if (header && /^\d+$/.test(header.trim())) {
    return Math.min(parseInt(header.trim(), 10) * 1000, MAX_RETRY_WAIT_MS);
  }
  if (response?.status === 429) {
    try {
      const body: unknown = await response.json();
      const sec = (body as { retryAfter?: unknown } | null)?.retryAfter;
      if (typeof sec === 'number' && Number.isFinite(sec) && sec >= 0) {
        return Math.min(Math.ceil(sec) * 1000, MAX_RETRY_WAIT_MS);
      }
    } catch { /* 本文なし・JSON 以外 */ }
  }
  return Math.min(BACKOFF_BASE_MS * 2 ** attempt, MAX_RETRY_WAIT_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * token を更新する。同じ世代で進行中の refresh があればその結果を共有する(多重実行しない)。
 * 401 などの直らない 4xx のときだけ token を消す。429・408・5xx・ネットワーク断では token を保持し、
 * 待って再試行する。通信中にログアウト・再ログインがあれば、結果を保存も消去もせず中止する。
 */
function performRefresh(): Promise<RefreshOutcome> {
  if (!config?.authUrl) return Promise.resolve('aborted');

  const gen = generation;
  if (refreshInFlight && refreshInFlight.gen === gen) return refreshInFlight.promise;

  const promise: Promise<RefreshOutcome> = refreshWithRetries(gen)
    // ストレージ障害などの想定外の例外では token を消さず、一時的な失敗として扱う
    .catch((): RefreshOutcome => 'transient')
    .finally(() => {
      if (refreshInFlight?.promise === promise) refreshInFlight = null;
    });
  refreshInFlight = { gen, promise };
  return promise;
}

async function refreshWithRetries(gen: number): Promise<RefreshOutcome> {
  for (let attempt = 0; ; attempt++) {
    if (gen !== generation) return 'aborted';
    const refreshToken = await AsyncStorage.getItem(AUTH_REFRESH_TOKEN_KEY);
    if (gen !== generation) return 'aborted';
    // 更新できる token が無い。何も変えない
    if (!refreshToken) return 'aborted';
    const authUrl = config?.authUrl;
    if (!authUrl) return 'aborted';

    let response: Response | null = null;
    try {
      response = await fetchWithTimeout(`${authUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          refreshToken,
          hostname: getAuthHost(),
        }),
      });
    } catch {
      /* ネットワーク断・タイムアウト: 一時的な失敗として扱う */
    }

    // 通信中のログアウト・再ログインがあれば、結果を保存も消去もせず中止する。
    // 以降の保存・消去は、この確認の直後(await を挟まず)に始める
    if (gen !== generation) return 'aborted';

    if (response?.ok) {
      let data: { accessToken?: unknown; refreshToken?: unknown; expiresIn?: unknown } | null;
      try {
        data = await response.json();
      } catch {
        return finishTransient(gen);
      }
      // 本文の読み取り中にもログアウト・再ログインがありうるので、保存の直前に再確認する
      if (gen !== generation) return 'aborted';
      if (
        typeof data?.accessToken !== 'string' ||
        typeof data.refreshToken !== 'string' ||
        typeof data.expiresIn !== 'number'
      ) {
        // 応答の形が想定外: token は消さず、一時的な失敗として扱う
        return finishTransient(gen);
      }
      transientReschedules = 0;
      await saveAuth(data.accessToken, data.refreshToken, data.expiresIn);
      return 'ok';
    }

    // 一時的でない失敗(401・400・404 等の再試行しても直らない 4xx)は token を消す
    if (response && !isTransientStatus(response.status)) {
      await clearAuth();
      return 'invalid';
    }

    // 429・408・5xx・ネットワーク断: token を保持して待ち、再試行する
    if (attempt >= MAX_REFRESH_RETRIES) return finishTransient(gen);
    await sleep(await computeWaitMs(response, attempt));
  }
}

/** 再試行を使い切った一時的な失敗。token は保持し、回数上限内なら後で改めて refresh する */
function finishTransient(gen: number): RefreshOutcome {
  if (gen !== generation) return 'aborted';
  if (transientReschedules < MAX_TRANSIENT_RESCHEDULES) {
    transientReschedules++;
    scheduleRefreshIn(TRANSIENT_RESCHEDULE_MS);
  }
  return 'transient';
}

async function saveAuth(
  token: string,
  refreshToken: string,
  expiresIn: number,
): Promise<void> {
  accessToken = token;
  const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;

  // 次の refresh の予約は、ストレージの書き込みを待つ前に行う。
  // 書き込み中にログアウトされたとき、ログアウトのタイマー解除が後から効くようにするため
  scheduleRefresh(expiresAt);

  await Promise.all([
    AsyncStorage.setItem(AUTH_ACCESS_TOKEN_KEY, token),
    AsyncStorage.setItem(AUTH_REFRESH_TOKEN_KEY, refreshToken),
    AsyncStorage.setItem(AUTH_EXPIRES_AT_KEY, String(expiresAt)),
  ]);
}

function scheduleRefreshIn(delayMs: number): void {
  if (refreshTimerId) clearTimeout(refreshTimerId);
  refreshTimerId = setTimeout(() => {
    performRefresh().catch(() => undefined);
  }, delayMs);
}

function scheduleRefresh(expiresAt: number): void {
  if (refreshTimerId) clearTimeout(refreshTimerId);

  const delayMs =
    (expiresAt - REFRESH_BUFFER_SECONDS - Date.now() / 1000) * 1000;

  if (delayMs > 0) scheduleRefreshIn(delayMs);
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

      // 進行中の refresh が、旧い結果で新しいログインを上書き・消去しないようにする
      generation++;
      await saveAuth(data.accessToken, data.refreshToken, data.expiresIn);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : 'Login failed';
    }
  },

  async logout(): Promise<void> {
    // 進行中の再試行(待機中を含む)が、待機明けに token を書き戻さないようにする
    generation++;
    const bearer = accessToken;
    accessToken = null;
    if (refreshTimerId) {
      clearTimeout(refreshTimerId);
      refreshTimerId = null;
    }

    // サーバーが refresh token の系列ごと失効できるよう、保存済みの refresh token を送る
    let refreshToken: string | null = null;
    try {
      refreshToken = await AsyncStorage.getItem(AUTH_REFRESH_TOKEN_KEY);
    } catch { /* 読めなくても、ログアウトは続行する */ }

    // ログアウト API の応答待ちの間に refresh が token を書き戻さないよう、先に消す
    await clearAuth();

    if (config?.authUrl && (bearer || refreshToken)) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (bearer) headers['Authorization'] = `Bearer ${bearer}`;
      try {
        await fetchWithTimeout(`${config.authUrl}/api/auth/logout`, {
          method: 'POST',
          headers,
          body: JSON.stringify(refreshToken ? { refreshToken } : {}),
        });
      } catch {
        // Server-side logout failure is non-critical
      }
    }
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
