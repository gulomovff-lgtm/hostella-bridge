/**
 * Сессия моста (src/auth.js): код → токены, обновление по refresh token,
 * распознавание «отключён администратором».
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import authMod from '../src/auth.js';
import storeMod from '../src/store.js';
import cfg from '../src/config.js';

const { Session } = authMod;
const { Store } = storeMod;

const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const CLAIMS = { tid: 't1', rol: 'bridge', brs: ['b1'], user_id: 't1__bridge__b1' };
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const fakeFetch = (routes) => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body });
    for (const [re, resp] of routes) {
      if (re.test(String(url))) {
        const r = typeof resp === 'function' ? resp(calls.length) : resp;
        return { ok: (r.status || 200) < 400, status: r.status || 200, text: async () => JSON.stringify(r.body) };
      }
    }
    return { ok: false, status: 404, text: async () => '{}' };
  };
  return calls;
};

const fresh = () => {
  const file = join(mkdtempSync(join(tmpdir(), 'bridge-auth-')), 'bridge.json');
  const store = new Store({ file });
  return { store, session: new Session({ profile: cfg.DEMO, store, host: 'PC', version: '0.1.0', log: { info() {}, warn() {} } }) };
};

describe('Session', () => {
  test('код → custom token → пара токенов; помним арендатора и филиал', async () => {
    const calls = fakeFetch([
      [/redeemBridgePairing/, { body: { result: { customToken: 'ct', tenantId: 't1', branchId: 'b1' } } }],
      [/signInWithCustomToken/, { body: { idToken: jwt(CLAIMS), refreshToken: 'rt1', expiresIn: '3600' } }],
    ]);
    const { store, session } = fresh();
    assert.equal(session.isPaired, false);
    const p = await session.pair(' abcd-efgh-jklm ');
    assert.deepEqual([p.tenantId, p.branchId], ['t1', 'b1']);
    assert.match(calls[0].body, /"code":"ABCD-EFGH-JKLM"/);
    assert.match(calls[0].body, /"host":"PC"/);
    assert.equal(store.getSecret('refreshToken'), 'rt1');
    assert.equal(session.isPaired, true);
    assert.equal(await session.getIdToken(), jwt(CLAIMS), 'свежий токен из кеша, без похода за refresh');
    assert.equal(calls.length, 2);
  });

  test('неверный код — понятная ошибка, ничего не сохранено', async () => {
    fakeFetch([[/redeemBridgePairing/, { status: 403, body: { error: { message: 'Код не подходит или истёк.', status: 'PERMISSION_DENIED' } } }]]);
    const { store, session } = fresh();
    await assert.rejects(() => session.pair('XXXX'), /Код не подходит/);
    assert.equal(store.get('pairing'), null);
  });

  test('после перезапуска токен берётся по refresh token, ротация запоминается', async () => {
    const calls = fakeFetch([[/securetoken/, { body: { id_token: jwt(CLAIMS), refresh_token: 'rt2', expires_in: '3600' } }]]);
    const { store, session } = fresh();
    store.set('pairing', { tenantId: 't1', branchId: 'b1' });
    store.setSecret('refreshToken', 'rt1');
    const s2 = new Session({ profile: cfg.DEMO, store, log: { info() {}, warn() {} } });
    assert.equal(await s2.getIdToken(), jwt(CLAIMS));
    assert.match(String(calls[0].body), /refresh_token=rt1/);
    assert.equal(store.getSecret('refreshToken'), 'rt2');
    assert.equal((await s2.check()).ok, true);
    void session;
  });

  test('учётку выключили в кассе — ошибка помечена как отзыв', async () => {
    fakeFetch([[/securetoken/, { status: 400, body: { error: { message: 'USER_DISABLED', status: 'INVALID_ARGUMENT' } } }]]);
    const { store } = fresh();
    store.set('pairing', { tenantId: 't1', branchId: 'b1' });
    store.setSecret('refreshToken', 'rt1');
    const s = new Session({ profile: cfg.DEMO, store, log: { info() {}, warn() {} } });
    const c = await s.check();
    assert.equal(c.ok, false);
    assert.equal(c.reason, 'revoked');
  });

  test('токен не того филиала не проходит проверку', async () => {
    fakeFetch([[/securetoken/, { body: { id_token: jwt({ ...CLAIMS, brs: ['b2'] }), refresh_token: 'rt1', expires_in: '3600' } }]]);
    const { store } = fresh();
    store.set('pairing', { tenantId: 't1', branchId: 'b1' });
    store.setSecret('refreshToken', 'rt1');
    const s = new Session({ profile: cfg.DEMO, store, log: { info() {}, warn() {} } });
    assert.equal((await s.check()).reason, 'branch');
  });
});
