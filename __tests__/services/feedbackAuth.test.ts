// 認証 token の refresh / logout (SEC-001 E-4): 多重実行の 1 本化、429 等でログアウトしない、ログアウト時の系列失効
type Svc = typeof import('../../src/services/feedback').FeedbackService;

const mockStorage: Record<string, string> = {};
const mockGetItem = jest.fn<Promise<string | null>, [string]>((key) => Promise.resolve(mockStorage[key] ?? null));
/** setItem の完了を遅らせて、「保存の書き込み中」に別の操作を割り込ませるためのゲート */
const mockGate: { setItem: Promise<void> | null; removeItem: Promise<void> | null } = { setItem: null, removeItem: null };
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: (key: string) => mockGetItem(key),
  setItem: jest.fn((key: string, value: string) => {
    mockStorage[key] = value;
    return mockGate.setItem ?? Promise.resolve();
  }),
  removeItem: jest.fn((key: string) => {
    const done = () => {
      delete mockStorage[key];
    };
    if (mockGate.removeItem) return mockGate.removeItem.then(done); // 消去を遅らせる(その間、旧い値が読める)
    done();
    return Promise.resolve();
  }),
}));
jest.mock('expo-constants', () => ({ expoConfig: { version: '1.0.0' } }));

const fetchMock = jest.fn();
global.fetch = fetchMock;

const AUTH_URL = 'https://auth.example.com';
const K = {
  access: 'feedback-widget-auth:accessToken',
  refresh: 'feedback-widget-auth:refreshToken',
  expires: 'feedback-widget-auth:expiresAt',
};
const NEW_TOKENS = { accessToken: 'a2', refreshToken: 'r2', expiresIn: 900 };
const MAX_WAIT = 30_000;

function res(status: number, body?: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k] ?? null },
    json: async () => {
      if (body === undefined) throw new SyntaxError('Unexpected end of JSON input');
      return body;
    },
  } as unknown as Response;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => jest.advanceTimersByTimeAsync(0);
const callsTo = (suffix: string) => fetchMock.mock.calls.filter(([url]) => String(url).endsWith(suffix));
const refreshCalls = () => callsTo('/api/auth/refresh');
const nowSec = () => Math.floor(Date.now() / 1000);

/** 期限切れの token を保存しておく(configure の復元で refresh が走る) */
function seedExpired(refresh = 'r1', access = 'a1') {
  mockStorage[K.access] = access;
  mockStorage[K.refresh] = refresh;
  mockStorage[K.expires] = String(nowSec() - 10);
}

/** モジュールのシングルトン状態(token・タイマー・世代番号)をテストごとに初期化して読み込む */
async function start(): Promise<Svc> {
  let svc!: Svc;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- isolateModules は同期の require が必要
    svc = require('../../src/services/feedback').FeedbackService;
  });
  svc.configure({ apiUrl: 'https://api.example.com', projectId: 'p', authUrl: AUTH_URL });
  return svc;
}

beforeEach(() => {
  jest.useFakeTimers();
  fetchMock.mockReset();
  mockGetItem.mockClear();
  mockGate.setItem = null;
  mockGate.removeItem = null;
  Object.keys(mockStorage).forEach((k) => delete mockStorage[k]);
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('refresh: 成功と、token を消す失敗', () => {
  test('期限切れの token は起動時に refresh され、新しい token が保存される', async () => {
    seedExpired();
    fetchMock.mockResolvedValueOnce(res(200, NEW_TOKENS));
    const svc = await start();
    await flush();

    expect(svc.isAuthenticated).toBe(true);
    expect(mockStorage[K.access]).toBe('a2');
    expect(mockStorage[K.refresh]).toBe('r2');
    expect(jest.getTimerCount()).toBe(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${AUTH_URL}/api/auth/refresh`);
    expect(JSON.parse(init.body)).toEqual({ refreshToken: 'r1', hostname: 'auth.example.com' });
  });

  test.each([400, 401, 404])('%i は再試行せず token を消す', async (status) => {
    seedExpired();
    fetchMock.mockResolvedValueOnce(res(status, { error: 'x' }));
    const svc = await start();
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(svc.isAuthenticated).toBe(false);
    expect(mockStorage).toEqual({});
    expect(jest.getTimerCount()).toBe(0);
  });

  test('refresh token が無ければ API を呼ばず、何も消さない', async () => {
    mockStorage[K.access] = 'a1';
    mockStorage[K.expires] = String(nowSec() - 10);
    await start();
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockStorage[K.access]).toBe('a1');
  });

  test('応答の形が想定外(200 だが token が無い)なら、token を消さず一時的な失敗にする', async () => {
    seedExpired();
    fetchMock.mockResolvedValueOnce(res(200, { message: 'ok' }));
    await start();
    await flush();

    expect(mockStorage[K.refresh]).toBe('r1');
    expect(jest.getTimerCount()).toBe(1); // 60 秒後の再試行が予約されている
  });

  test('ストレージの読み取りに失敗しても、token を消さない(従来は消していた)', async () => {
    seedExpired();
    // 起動時の復元(access token の読み取り)は通し、refresh 内の refresh token の読み取りだけ失敗させる
    mockGetItem.mockImplementation((key: string) =>
      key === K.refresh ? Promise.reject(new Error('storage down')) : Promise.resolve(mockStorage[key] ?? null),
    );
    await start();
    await flush();
    mockGetItem.mockImplementation((key: string) => Promise.resolve(mockStorage[key] ?? null));

    expect(mockStorage[K.refresh]).toBe('r1');
    expect(fetchMock).not.toHaveBeenCalled();
    // 想定外の例外でも、60 秒後の再試行が予約されていて、回復する (L-001)
    expect(jest.getTimerCount()).toBe(1);
    fetchMock.mockResolvedValueOnce(res(200, NEW_TOKENS));
    await jest.advanceTimersByTimeAsync(60_000);
    expect(mockStorage[K.refresh]).toBe('r2');
  });
});

describe('refresh: 429・5xx・ネットワーク断ではログアウトしない', () => {
  test('429 + Retry-After の秒数だけ待って再試行し、成功を保存する', async () => {
    seedExpired();
    fetchMock.mockResolvedValueOnce(res(429, {}, { 'Retry-After': '2' })).mockResolvedValueOnce(res(200, NEW_TOKENS));
    const svc = await start();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(svc.isAuthenticated).toBe(true);
    expect(mockStorage[K.refresh]).toBe('r2');
  });

  test('Retry-After が読めなくても、429 本文の retryAfter(秒) を使う', async () => {
    seedExpired();
    fetchMock.mockResolvedValueOnce(res(429, { retryAfter: 5 })).mockResolvedValueOnce(res(200, NEW_TOKENS));
    await start();
    await flush();
    await jest.advanceTimersByTimeAsync(4999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('Retry-After ヘッダは 30 秒で頭打ち', async () => {
    seedExpired();
    fetchMock.mockResolvedValueOnce(res(429, {}, { 'Retry-After': '100' })).mockResolvedValueOnce(res(200, NEW_TOKENS));
    await start();
    await flush();
    await jest.advanceTimersByTimeAsync(MAX_WAIT - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('本文の retryAfter が巨大でも 30 秒で頭打ち (T-001: 上限を外すと落ちる)', async () => {
    seedExpired();
    fetchMock.mockResolvedValueOnce(res(429, { retryAfter: 1e9 })).mockResolvedValueOnce(res(200, NEW_TOKENS));
    await start();
    await flush();
    await jest.advanceTimersByTimeAsync(MAX_WAIT - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test.each([
    ['負値', -5],
    ['文字列', '7'],
    ['null', null],
  ])('本文の retryAfter が %s なら 1 秒のバックオフ (T-001)', async (_label, value) => {
    seedExpired();
    fetchMock.mockResolvedValueOnce(res(429, { retryAfter: value })).mockResolvedValueOnce(res(200, NEW_TOKENS));
    await start();
    await flush();
    await jest.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('JSON でない 429 本文でも例外にならず、1 秒のバックオフで再試行する', async () => {
    seedExpired();
    fetchMock.mockResolvedValueOnce(res(429)).mockResolvedValueOnce(res(200, NEW_TOKENS));
    await start();
    await flush();
    await jest.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockStorage[K.refresh]).toBe('r2');
  });

  test.each([408, 500, 503])('%i も再試行し、成功すれば保存する', async (status) => {
    seedExpired();
    fetchMock.mockResolvedValueOnce(res(status, {})).mockResolvedValueOnce(res(200, NEW_TOKENS));
    await start();
    await flush();
    await jest.advanceTimersByTimeAsync(1000);
    expect(mockStorage[K.refresh]).toBe('r2');
  });

  test('ネットワーク断・タイムアウトは 1・2・4 秒のバックオフで再試行し、使い切っても token を保持する', async () => {
    seedExpired();
    fetchMock.mockRejectedValue(new TypeError('Network request failed'));
    const svc = await start();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(4000);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    expect(svc.isAuthenticated).toBe(false);
    expect(mockStorage[K.refresh]).toBe('r1');
    expect(mockStorage[K.access]).toBe('a1');
  });

  test('429 が続いても token を保持し、ログアウト API も呼ばない', async () => {
    seedExpired();
    fetchMock.mockResolvedValue(res(429, {}, { 'Retry-After': '1' }));
    await start();
    await flush();
    await jest.advanceTimersByTimeAsync(10_000);

    expect(mockStorage[K.refresh]).toBe('r1');
    expect(callsTo('/api/auth/logout')).toHaveLength(0);
  });

  test('一時的な失敗が続いても、自動再試行は通算 5 回で止まる(無限ループしない)', async () => {
    seedExpired();
    fetchMock.mockRejectedValue(new TypeError('Network request failed'));
    await start();
    await jest.advanceTimersByTimeAsync(60 * 60 * 1000);

    // 初回 + 再スケジュール 5 回 = 6 回の refresh × (初回 + 再試行 3 回) = 24 回
    expect(fetchMock).toHaveBeenCalledTimes(24);
    expect(jest.getTimerCount()).toBe(0);
    expect(mockStorage[K.refresh]).toBe('r1');
  });

  test('再スケジュールした refresh が成功すれば、回復して token が更新される', async () => {
    seedExpired();
    fetchMock.mockRejectedValueOnce(new TypeError('x')).mockRejectedValueOnce(new TypeError('x'));
    fetchMock.mockRejectedValueOnce(new TypeError('x')).mockRejectedValueOnce(new TypeError('x'));
    fetchMock.mockResolvedValueOnce(res(200, NEW_TOKENS));
    const svc = await start();
    await jest.advanceTimersByTimeAsync(7_000); // 1 回目の refresh が失敗で終わる
    expect(svc.isAuthenticated).toBe(false);
    await jest.advanceTimersByTimeAsync(60_000); // 再スケジュールが発火

    expect(svc.isAuthenticated).toBe(true);
    expect(mockStorage[K.refresh]).toBe('r2');
  });
});

describe('refresh: 多重実行は 1 本にまとめる', () => {
  test('configure を続けて呼んでも、refresh API は 1 回だけ', async () => {
    seedExpired();
    const d = deferred<Response>();
    fetchMock.mockReturnValueOnce(d.promise);
    const svc = await start();
    svc.configure({ apiUrl: 'https://api.example.com', projectId: 'p', authUrl: AUTH_URL });
    svc.configure({ apiUrl: 'https://api.example.com', projectId: 'p', authUrl: AUTH_URL });
    await flush();
    d.resolve(res(200, NEW_TOKENS));
    await flush();

    expect(refreshCalls()).toHaveLength(1);
    expect(svc.isAuthenticated).toBe(true);
  });

  test('自動 refresh のタイマーと起動時の復元が重なっても、API は 1 回だけ', async () => {
    seedExpired();
    const d = deferred<Response>();
    fetchMock.mockReturnValueOnce(d.promise);
    const svc = await start();
    await flush();
    // 通信中にもう一度 configure(= 復元 → refresh)しても共有される
    svc.configure({ apiUrl: 'https://api.example.com', projectId: 'p', authUrl: AUTH_URL });
    await flush();
    expect(refreshCalls()).toHaveLength(1);
    d.resolve(res(200, NEW_TOKENS));
    await flush();
    expect(refreshCalls()).toHaveLength(1);
  });
});

describe('logout', () => {
  async function loggedIn(): Promise<Svc> {
    const svc = await start();
    fetchMock.mockResolvedValueOnce(res(200, { accessToken: 'a1', refreshToken: 'r1', expiresIn: 900 }));
    await expect(svc.login('u@example.com', 'pw')).resolves.toBeNull();
    return svc;
  }

  test('refresh token と access token をサーバーへ送り、API を呼ぶ時点でメモリとストレージは空になっている', async () => {
    const svc = await loggedIn();
    let snapshot: Record<string, string> | null = null;
    fetchMock.mockImplementationOnce(async () => {
      snapshot = { ...mockStorage };
      return res(200, {});
    });

    await svc.logout();

    expect(snapshot).toEqual({});
    expect(mockStorage).toEqual({});
    expect(svc.isAuthenticated).toBe(false);
    const [url, init] = callsTo('/api/auth/logout')[0];
    expect(url).toBe(`${AUTH_URL}/api/auth/logout`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ refreshToken: 'r1' });
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer a1' });
  });

  test('保留中の自動 refresh タイマーを止める', async () => {
    const svc = await loggedIn();
    expect(jest.getTimerCount()).toBeGreaterThan(0);
    fetchMock.mockResolvedValueOnce(res(200, {}));
    await svc.logout();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('ログアウト API が失敗しても、手元の token は消えていて例外にならない', async () => {
    const svc = await loggedIn();
    fetchMock.mockRejectedValueOnce(new TypeError('Network request failed'));
    await expect(svc.logout()).resolves.toBeUndefined();
    expect(mockStorage).toEqual({});
  });

  test('ストレージを読めなくても、ログアウトは続行する(access token は送る)', async () => {
    const svc = await loggedIn();
    mockGetItem.mockRejectedValueOnce(new Error('storage down'));
    fetchMock.mockResolvedValueOnce(res(200, {}));
    await svc.logout();
    const [, init] = callsTo('/api/auth/logout')[0];
    expect(JSON.parse(init.body)).toEqual({});
    expect(init.headers.Authorization).toBe('Bearer a1');
    expect(mockStorage).toEqual({});
  });

  test('保存された token が何も無ければ、サーバーへは送らない', async () => {
    const svc = await start();
    await svc.logout();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('ログアウト・再ログインとの競合 (古い結果を保存・消去しない)', () => {
  /** refresh を通信中の状態で止める */
  async function inFlight() {
    seedExpired();
    const d = deferred<Response>();
    fetchMock.mockReturnValueOnce(d.promise);
    const svc = await start();
    await flush();
    expect(refreshCalls()).toHaveLength(1);
    return { d, svc };
  }

  test('通信中にログアウトすると、成功した結果を書き戻さない', async () => {
    const { d, svc } = await inFlight();
    fetchMock.mockResolvedValueOnce(res(200, {})); // logout API

    await svc.logout();
    d.resolve(res(200, NEW_TOKENS));
    await flush();

    expect(mockStorage).toEqual({});
    expect(svc.isAuthenticated).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('ログアウト API の応答待ちの間にも、token は書き戻されない', async () => {
    const { d, svc } = await inFlight();
    const logoutResponse = deferred<Response>();
    fetchMock.mockReturnValueOnce(logoutResponse.promise);

    const loggingOut = svc.logout();
    await flush();
    d.resolve(res(200, NEW_TOKENS));
    await flush();
    expect(mockStorage).toEqual({});

    logoutResponse.resolve(res(200, {}));
    await loggingOut;
    expect(mockStorage).toEqual({});
    expect(jest.getTimerCount()).toBe(0);
  });

  test('応答本文の読み取り中にログアウトしても、書き戻さない', async () => {
    seedExpired();
    const body = deferred<unknown>();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () => body.promise,
    } as unknown as Response);
    const svc = await start();
    await flush();
    fetchMock.mockResolvedValueOnce(res(200, {})); // logout API

    await svc.logout();
    body.resolve(NEW_TOKENS);
    await flush();

    expect(mockStorage).toEqual({});
    expect(svc.isAuthenticated).toBe(false);
  });

  test('429 の待機中にログアウトすると、それ以上 refresh を呼ばない', async () => {
    seedExpired();
    fetchMock.mockResolvedValueOnce(res(429, {}, { 'Retry-After': '5' }));
    const svc = await start();
    await flush();
    expect(refreshCalls()).toHaveLength(1);
    fetchMock.mockResolvedValueOnce(res(200, {})); // logout API

    await svc.logout();
    await jest.advanceTimersByTimeAsync(60_000);

    expect(refreshCalls()).toHaveLength(1);
    expect(mockStorage).toEqual({});
  });

  test('429 の待機中にログアウト→再ログインしても、待機明けに新しい token で refresh しに行かない', async () => {
    seedExpired();
    fetchMock.mockResolvedValueOnce(res(429, {}, { 'Retry-After': '5' }));
    const svc = await start();
    await flush();
    fetchMock.mockResolvedValueOnce(res(200, {})); // logout API
    await svc.logout();
    fetchMock.mockResolvedValueOnce(res(200, { accessToken: 'a-new', refreshToken: 'r-new', expiresIn: 900 }));
    await svc.login('u@example.com', 'pw');

    await jest.advanceTimersByTimeAsync(5_000);

    expect(refreshCalls()).toHaveLength(1);
    expect(mockStorage[K.refresh]).toBe('r-new');
  });

  test('refresh token の読み取り中にログアウトされたら、読んだ旧い token で API を呼ばない', async () => {
    seedExpired();
    const readGate = deferred<string | null>();
    let gated = false;
    mockGetItem.mockImplementation((key: string) => {
      if (key === K.refresh && !gated) {
        gated = true;
        return readGate.promise;
      }
      return Promise.resolve(mockStorage[key] ?? null);
    });
    const svc = await start();
    await flush();
    fetchMock.mockResolvedValueOnce(res(200, {})); // logout API
    await svc.logout();

    readGate.resolve('r1'); // ログアウトで消える前に読み始めた旧い値
    await flush();
    mockGetItem.mockImplementation((key: string) => Promise.resolve(mockStorage[key] ?? null));

    expect(refreshCalls()).toHaveLength(0);
    expect(mockStorage).toEqual({});
  });

  test('保存の書き込み中にログアウトされたら、token も次の refresh のタイマーも残らない', async () => {
    seedExpired();
    const writeGate = deferred<void>();
    mockGate.setItem = writeGate.promise;
    fetchMock.mockResolvedValueOnce(res(200, NEW_TOKENS));
    const svc = await start();
    await flush(); // refresh 成功 → 保存の書き込み待ち
    expect(mockStorage[K.refresh]).toBe('r2');
    fetchMock.mockResolvedValueOnce(res(200, {})); // logout API

    await svc.logout();
    writeGate.resolve();
    await flush();

    expect(mockStorage).toEqual({});
    expect(svc.isAuthenticated).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('通信中に再ログインがあれば、旧い 401 でも新しいログインを消さない', async () => {
    const { d, svc } = await inFlight();
    fetchMock.mockResolvedValueOnce(res(200, { accessToken: 'a-new', refreshToken: 'r-new', expiresIn: 900 }));
    await svc.login('u@example.com', 'pw');

    d.resolve(res(401, {}));
    await flush();

    expect(mockStorage[K.refresh]).toBe('r-new');
    expect(svc.isAuthenticated).toBe(true);
  });

  test('通信中に再ログインがあれば、旧い成功の結果で新しいログインを上書きしない', async () => {
    const { d, svc } = await inFlight();
    fetchMock.mockResolvedValueOnce(res(200, { accessToken: 'a-new', refreshToken: 'r-new', expiresIn: 900 }));
    await svc.login('u@example.com', 'pw');

    d.resolve(res(200, NEW_TOKENS));
    await flush();

    expect(mockStorage[K.access]).toBe('a-new');
    expect(mockStorage[K.refresh]).toBe('r-new');
  });
});

describe('起動時の復元とログアウトの競合 (S-301)', () => {
  test('読み取り中にログアウトされたら、旧い値を復元せず、タイマーも張らない', async () => {
    mockStorage[K.access] = 'a1';
    mockStorage[K.refresh] = 'r1';
    mockStorage[K.expires] = String(nowSec() + 3600);
    const readGate = deferred<string | null>();
    let gated = false;
    mockGetItem.mockImplementation((key: string) => {
      if (key === K.access && !gated) {
        gated = true;
        return readGate.promise; // ログアウトで消える前に読み始めた旧い値
      }
      return Promise.resolve(mockStorage[key] ?? null);
    });
    const svc = await start();
    await flush();
    fetchMock.mockResolvedValueOnce(res(200, {})); // logout API
    await svc.logout();

    readGate.resolve('a1');
    await flush();
    mockGetItem.mockImplementation((key: string) => Promise.resolve(mockStorage[key] ?? null));

    expect(svc.isAuthenticated).toBe(false);
    expect(mockStorage).toEqual({});
    expect(jest.getTimerCount()).toBe(0);
  });

  test('読み取り中にログアウトされ、ストレージの読み取りが失敗しても、新しい状態を消さない', async () => {
    mockStorage[K.access] = 'a1';
    mockStorage[K.expires] = String(nowSec() + 3600);
    const readGate = deferred<string | null>();
    let gated = false;
    mockGetItem.mockImplementation((key: string) => {
      if (key === K.access && !gated) {
        gated = true;
        return readGate.promise;
      }
      return Promise.resolve(mockStorage[key] ?? null);
    });
    const svc = await start();
    await flush();
    fetchMock.mockResolvedValueOnce(res(200, { accessToken: 'a-new', refreshToken: 'r-new', expiresIn: 900 }));
    await svc.login('u@example.com', 'pw'); // 再ログイン

    readGate.reject(new Error('storage down')); // 旧い読み取りの失敗が、新しいログインを消してはならない
    await flush();
    mockGetItem.mockImplementation((key: string) => Promise.resolve(mockStorage[key] ?? null));

    expect(mockStorage[K.refresh]).toBe('r-new');
    expect(svc.isAuthenticated).toBe(true);
  });
});

describe('ログアウトが先に始まっている場合の復元 (S-301R)', () => {
  test('ログアウトの消去が終わる前に復元が始まっても、旧い値を復元しない', async () => {
    const svc = await start();
    await flush();
    mockStorage[K.access] = 'a1';
    mockStorage[K.refresh] = 'r1';
    mockStorage[K.expires] = String(nowSec() + 3600);
    const removeGate = deferred<void>();
    mockGate.removeItem = removeGate.promise;
    fetchMock.mockResolvedValueOnce(res(200, {})); // logout API

    const loggingOut = svc.logout();
    await flush();
    expect(mockStorage[K.access]).toBe('a1'); // まだ消えていない

    svc.configure({ apiUrl: 'https://api.example.com', projectId: 'p', authUrl: AUTH_URL }); // 復元が始まる
    await flush();
    expect(svc.isAuthenticated).toBe(false);

    removeGate.resolve();
    await loggingOut;
    await flush();

    expect(svc.isAuthenticated).toBe(false);
    expect(mockStorage).toEqual({});
    expect(jest.getTimerCount()).toBe(0);
  });

  test('ログアウトの進行中に始まった復元が、読み取り中にログアウトの完了を迎えても、旧い値を戻さない', async () => {
    const svc = await start();
    await flush();
    mockStorage[K.access] = 'a1';
    mockStorage[K.refresh] = 'r1';
    mockStorage[K.expires] = String(nowSec() + 3600);
    const removeGate = deferred<void>();
    const readGate = deferred<string | null>();
    mockGate.removeItem = removeGate.promise;
    fetchMock.mockResolvedValueOnce(res(200, {})); // logout API
    const loggingOut = svc.logout();
    await flush();

    let gated = false;
    mockGetItem.mockImplementation((key: string) => {
      if (key === K.access && !gated) {
        gated = true;
        return readGate.promise; // 復元が読み始めた旧い値
      }
      return Promise.resolve(mockStorage[key] ?? null);
    });
    svc.configure({ apiUrl: 'https://api.example.com', projectId: 'p', authUrl: AUTH_URL });
    await flush();

    removeGate.resolve();
    await loggingOut; // ログアウトが完了(印は下りた。世代番号は復元の開始前から変わっていない)
    readGate.resolve('a1');
    await flush();
    mockGetItem.mockImplementation((key: string) => Promise.resolve(mockStorage[key] ?? null));

    expect(svc.isAuthenticated).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('ログアウトが例外で終わっても印は下りる(その後の復元はできる)', async () => {
    const svc = await start();
    await flush();
    mockStorage[K.refresh] = 'r-old';
    mockGate.removeItem = Promise.reject(new Error('storage down')); // 消去の失敗
    await expect(svc.logout()).rejects.toThrow('storage down');
    mockGate.removeItem = null;
    Object.keys(mockStorage).forEach((k) => delete mockStorage[k]);
    mockStorage[K.access] = 'a9';
    mockStorage[K.refresh] = 'r9';
    mockStorage[K.expires] = String(nowSec() + 3600);

    svc.configure({ apiUrl: 'https://api.example.com', projectId: 'p', authUrl: AUTH_URL });
    await flush();

    expect(svc.isAuthenticated).toBe(true);
  });
});

describe('refresh 成功で、一時的な失敗の通算回数(再スケジュールの上限)が戻る (R-102)', () => {
  test('3 回再スケジュールした後に成功すると、上限が戻り、再び 5 回まで再試行できる', async () => {
    seedExpired();
    let n = 0;
    fetchMock.mockImplementation(async () => {
      n++;
      if (n === 13) return res(200, { accessToken: 'a2', refreshToken: 'r2', expiresIn: 301 }); // 4 回目の refresh の初回で成功
      throw new TypeError('Network request failed');
    });
    await start();
    await jest.advanceTimersByTimeAsync(60 * 60 * 1000);

    // 失敗 3 回の refresh(各 4 回)= 12、成功 1 回 = 13、その後の失敗は、上限が戻っていれば 6 回の refresh × 4 回 = 24
    expect(fetchMock).toHaveBeenCalledTimes(13 + 24);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('再ログインで旧い系列を失効させる (S-303)', () => {
  const logoutCalls = () => callsTo('/api/auth/logout');
  const NEW_LOGIN = { accessToken: 'a-new', refreshToken: 'r-new', expiresIn: 900 };

  test('保存済みの refresh token が新しい値と違えば、旧い値をログアウト API へ送る', async () => {
    mockStorage[K.access] = 'a-old';
    mockStorage[K.refresh] = 'r-old';
    mockStorage[K.expires] = String(nowSec() + 3600);
    const svc = await start();
    await flush();
    fetchMock.mockResolvedValueOnce(res(200, NEW_LOGIN)).mockResolvedValueOnce(res(200, {}));

    await expect(svc.login('u@example.com', 'pw')).resolves.toBeNull();
    await flush();

    expect(mockStorage[K.refresh]).toBe('r-new');
    expect(logoutCalls()).toHaveLength(1);
    expect(JSON.parse(logoutCalls()[0][1].body)).toEqual({ refreshToken: 'r-old' });
    // 旧い access token を Bearer で付ける (R-101: Bearer なしだと cookie 経路に入り、新しいログインのセッションを消すおそれ)
    expect(logoutCalls()[0][1].headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer a-old' });
  });

  test('旧い access token が期限切れでも Bearer で送る(token 経路に入り、cookie に触れない)', async () => {
    mockStorage[K.access] = 'a-expired';
    mockStorage[K.refresh] = 'r-old';
    mockStorage[K.expires] = String(nowSec() - 100);
    mockGetItem.mockImplementation((key: string) => Promise.resolve(mockStorage[key] ?? null));
    const svc = await start();
    // 起動時の refresh(期限切れ)を一時的に失敗させ、旧い token を残したまま再ログインする
    fetchMock.mockRejectedValue(new TypeError('Network request failed'));
    await flush();
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(res(200, NEW_LOGIN)).mockResolvedValueOnce(res(200, {}));

    await svc.login('u@example.com', 'pw');
    await flush();

    expect(logoutCalls()).toHaveLength(1);
    expect(logoutCalls()[0][1].headers.Authorization).toBe('Bearer a-expired');
  });

  test('旧い access token が無ければ、失効の要求は送らない(Bearer なしで cookie 経路に入らない)', async () => {
    mockStorage[K.refresh] = 'r-old';
    const svc = await start();
    await flush();
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(res(200, NEW_LOGIN));

    await svc.login('u@example.com', 'pw');
    await flush();

    expect(mockStorage[K.refresh]).toBe('r-new');
    expect(logoutCalls()).toHaveLength(0);
  });

  test('初回ログイン(旧い token が無い)では送らない', async () => {
    const svc = await start();
    fetchMock.mockResolvedValueOnce(res(200, NEW_LOGIN));
    await svc.login('u@example.com', 'pw');
    await flush();
    expect(logoutCalls()).toHaveLength(0);
  });

  test('旧い token が新しい値と同じなら送らない(自分の系列を失効させない)', async () => {
    mockStorage[K.access] = 'a-old'; // 旧い access token もある状態で、refresh token だけが同じ
    mockStorage[K.refresh] = 'r-new';
    const svc = await start();
    fetchMock.mockResolvedValueOnce(res(200, NEW_LOGIN));
    await svc.login('u@example.com', 'pw');
    await flush();
    expect(logoutCalls()).toHaveLength(0);
  });

  test('失効の要求が失敗しても、ログインは成功する', async () => {
    mockStorage[K.access] = 'a-old';
    mockStorage[K.refresh] = 'r-old';
    const svc = await start();
    fetchMock.mockResolvedValueOnce(res(200, NEW_LOGIN)).mockRejectedValueOnce(new TypeError('Network request failed'));
    await expect(svc.login('u@example.com', 'pw')).resolves.toBeNull();
    await flush();
    expect(mockStorage[K.refresh]).toBe('r-new');
  });

  test('ログイン成功で、一時的な失敗の通算回数(再スケジュールの上限)が戻る', async () => {
    seedExpired();
    fetchMock.mockRejectedValue(new TypeError('Network request failed'));
    const svc = await start();
    await jest.advanceTimersByTimeAsync(60 * 60 * 1000); // 通算 5 回使い切って停止
    expect(jest.getTimerCount()).toBe(0);

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(res(200, { accessToken: 'a-new', refreshToken: 'r-new', expiresIn: 301 }));
    fetchMock.mockResolvedValueOnce(res(200, {})); // 旧い系列の失効
    await svc.login('u@example.com', 'pw');
    await flush();
    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new TypeError('Network request failed'));
    await jest.advanceTimersByTimeAsync(1000 + 7000); // 1 秒後の自動 refresh が一時的に失敗して終わる

    // 上限が戻っていれば、60 秒後の再試行が再び予約される
    expect(jest.getTimerCount()).toBe(1);
  });
});
