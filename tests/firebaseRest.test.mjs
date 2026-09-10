/**
 * Firebase без SDK: кодек значений, обновление с маской и предусловием,
 * вызов функций и токены (src/firebaseRest.js).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import rest from '../src/firebaseRest.js';

const {
  toValue, fromValue, toFields, fromDoc, Firestore, whereEq, whereAll,
  callFunction, refreshIdToken, signInWithCustomToken, decodeJwt, RestError, isTransient,
} = rest;

const mockFetch = (handler) => {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body ? (() => { try { return JSON.parse(init.body); } catch { return init.body; } })() : undefined });
    const r = handler(calls[calls.length - 1], calls.length);
    const status = r.status || 200;
    return { ok: status < 400, status, text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)) };
  };
  fn.calls = calls;
  return fn;
};

describe('кодек значений', () => {
  test('туда и обратно без потерь', () => {
    const src = { s: 'x', i: 7, d: 1.5, b: true, n: null, arr: [1, 'a', { k: 2 }], map: { deep: { z: 'q' } } };
    assert.deepEqual(fromValue(toValue(src)), src);
  });
  test('дата — timestamp, вложенный массив — строка через « | »', () => {
    const v = toValue({ at: new Date('2026-09-11T10:00:00.000Z'), rows: [['a', 'b'], 'c'] });
    assert.equal(v.mapValue.fields.at.timestampValue, '2026-09-11T10:00:00.000Z');
    assert.deepEqual(fromValue(v.mapValue.fields.rows), ['a | b', 'c']);
  });
  test('undefined и функции в документ не попадают, NaN — null', () => {
    const f = toFields({ a: 1, u: undefined, fn: () => 1, nan: NaN });
    assert.deepEqual(Object.keys(f), ['a', 'nan']);
    assert.deepEqual(f.nan, { nullValue: null });
  });
  test('fromDoc: id, путь и время правки', () => {
    const d = fromDoc({ name: 'projects/p/databases/d/documents/tenants/t/emehmonJobs/j1', updateTime: '2026-09-11T00:00:00Z', fields: { status: { stringValue: 'pending' } } });
    assert.equal(d.id, 'j1');
    assert.equal(d.status, 'pending');
    assert.equal(d.updateTime, '2026-09-11T00:00:00Z');
    assert.equal(fromDoc(null), null);
  });
  test('условия запроса', () => {
    const w = whereAll(whereEq('hostelId', 'b1'), whereEq('status', 'pending'));
    assert.equal(w.compositeFilter.op, 'AND');
    assert.equal(w.compositeFilter.filters[1].fieldFilter.value.stringValue, 'pending');
  });
});

describe('Firestore REST', () => {
  const mk = (handler) => {
    const f = mockFetch(handler);
    const fs = new Firestore({ base: 'http://x', projectId: 'p', databaseId: 'cloud', getToken: async () => 'TOKEN', fetchImpl: f });
    return { fs, f };
  };

  test('patch: маска из ключей, токен в заголовке', async () => {
    const { fs, f } = mk(() => ({ body: { name: 'projects/p/databases/cloud/documents/tenants/t/bridges/b1', fields: { at: { timestampValue: 'x' } } } }));
    const d = await fs.patch('tenants/t/bridges/b1', { at: new Date(0), queue: 2 });
    const c = f.calls[0];
    assert.equal(c.method, 'PATCH');
    assert.match(c.url, /documents\/tenants\/t\/bridges\/b1\?updateMask\.fieldPaths=at&updateMask\.fieldPaths=queue$/);
    assert.equal(c.headers.Authorization, 'Bearer TOKEN');
    assert.equal(c.body.fields.queue.integerValue, '2');
    assert.equal(d.id, 'b1');
  });

  test('commitUpdate: предусловие по updateTime; чужая правка — false, прочее — исключение', async () => {
    const { fs, f } = mk((c, n) => (n === 1 ? { body: {} } : n === 2 ? { status: 409, body: { error: { status: 'FAILED_PRECONDITION', message: 'stale' } } } : { status: 403, body: { error: { status: 'PERMISSION_DENIED', message: 'nope' } } }));
    assert.equal(await fs.commitUpdate('tenants/t/emehmonJobs/j1', { status: 'claimed' }, { updateTime: 'T1' }), true);
    const w = f.calls[0].body.writes[0];
    assert.equal(w.currentDocument.updateTime, 'T1');
    assert.deepEqual(w.updateMask.fieldPaths, ['status']);
    assert.match(w.update.name, /documents\/tenants\/t\/emehmonJobs\/j1$/);
    assert.equal(await fs.commitUpdate('tenants/t/emehmonJobs/j1', { status: 'claimed' }, { updateTime: 'T1' }), false);
    await assert.rejects(() => fs.commitUpdate('tenants/t/emehmonJobs/j1', { status: 'claimed' }, { updateTime: 'T1' }), (e) => e instanceof RestError && e.status === 403);
  });

  test('get: 404 — null; runQuery — только строки с документом', async () => {
    const { fs } = mk((c) => (c.method === 'GET' ? { status: 404, body: { error: { message: 'no' } } }
      : { body: [{ readTime: 'x' }, { document: { name: 'projects/p/databases/cloud/documents/tenants/t/emehmonJobs/j2', fields: { status: { stringValue: 'pending' } } } }] }));
    assert.equal(await fs.get('tenants/t/emehmonJobs/none'), null);
    const rows = await fs.runQuery('tenants/t', { from: [{ collectionId: 'emehmonJobs' }] });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'j2');
  });

  test('сеть упала — RestError со статусом 0, считается временной', async () => {
    const fs = new Firestore({ base: 'http://x', projectId: 'p', getToken: async () => 't', fetchImpl: async () => { throw new TypeError('fetch failed'); } });
    await assert.rejects(() => fs.get('a/b'), (e) => e instanceof RestError && e.status === 0 && isTransient(e));
  });
});

describe('функции и токены', () => {
  test('callFunction: {data} → result; ошибка функции — RestError с кодом', async () => {
    const ok = mockFetch(() => ({ body: { result: { customToken: 'ct' } } }));
    assert.deepEqual(await callFunction('http://f', 'redeemBridgePairing', { code: 'X' }, { fetchImpl: ok }), { customToken: 'ct' });
    assert.deepEqual(ok.calls[0].body, { data: { code: 'X' } });
    const bad = mockFetch(() => ({ status: 403, body: { error: { message: 'Код не подходит или истёк.', status: 'PERMISSION_DENIED' } } }));
    await assert.rejects(() => callFunction('http://f', 'redeemBridgePairing', {}, { fetchImpl: bad }), (e) => /Код не подходит/.test(e.message) && e.code === 'PERMISSION_DENIED');
  });
  test('signInWithCustomToken и refreshIdToken', async () => {
    const f1 = mockFetch(() => ({ body: { idToken: 'id1', refreshToken: 'rt1', expiresIn: '3600' } }));
    const t = await signInWithCustomToken('http://id', 'KEY', 'ct', { fetchImpl: f1 });
    assert.deepEqual(t, { idToken: 'id1', refreshToken: 'rt1', expiresIn: 3600 });
    assert.match(f1.calls[0].url, /accounts:signInWithCustomToken\?key=KEY$/);
    const f2 = mockFetch(() => ({ body: { id_token: 'id2', refresh_token: 'rt2', expires_in: '3600', user_id: 'u' } }));
    const r = await refreshIdToken('http://tok', 'KEY', 'rt1', { fetchImpl: f2 });
    assert.equal(r.idToken, 'id2');
    assert.equal(r.refreshToken, 'rt2');
    assert.match(String(f2.calls[0].body), /grant_type=refresh_token&refresh_token=rt1/);
  });
  test('decodeJwt читает claims без проверки подписи', () => {
    const payload = Buffer.from(JSON.stringify({ tid: 't1', rol: 'bridge', brs: ['b1'] })).toString('base64url');
    assert.deepEqual(decodeJwt(`h.${payload}.s`), { tid: 't1', rol: 'bridge', brs: ['b1'] });
    assert.equal(decodeJwt('мусор'), null);
  });
});
