'use strict';
/**
 * auth — подключение моста к Hosti Cloud и жизнь его сессии.
 *
 * Подключение: администратор в кассе нажимает «Подключить мост» и получает
 * код на 15 минут; код вводится здесь. `redeemBridgePairing` обменивает его
 * на custom token учётки моста (роль `bridge`, только свой филиал), custom
 * token — на пару ID token + refresh token. Дальше мост живёт по refresh
 * token: ID token обновляется сам, код больше не нужен.
 *
 * «Отключить мост» в кассе выключает учётку — обновление токена начнёт
 * отказывать, и мост честно покажет «отключён администратором».
 */
const { callFunction, signInWithCustomToken, refreshIdToken, decodeJwt, RestError, isTransient } = require('./firebaseRest');

const EARLY_MS = 60 * 1000; // обновляем токен за минуту до истечения

class Session {
  constructor({ profile, store, host = '', version = '', log = console }) {
    this.profile = profile;
    this.store = store;
    this.host = host;
    this.version = version;
    this.log = log;
    this.idToken = null;
    this.expiresAt = 0;
    this.lastError = null;
  }

  /** { tenantId, branchId, uid, pairedAt } или null. */
  get pairing() { return this.store.get('pairing'); }
  get isPaired() { return !!(this.pairing && this.store.hasSecret('refreshToken')); }

  /**
   * Обменять код подключения на сессию.
   * @returns {{tenantId: string, branchId: string}}
   */
  async pair(rawCode) {
    const code = String(rawCode || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!code) throw new RestError('Введите код подключения', { code: 'invalid-argument' });
    const result = await callFunction(this.profile.functionsBase, 'redeemBridgePairing', {
      code, host: this.host.slice(0, 80), version: this.version.slice(0, 32),
    });
    if (!result || !result.customToken) throw new RestError('Сервер не вернул токен', { code: 'internal' });
    const tokens = await signInWithCustomToken(this.profile.identityBase, this.profile.apiKey, result.customToken);
    const claims = decodeJwt(tokens.idToken) || {};
    const pairing = {
      tenantId: result.tenantId || claims.tid || null,
      branchId: result.branchId || (Array.isArray(claims.brs) ? claims.brs[0] : null),
      uid: claims.user_id || claims.sub || null,
      pairedAt: new Date().toISOString(),
      profile: this.profile.name,
    };
    if (!pairing.tenantId || !pairing.branchId) throw new RestError('В ответе нет филиала', { code: 'internal' });
    this.store.setSecret('refreshToken', tokens.refreshToken);
    this.store.set('pairing', pairing);
    this.idToken = tokens.idToken;
    this.expiresAt = Date.now() + tokens.expiresIn * 1000;
    this.lastError = null;
    return pairing;
  }

  /** Свежий ID token; обновляет по refresh token, когда до истечения меньше минуты. */
  async getIdToken() {
    if (this.idToken && Date.now() < this.expiresAt - EARLY_MS) return this.idToken;
    const rt = this.store.getSecret('refreshToken');
    if (!rt) throw new RestError('Мост не подключён', { code: 'unpaired' });
    try {
      const t = await refreshIdToken(this.profile.tokenBase, this.profile.apiKey, rt);
      if (t.refreshToken && t.refreshToken !== rt) this.store.setSecret('refreshToken', t.refreshToken);
      this.idToken = t.idToken;
      this.expiresAt = Date.now() + t.expiresIn * 1000;
      this.lastError = null;
      return this.idToken;
    } catch (e) {
      this.lastError = e;
      // Учётку выключили в кассе («Отключить мост») или удалили — дальше
      // бессмысленно: refresh token мёртв. Сеть — дело другое, пробуем позже.
      if (!isTransient(e) && /USER_DISABLED|TOKEN_EXPIRED|INVALID_REFRESH_TOKEN|USER_NOT_FOUND/i.test(String(e.message))) {
        e.revoked = true;
      }
      throw e;
    }
  }

  /** Claims текущего ID token (tid, brs, rol, pln, sst) или null. */
  claims() { return this.idToken ? decodeJwt(this.idToken) : null; }

  /** Совпадает ли то, что помним, с тем, что говорит токен. */
  async check() {
    try {
      await this.getIdToken();
    } catch (e) {
      return { ok: false, reason: e.revoked ? 'revoked' : (isTransient(e) ? 'offline' : 'error'), message: e.message };
    }
    const c = this.claims() || {};
    const p = this.pairing || {};
    if (c.rol !== 'bridge') return { ok: false, reason: 'role', message: `роль токена: ${c.rol || 'нет'}` };
    if (c.tid !== p.tenantId) return { ok: false, reason: 'tenant', message: 'арендатор токена не совпадает' };
    if (!Array.isArray(c.brs) || !c.brs.includes(p.branchId)) return { ok: false, reason: 'branch', message: 'филиал токена не совпадает' };
    return { ok: true, claims: c };
  }

  unpair() {
    this.store.set('pairing', null);
    this.store.setSecret('refreshToken', null);
    this.idToken = null;
    this.expiresAt = 0;
  }
}

module.exports = { Session };
