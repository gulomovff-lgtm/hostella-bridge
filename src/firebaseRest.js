'use strict';
/**
 * firebaseRest — Firebase без SDK: Identity Toolkit, Secure Token, Firestore
 * REST и вызов callable-функций.
 *
 * ── ПОЧЕМУ REST, А НЕ SDK ────────────────────────────────────────────────
 *
 * Мост входит одноразовым кодом и получает custom token (час жизни). Дальше
 * ему нужно жить неделями без человека — значит, хранить refresh token и
 * обновлять по нему ID token. У JS SDK нет входа «по refresh token»: после
 * перезапуска он потребовал бы новый custom token, то есть новый код у
 * администратора. REST даёт ровно то, что нужно: обмен кода → токены,
 * обновление по refresh token, чтение и запись документов с этим токеном.
 * Правила Firestore при этом те же, что для SDK: роль `bridge`, только свой
 * филиал.
 *
 * Модуль без Electron и без побочных эффектов (tests/firebaseRest.test.mjs).
 */

class RestError extends Error {
  constructor(message, { status = 0, code = '', body = null } = {}) {
    super(message);
    this.name = 'RestError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/** Ошибка сети/недоступности — её можно повторить, это не отказ правил. */
const isTransient = (e) => !e || e.name === 'TypeError' || e.status === 0 || e.status >= 500 || e.status === 429;

// ── Кодек значений Firestore REST ─────────────────────────────────────────

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);

/** JS → значение REST. Вложенный массив Firestore не принимает — склеиваем в строку. */
function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return { nullValue: null };
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) {
    return { arrayValue: { values: v.map((x) => (Array.isArray(x) ? { stringValue: x.map((c) => String(c ?? '')).join(' | ') } : toValue(x))) } };
  }
  if (isPlain(v)) return { mapValue: { fields: toFields(v) } };
  return { stringValue: String(v) };
}

function toFields(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || typeof v === 'function') continue;
    out[k] = toValue(v);
  }
  return out;
}

/** Значение REST → JS. Timestamp остаётся строкой ISO: мосту с датами не считать. */
function fromValue(f) {
  if (!f || typeof f !== 'object') return undefined;
  if ('stringValue' in f) return f.stringValue;
  if ('integerValue' in f) return Number(f.integerValue);
  if ('doubleValue' in f) return f.doubleValue;
  if ('booleanValue' in f) return f.booleanValue;
  if ('nullValue' in f) return null;
  if ('timestampValue' in f) return f.timestampValue;
  if ('arrayValue' in f) return ((f.arrayValue && f.arrayValue.values) || []).map(fromValue);
  if ('mapValue' in f) return fromFields((f.mapValue && f.mapValue.fields) || {});
  if ('referenceValue' in f) return f.referenceValue;
  if ('geoPointValue' in f) return f.geoPointValue;
  if ('bytesValue' in f) return f.bytesValue;
  return undefined;
}

function fromFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = fromValue(v);
  return out;
}

/** Документ REST → плоский объект с `id`, `path` (полное имя) и `updateTime`. */
function fromDoc(doc) {
  if (!doc || !doc.name) return null;
  return {
    ...fromFields(doc.fields),
    id: doc.name.split('/').pop(),
    path: doc.name,
    updateTime: doc.updateTime || null,
    createTime: doc.createTime || null,
  };
}

// ── HTTP ──────────────────────────────────────────────────────────────────

async function readJson(res) {
  const text = await res.text();
  try { return text ? JSON.parse(text) : null; } catch { return { raw: text }; }
}

function restError(res, body, fallback) {
  const err = body && body.error;
  const message = (err && (err.message || err.status)) || (body && body.raw) || fallback || `HTTP ${res.status}`;
  return new RestError(String(message).slice(0, 300), { status: res.status, code: (err && (err.status || err.code)) || '', body });
}

/**
 * Firestore REST для одной базы. `getToken` отдаёт свежий ID token.
 */
class Firestore {
  constructor({ base, projectId, databaseId = '(default)', getToken, fetchImpl = globalThis.fetch }) {
    this.base = String(base).replace(/\/$/, '');
    this.projectId = projectId;
    this.databaseId = databaseId;
    this.getToken = getToken;
    this.fetch = fetchImpl;
  }

  get root() { return `${this.base}/v1/projects/${this.projectId}/databases/${this.databaseId}/documents`; }
  docName(path) { return `projects/${this.projectId}/databases/${this.databaseId}/documents/${path}`; }

  async request(method, url, body) {
    const token = this.getToken ? await this.getToken() : null;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    let res;
    try {
      res = await this.fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      throw new RestError(`сеть: ${(e && e.message) || e}`, { status: 0 });
    }
    const json = await readJson(res);
    if (!res.ok) throw restError(res, json);
    return json;
  }

  /** Документ или null, если его нет. */
  async get(path) {
    try {
      return fromDoc(await this.request('GET', `${this.root}/${path}`));
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  /**
   * Частичное обновление: меняются только перечисленные поля (по умолчанию —
   * ключи `data`). Документа может не быть — тогда он создаётся.
   */
  async patch(path, data, { mask } = {}) {
    const fields = toFields(data);
    const keys = mask || Object.keys(fields);
    const qs = keys.map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
    return fromDoc(await this.request('PATCH', `${this.root}/${path}?${qs}`, { fields }));
  }

  /**
   * Обновление с предусловием «документ не менялся с `updateTime`».
   * Так мост забирает задачу: два моста одного филиала не возьмут одну.
   * @returns {boolean} false — документ уже изменил кто-то другой
   */
  async commitUpdate(path, data, { updateTime }) {
    const fields = toFields(data);
    const write = {
      update: { name: this.docName(path), fields },
      updateMask: { fieldPaths: Object.keys(fields) },
    };
    if (updateTime) write.currentDocument = { updateTime };
    try {
      await this.request('POST', `${this.root}:commit`, { writes: [write] });
      return true;
    } catch (e) {
      if (e.status === 409 || /FAILED_PRECONDITION|precondition/i.test(String(e.code) + String(e.message))) return false;
      throw e;
    }
  }

  /** Запрос по коллекции внутри `parentPath` (например, `tenants/t1`). */
  async runQuery(parentPath, structuredQuery) {
    const rows = await this.request('POST', `${this.root}/${parentPath}:runQuery`, { structuredQuery });
    return (Array.isArray(rows) ? rows : []).filter((r) => r && r.document).map((r) => fromDoc(r.document));
  }
}

/** Условие равенства для structuredQuery. */
const whereEq = (field, value) => ({ fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: toValue(value) } });
const whereAll = (...filters) => ({ compositeFilter: { op: 'AND', filters } });

// ── Функции и токены ──────────────────────────────────────────────────────

/** Вызов callable-функции без сессии (как делает SDK: `{ data }` → `{ result }`). */
async function callFunction(base, name, data, { token = null, fetchImpl = globalThis.fetch } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetchImpl(`${String(base).replace(/\/$/, '')}/${name}`, { method: 'POST', headers, body: JSON.stringify({ data }) });
  } catch (e) {
    throw new RestError(`сеть: ${(e && e.message) || e}`, { status: 0 });
  }
  const json = await readJson(res);
  if (!res.ok || (json && json.error)) throw restError(res, json, 'функция отказала');
  return json ? json.result : null;
}

/** Custom token → ID token + refresh token. */
async function signInWithCustomToken(identityBase, apiKey, token, { fetchImpl = globalThis.fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(`${identityBase}/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, returnSecureToken: true }),
    });
  } catch (e) {
    throw new RestError(`сеть: ${(e && e.message) || e}`, { status: 0 });
  }
  const json = await readJson(res);
  if (!res.ok) throw restError(res, json, 'вход не удался');
  return { idToken: json.idToken, refreshToken: json.refreshToken, expiresIn: Number(json.expiresIn) || 3600 };
}

/** Свежий ID token по refresh token. Refresh token может смениться — возвращаем оба. */
async function refreshIdToken(tokenBase, apiKey, refreshToken, { fetchImpl = globalThis.fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(`${tokenBase}/v1/token?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
    });
  } catch (e) {
    throw new RestError(`сеть: ${(e && e.message) || e}`, { status: 0 });
  }
  const json = await readJson(res);
  if (!res.ok) throw restError(res, json, 'токен не обновился');
  return { idToken: json.id_token, refreshToken: json.refresh_token || refreshToken, expiresIn: Number(json.expires_in) || 3600, uid: json.user_id };
}

/** Полезная нагрузка JWT без проверки подписи — нам нужны только claims. */
function decodeJwt(token) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

module.exports = {
  RestError, isTransient,
  toValue, toFields, fromValue, fromFields, fromDoc,
  Firestore, whereEq, whereAll,
  callFunction, signInWithCustomToken, refreshIdToken, decodeJwt,
};
