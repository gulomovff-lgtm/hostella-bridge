'use strict';
/**
 * portal — окно e-mehmon и боевые скрипты в нём.
 *
 * Скрипты — из Hostella (electron/emehmonAutofill.js), без изменений: они
 * обкатаны на живом портале. Здесь только то, что в кассе делал main.js:
 * скрытое окно в сессии филиала, запрет ухода с emehmon.uz, лёгкая сессия
 * без картинок и шрифтов, вход кассира в видимом окне с подставленными
 * логином и паролем (капчу и кнопку «Войти» нажимает человек).
 *
 * Мост никогда не показывает окно портала ради результата мастера — итог
 * уходит кассе, а кассир видит его в своей карточке гостя. Окно видно
 * ровно в одном случае: нужен вход.
 */
const { BrowserWindow, session } = require('electron');
const scripts = require('../electron/emehmonAutofill');
const { TIMING } = require('./config');

const ORIGIN = 'https://emehmon.uz';
const safeId = (s) => String(s || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32) || 'branch';
const isEmehmonUrl = (url) => {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return h === 'emehmon.uz' || h.endsWith('.emehmon.uz');
  } catch { return false; }
};
const isLoginUrl = (url) => /\/login(\b|\/|\?|$)/i.test(String(url || ''));

const lightPartitions = new Set();

class Portal {
  /**
   * @param {object} p
   * @param {string} p.branchId
   * @param {Function} p.getCreds  → { login, password } | null
   * @param {object} [p.log]
   * @param {Function} [p.onLoginOk]  вход выполнен — можно продолжать очередь
   * @param {Function} [p.onLoginShown]
   */
  constructor({ branchId, getCreds, log = console, onLoginOk = () => {}, onLoginShown = () => {} }) {
    this.branchId = branchId;
    this.getCreds = getCreds;
    this.log = log;
    this.onLoginOk = onLoginOk;
    this.onLoginShown = onLoginShown;
    this._win = null;
    this._chain = Promise.resolve();
    this._loginMode = false;
    this.lastLoginShownAt = 0;
  }

  get partition() { return `persist:emehmon-bridge-${safeId(this.branchId)}`; }

  /** Портал тянет картинки, шрифты и медиа, которые автоматике не нужны. Капчу оставляем. */
  _lighten() {
    const part = this.partition;
    if (lightPartitions.has(part)) return;
    lightPartitions.add(part);
    try {
      session.fromPartition(part).webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, cb) => {
        const t = details.resourceType;
        const cancel = t === 'font' || t === 'media' || (t === 'image' && !/captcha/i.test(details.url || ''));
        cb({ cancel });
      });
    } catch (e) {
      this.log.warn('[portal] не удалось облегчить сессию:', e.message);
    }
  }

  /** Окно заперто на emehmon.uz: чужой origin не грузим, всплывающие окна — только портала. */
  _harden(win) {
    const block = (event, url) => {
      if (!isEmehmonUrl(url)) { event.preventDefault(); this.log.warn('[portal] заблокирован переход на', url); }
    };
    win.webContents.on('will-navigate', block);
    win.webContents.on('will-redirect', block);
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (!isEmehmonUrl(url)) return { action: 'deny' };
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          webPreferences: { partition: this.partition, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
        },
      };
    });
  }

  win() {
    if (this._win && !this._win.isDestroyed()) return this._win;
    this._lighten();
    const w = new BrowserWindow({
      width: 1200, height: 860, show: false,
      title: 'e-mehmon — мост Hostella',
      autoHideMenuBar: true,
      webPreferences: {
        partition: this.partition,
        contextIsolation: true, nodeIntegration: false, webSecurity: true,
        backgroundThrottling: false,
      },
    });
    w.setMenuBarVisibility(false);
    w.webContents.setAudioMuted(true);
    this._harden(w);
    // Вход: как только окно ушло со страницы входа — кассир вошёл.
    w.webContents.on('did-navigate', (_e, url) => this._afterNavigate(url));
    w.webContents.on('did-finish-load', () => this._afterNavigate(w.webContents.getURL()));
    w.on('close', (e) => {
      // Крестик прячет окно: сессия и очередь живут дальше.
      if (!this._destroying) { e.preventDefault(); w.hide(); }
    });
    w.on('closed', () => { this._win = null; });
    this._win = w;
    return w;
  }

  _afterNavigate(url) {
    if (!this._loginMode) return;
    const w = this._win;
    if (!w || w.isDestroyed()) return;
    if (isLoginUrl(url)) {
      this._injectLogin();
      return;
    }
    if (isEmehmonUrl(url)) {
      this._loginMode = false;
      this.log.info('[portal] вход выполнен');
      w.hide();
      try { this.onLoginOk(); } catch { /* слушатель */ }
    }
  }

  _injectLogin() {
    const w = this._win;
    if (!w || w.isDestroyed()) return;
    const creds = (this.getCreds && this.getCreds()) || {};
    if (!isEmehmonUrl(w.webContents.getURL())) return;
    // Тот же скрипт, что в кассе: подставляет логин и пароль на странице
    // входа; капчу и «Войти» нажимает человек. mode 'departure' + path
    // '/listok' — минимальная форма без мастера прибытия.
    const code = scripts.buildAutofillScript({ login: creds.login || '', password: creds.password || '', path: '/listok', mode: 'departure' });
    w.webContents.executeJavaScript(code).catch((e) => this.log.warn('[portal] автозаполнение входа:', e.message));
  }

  async load(pathname, timeoutMs = 60 * 1000) {
    const w = this.win();
    let t;
    const timer = new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`портал не загрузился за ${Math.round(timeoutMs / 1000)} с`)), timeoutMs); });
    try {
      await Promise.race([w.loadURL(ORIGIN + pathname), timer]);
    } finally {
      clearTimeout(t);
    }
    return w;
  }

  atLogin() {
    const w = this._win;
    return !!(w && !w.isDestroyed() && isLoginUrl(w.webContents.getURL()));
  }

  exec(code) {
    return this.win().webContents.executeJavaScript(code, true);
  }

  /** Задачи идут по одной: у портала одна сессия и один мастер на вкладку. */
  run(type, payload, job) {
    const p = this._chain.then(() => this._run(type, payload || {}, job));
    this._chain = p.catch(() => {});
    return p;
  }

  async _run(type, p) {
    switch (type) {
      case 'probe':
        await this.load('/listok/create-page');
        if (this.atLogin()) return { status: 'need_login' };
        return this.exec(scripts.buildPassportCheckScript(p));
      case 'arrival':
        await this.load('/listok/create-page');
        if (this.atLogin()) return { status: 'need_login' };
        // silent/quietFail — как у фонового добора кассы: окно не показываем никогда.
        return this.exec(scripts.buildAutoArrivalScript({ ...p, silent: true, quietFail: true }));
      case 'departure':
        await this.load('/listok');
        if (this.atLogin()) return { status: 'need_login' };
        return this.exec(scripts.buildDepartureAutoScript({
          guestName: p.guestName || p.fullName || '', passport: p.passport || '',
          amount: p.amount, payType: p.payType, print: false,
        }));
      case 'check':
        await this.load('/listok');
        if (this.atLogin()) return { status: 'need_login' };
        return this.exec(scripts.buildDepartureCheckScript({ guestName: p.guestName || p.fullName || '', passport: p.passport || '' }));
      case 'list':
        await this.load('/listok');
        if (this.atLogin()) return { status: 'need_login' };
        return this.exec(scripts.buildListFetchScript());
      case 'tursbor':
        await this.load('/tursborpays');
        if (this.atLogin()) return { status: 'need_login' };
        return this.exec(scripts.buildTursborFetchScript(p));
      case 'recalc':
        await this.load('/listok');
        if (this.atLogin()) return { status: 'need_login' };
        return this.exec(scripts.buildRecalcScript(p));
      default:
        return { status: 'error', message: `неизвестный тип задачи: ${type}` };
    }
  }

  /** Жива ли сессия портала: /listok открывается без редиректа на вход. */
  isLoggedIn() {
    const p = this._chain.then(async () => {
      await this.load('/listok');
      if (this.atLogin()) return false;
      const hasPw = await this.exec("!!document.querySelector('input[type=\"password\"]')").catch(() => true);
      return !hasPw;
    });
    this._chain = p.catch(() => {});
    return p;
  }

  /** Показать окно входа кассиру с подставленными логином и паролем. */
  async openLogin() {
    this._loginMode = true;
    this.lastLoginShownAt = Date.now();
    const w = this.win();
    try { await this.load('/listok', 30 * 1000); } catch (e) { this.log.warn('[portal] окно входа:', e.message); }
    w.show(); w.focus();
    try { this.onLoginShown(); } catch { /* слушатель */ }
    if (!this.atLogin()) {
      // Уже вошли — прятать нечего, но и держать окно незачем.
      this._loginMode = false;
      w.hide();
      try { this.onLoginOk(); } catch { /* слушатель */ }
    }
  }

  /** Напомнить о входе не чаще раза в LOGIN_WAIT_MS. */
  shouldRemindLogin(now = Date.now()) {
    return now - this.lastLoginShownAt > TIMING.LOGIN_WAIT_MS;
  }

  hide() { if (this._win && !this._win.isDestroyed()) this._win.hide(); }

  destroy() {
    this._destroying = true;
    if (this._win && !this._win.isDestroyed()) this._win.destroy();
    this._win = null;
  }
}

module.exports = { Portal, isEmehmonUrl, isLoginUrl };
