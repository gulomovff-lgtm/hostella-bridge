'use strict';
/**
 * Hosti Bridge — мост e-mehmon для Hosti Cloud.
 *
 * Программа в трее на компьютере филиала. Касса ставит задачу госрегистрации
 * в Firestore, мост забирает её, выполняет в скрытом окне портала боевыми
 * скриптами Hostella и записывает итог. Контракт очереди — в репозитории
 * кассы: hostella-cloud/docs/МОСТ.md.
 *
 * Здесь только сборка частей: хранилище (src/store.js), сессия моста
 * (src/auth.js), очередь (src/queue.js), портал (src/portal.js), окно
 * настроек (ui/). Логики принятия решений в этом файле нет.
 */
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, safeStorage, shell, Notification } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const tls = require('node:tls');
const crypto = require('node:crypto');
const log = require('electron-log');
const { autoUpdater } = require('electron-updater');

const { profileFor, assertSecure, TIMING, VERSION } = require('./src/config');
const { logHook } = require('./src/redact');
const { Store, safeStorageCodec } = require('./src/store');
const { Session } = require('./src/auth');
const { Firestore, isTransient } = require('./src/firebaseRest');
const { Worker } = require('./src/queue');
const { Portal } = require('./src/portal');
const { uploadObject } = require('./src/storageRest');
const { sheetFileName } = require('./electron/emehmonSheet');

log.transports.file.level = 'info';
log.transports.file.maxSize = 5 * 1024 * 1024;
// Номера паспортов в журнал не попадают (src/redact.js).
log.hooks.push(logHook);

const profile = profileFor(process.argv, process.env);
const host = os.hostname();

// Папка настроек прежнего имени («Hostella Bridge») остаётся рабочей: ключ,
// которым safeStorage шифрует пароль и токен, живёт в её Local State, и
// перенос файлов в новую папку его не переживает — мост «забыл бы» и
// подключение, и пароль портала. Поэтому, если прежняя папка есть, живём в ней.
{
  const legacy = path.join(path.dirname(app.getPath('userData')), 'Hostella Bridge');
  if (fs.existsSync(path.join(legacy, `bridge-${profile.name}.json`))) app.setPath('userData', legacy);
}

// ── Защита передачи данных ────────────────────────────────────────────────
// Паспортные данные гостей ходят между кассой, мостом и порталом. Поэтому:
//   • адреса только https (боевой профиль иначе не стартует), TLS ≥ 1.2 и в
//     Node (Firestore/функции), и в Chromium (портал);
//   • ошибка сертификата — обрыв, а не «продолжить»;
//   • задачи живут в памяти, на диск не пишутся; журнал — без номеров паспортов;
//   • пароль портала и ключ моста — под DPAPI (src/store.js).
let security = { httpsOnly: true, hosts: [] };
try {
  security = assertSecure(profile);
} catch (e) {
  log.error('[security]', e.message);
  app.whenReady().then(() => {
    const { dialog } = require('electron');
    dialog.showErrorBox('Hosti Bridge', `Мост не запущен: ${e.message}`);
    app.exit(1);
  });
}
tls.DEFAULT_MIN_VERSION = 'TLSv1.2';
app.commandLine.appendSwitch('ssl-version-min', 'tls1.2');
app.on('certificate-error', (event, _wc, url, error, _cert, callback) => {
  event.preventDefault();
  callback(false);
  log.warn('[security] сертификат отклонён:', url, error);
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => openWindow());
}
app.setAppUserModelId('com.hostella.bridge');

let store = null;
let sessionB = null;
let fsClient = null;
let worker = null;
let portal = null;
let tray = null;
let win = null;
let quitting = false;
let retryTimer = null;
let updateReady = null; // версия, скачанная и готовая к установке
const ui = { sessionOk: false, sessionReason: null, sessionMessage: '', starting: false };

// ── Состояние для окна и трея ─────────────────────────────────────────────

function snapshot() {
  const pairing = sessionB && sessionB.pairing;
  return {
    version: VERSION,
    profile: profile.name,
    host,
    paired: !!(sessionB && sessionB.isPaired),
    pairing: pairing || null,
    session: { ok: ui.sessionOk, reason: ui.sessionReason, message: ui.sessionMessage, starting: ui.starting },
    worker: worker ? { ...worker.state } : null,
    portal: {
      hasLogin: !!(store && store.get('portalLogin')),
      hasPassword: !!(store && store.hasSecret('portalPassword')),
      login: (store && store.get('portalLogin')) || '',
    },
    autostart: autostartOn(),
    updateReady,
    logFile: safeLogPath(),
    security: {
      tlsMin: 'TLS 1.2',
      httpsOnly: security.httpsOnly,
      hosts: [...security.hosts, 'emehmon.uz'],
      secretsEncrypted: (() => { try { return safeStorage.isEncryptionAvailable(); } catch { return false; } })(),
    },
  };
}

function safeLogPath() {
  try { return log.transports.file.getFile().path; } catch { return ''; }
}

function broadcast() {
  const s = snapshot();
  if (win && !win.isDestroyed()) win.webContents.send('state', s);
  updateTray(s);
}

function statusLine(s) {
  if (!s.paired) return 'не подключён';
  if (s.session.reason === 'revoked') return 'отключён администратором';
  if (!s.session.ok) return s.session.starting ? 'подключаюсь…' : 'нет связи с Hosti Cloud';
  if (s.worker && s.worker.paused === 'need_login') return 'нужен вход в e-mehmon';
  if (s.worker && s.worker.lastJob && s.worker.lastJob.status === 'running') return `выполняю: ${s.worker.lastJob.type}`;
  return `в сети · очередь ${(s.worker && s.worker.queue) || 0}`;
}

// ── Трей и окно ───────────────────────────────────────────────────────────

function iconImage(kind = 'icon') {
  // Знак Hosti (assets/hosti-mark.svg → scripts/build-icon.js): icon.png для окна и
  // уведомлений, tray.png 32×32 для трея.
  const p = path.join(__dirname, 'assets', kind === 'tray' ? 'tray.png' : kind === 'png' ? 'icon.png' : 'icon.ico');
  const img = nativeImage.createFromPath(p);
  return img.isEmpty() ? nativeImage.createEmpty() : img;
}

// ── Автозапуск ────────────────────────────────────────────────────────────
// Запись в автозагрузке хранит и путь к exe, и аргумент `--hidden`; читать
// её нужно с теми же аргументами — иначе Windows отвечает «нет записи», и
// галочка в окне выглядела выключенной, хотя автозапуск стоял.
const AUTOSTART_ARGS = ['--hidden'];
function autostartOn() {
  if (!app.isPackaged) return false;
  try { return !!app.getLoginItemSettings({ path: process.execPath, args: AUTOSTART_ARGS }).openAtLogin; } catch { return false; }
}
function setAutostart(on) {
  if (!app.isPackaged) return false;
  try {
    app.setLoginItemSettings({ openAtLogin: !!on, path: process.execPath, args: AUTOSTART_ARGS });
    if (store) store.set('autostart', !!on);
    return autostartOn() === !!on;
  } catch (e) {
    log.warn('[bridge] автозапуск не переключился:', e.message);
    return false;
  }
}
function ensureAutostart() {
  if (!app.isPackaged) return;
  // Запись прежнего имени («Hostella Bridge») после переименования указывает в никуда — снять.
  if (!store.get('autostartRenamed')) {
    for (const args of [AUTOSTART_ARGS, undefined]) {
      try { app.setLoginItemSettings({ openAtLogin: false, name: 'Hostella Bridge', args }); } catch { /* записи могло не быть */ }
    }
    store.set('autostartRenamed', true);
  }
  // Первый запуск — включить: мост поднимается вместе с компьютером стойки.
  // Дальше — по выбору в окне, но путь к exe прописывается заново: после
  // обновления или переименования он мог смениться.
  const want = store.get('autostart');
  if (want === undefined) setAutostart(true);
  else if (want) setAutostart(true);
}


function createTray() {
  tray = new Tray(iconImage('tray'));
  tray.on('double-click', () => openWindow());
  tray.on('click', () => openWindow());
  updateTray(snapshot());
}

function updateTray(s) {
  if (!tray) return;
  tray.setToolTip(`Hosti Bridge ${VERSION} — ${statusLine(s)}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Hosti Bridge ${VERSION}${profile.name === 'demo' ? ' · demo' : ''}`, enabled: false },
    { label: statusLine(s), enabled: false },
    { type: 'separator' },
    { label: 'Открыть', click: () => openWindow() },
    { label: 'Открыть портал e-mehmon', click: () => openPortalLogin({ keepOpen: true }).catch(() => {}), enabled: !!portal || !!s.paired },
    { label: 'Проверить очередь сейчас', click: () => worker && worker.tick().catch(() => {}), enabled: !!worker },
    { type: 'separator' },
    ...(updateReady ? [{ label: `Обновить до ${updateReady} и перезапустить`, click: () => installUpdate('меню') }] : []),
    { label: 'Журнал', click: () => { const f = safeLogPath(); if (f) shell.showItemInFolder(f); } },
    { label: 'Выйти', click: () => { quitting = true; app.quit(); } },
  ]));
}

function openWindow() {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); return; }
  // Системной рамки нет: шапка окна — своя, в цветах бренда; системные
  // кнопки свернуть/развернуть/закрыть рисует Windows поверх неё
  // (titleBarOverlay). Размер и место окна помнятся между запусками.
  const saved = (store && store.get('winBounds')) || null;
  win = new BrowserWindow({
    width: (saved && saved.width) || 720, height: (saved && saved.height) || 820,
    x: saved && Number.isFinite(saved.x) ? saved.x : undefined,
    y: saved && Number.isFinite(saved.y) ? saved.y : undefined,
    minWidth: 560, minHeight: 620,
    title: 'Hosti Bridge',
    icon: iconImage(),
    show: false,
    backgroundColor: '#F5F7F2',
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#000000', symbolColor: '#F5F7F2', height: 64 },
    webPreferences: {
      preload: path.join(__dirname, 'ui', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.once('ready-to-show', () => { if (saved && saved.maximized) win.maximize(); win.show(); });
  let boundsTimer = null;
  const rememberBounds = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (!win || win.isDestroyed() || !store) return;
      const maximized = win.isMaximized();
      const b = maximized ? (store.get('winBounds') || {}) : win.getBounds();
      store.set('winBounds', { ...b, maximized });
    }, 400);
  };
  win.on('resize', rememberBounds);
  win.on('move', rememberBounds);
  win.on('maximize', rememberBounds);
  win.on('unmaximize', rememberBounds);
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
  win.on('closed', () => { win = null; });
  win.webContents.on('did-finish-load', () => broadcast());
}

function notify(title, body) {
  try { if (Notification.isSupported()) new Notification({ title, body, icon: iconImage('png') }).show(); } catch { /* без уведомлений */ }
}

// ── Сборка ────────────────────────────────────────────────────────────────

function bridgeId() {
  let id = store.get('bridgeId');
  if (!id) {
    id = `${host.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32)}-${crypto.randomBytes(2).toString('hex')}`;
    store.set('bridgeId', id);
  }
  return id;
}

function getCreds() {
  return { login: store.get('portalLogin') || '', password: store.getSecret('portalPassword') || '' };
}

function ensurePortal(branchId) {
  if (portal && portal.branchId === branchId) return portal;
  if (portal) portal.destroy();
  portal = new Portal({
    branchId, getCreds, log,
    onLoginOk: () => { if (worker) worker.resume(); broadcast(); },
    onLoginShown: () => broadcast(),
    // Лист убытия — в хранилище кассы, в каталог филиала: правила Storage
    // пускают туда мост только с PDF (hostella-cloud/storage.rules, sheets).
    uploadSheet: async ({ guestId, passport, pdf }) => {
      const tenantId = sessionB && sessionB.pairing && sessionB.pairing.tenantId;
      if (!tenantId) throw new Error('мост не подключён');
      const seg = String(guestId || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'guest';
      const filePath = `t/${tenantId}/b/${branchId}/sheets/${seg}/${sheetFileName({ passport })}`;
      return uploadObject({
        base: profile.storageBase, bucket: profile.storageBucket, path: filePath,
        bytes: pdf, contentType: 'application/pdf', token: await sessionB.getIdToken(),
      });
    },
  });
  return portal;
}

async function openPortalLogin(opts = {}) {
  const branchId = (sessionB && sessionB.pairing && sessionB.pairing.branchId) || 'default';
  const r = await ensurePortal(branchId).openLogin(opts);
  broadcast();
  return r || { loggedIn: false };
}

async function startWorker() {
  if (!sessionB || !sessionB.isPaired) return;
  ui.starting = true; broadcast();
  const check = await sessionB.check();
  ui.starting = false;
  ui.sessionOk = check.ok;
  ui.sessionReason = check.ok ? null : check.reason;
  ui.sessionMessage = check.ok ? '' : (check.message || '');
  if (!check.ok) {
    log.warn('[bridge] сессия:', check.reason, check.message);
    if (check.reason === 'revoked') {
      notify('Hosti Bridge', 'Мост отключён администратором. Подключите его заново кодом.');
      openWindow();
    } else {
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => startWorker().catch(() => {}), 60 * 1000);
    }
    broadcast();
    return;
  }
  const { tenantId, branchId } = sessionB.pairing;
  fsClient = new Firestore({
    base: profile.firestoreBase, projectId: profile.projectId, databaseId: profile.databaseId,
    getToken: () => sessionB.getIdToken(),
  });
  const p = ensurePortal(branchId);
  const runner = {
    run: (type, payload, job) => p.run(type, payload, job),
    isLoggedIn: () => p.isLoggedIn(),
    onNeedLogin: async () => {
      notify('Hosti Bridge', 'Войдите в e-mehmon — очередь регистрации ждёт входа.');
      if (p.shouldRemindLogin() || !p._win || !p._win.isVisible()) await p.openLogin();
    },
  };
  if (worker) worker.stop();
  worker = new Worker({
    fs: fsClient, tenantId, branchId, bridgeId: bridgeId(), runner,
    meta: { host, version: VERSION }, log, timing: TIMING,
    onState: (st) => {
      // Токен отозван посреди работы — покажем это словами, а не вечным «нет связи».
      if (st.lastError && sessionB.lastError && sessionB.lastError.revoked) { ui.sessionOk = false; ui.sessionReason = 'revoked'; }
      else if (st.lastError && st.lastError.kind === 'heartbeat') { ui.sessionOk = false; ui.sessionReason = isTransient(sessionB.lastError) ? 'offline' : 'error'; ui.sessionMessage = st.lastError.message; }
      else if (!st.lastError) { ui.sessionOk = true; ui.sessionReason = null; ui.sessionMessage = ''; }
      broadcast();
    },
  });
  worker.start();
  log.info(`[bridge] запущен: ${tenantId}/${branchId} как ${bridgeId()} (${profile.name})`);
  broadcast();
}

function stopWorker() {
  clearTimeout(retryTimer);
  if (worker) { worker.stop(); worker = null; }
  if (portal) { portal.destroy(); portal = null; }
  fsClient = null;
  ui.sessionOk = false; ui.sessionReason = null; ui.sessionMessage = '';
}

// ── Обновления ────────────────────────────────────────────────────────────
//
// Мост стоит на стойке месяцами, и версию на нём никто не проверяет. Поэтому
// как в кассе: тихо скачать, поставить, когда очередь свободна и кассир не
// в окне входа. Установщик перезапускает мост сам (runAfterFinish),
// автозапуск поднимает его после перезагрузки Windows.

function installUpdate(reason) {
  if (!updateReady || quitting) return;
  if (worker && worker.state.busy) return;              // задача в портале — не рвём
  if (portal && portal._loginMode) return;               // кассир вводит капчу
  log.info(`[updater] ставлю ${updateReady} (${reason})`);
  quitting = true;
  if (worker) worker.stop();
  setTimeout(() => { try { autoUpdater.quitAndInstall(true, true); } catch (e) { log.error('[updater] quitAndInstall:', e.message); quitting = false; } }, 1000);
}

function setupUpdates() {
  if (!app.isPackaged) return;
  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', (info) => {
    updateReady = (info && info.version) || 'новой версии';
    log.info('[updater] скачано', updateReady);
    broadcast();
    installUpdate('скачано');
  });
  autoUpdater.on('error', (e) => log.warn('[updater]', (e && e.message) || e));
  const check = () => autoUpdater.checkForUpdates().catch((e) => log.warn('[updater] проверка:', e.message));
  setTimeout(check, 30 * 1000);
  setInterval(check, 6 * 60 * 60 * 1000);
  setInterval(() => installUpdate('очередь свободна'), 60 * 1000);
}

// ── IPC от окна настроек ──────────────────────────────────────────────────

ipcMain.handle('state', () => snapshot());

ipcMain.handle('pair', async (_e, code) => {
  try {
    const pairing = await sessionB.pair(code);
    log.info('[bridge] подключён к', pairing.tenantId, pairing.branchId);
    await startWorker();
    return { ok: true, pairing };
  } catch (e) {
    log.warn('[bridge] подключение:', e.message);
    return { ok: false, message: humanPairError(e) };
  }
});

function humanPairError(e) {
  const m = String((e && e.message) || e);
  if (/Код не подходит|permission-denied/i.test(m) || (e && e.code === 'permission-denied')) return 'Код не подходит или истёк. Возьмите новый в кассе: Настройки → Мост e-mehmon.';
  if (/Слишком много|resource-exhausted/i.test(m)) return 'Слишком много попыток с этого адреса. Попробуйте через час.';
  if (/сеть/i.test(m)) return 'Нет связи с Hosti Cloud. Проверьте интернет и попробуйте снова.';
  return m;
}

ipcMain.handle('unpair', async () => {
  stopWorker();
  sessionB.unpair();
  broadcast();
  return { ok: true };
});

ipcMain.handle('set-creds', async (_e, { login, password } = {}) => {
  store.set('portalLogin', String(login || '').trim() || null);
  if (password !== undefined && password !== null) store.setSecret('portalPassword', String(password) || null);
  broadcast();
  return { ok: true };
});

ipcMain.handle('open-portal', async () => {
  // Кнопка в окне: портал остаётся открытым и при живой сессии — кассир видит список гостей.
  try {
    const r = await openPortalLogin({ keepOpen: true });
    return { ok: true, loggedIn: !!(r && r.loggedIn) };
  } catch (e) {
    return { ok: false, message: e.message };
  }
});

ipcMain.handle('test-portal', async () => {
  try {
    const branchId = (sessionB && sessionB.pairing && sessionB.pairing.branchId) || 'default';
    const ok = await ensurePortal(branchId).isLoggedIn();
    if (ok && worker) worker.resume();
    broadcast();
    return { ok: true, loggedIn: ok };
  } catch (e) {
    return { ok: false, message: e.message };
  }
});

ipcMain.handle('sweep-now', async () => {
  if (!worker) return { ok: false, message: 'мост не подключён' };
  await worker.tick().catch(() => {});
  return { ok: true };
});

ipcMain.handle('install-update', async () => { installUpdate('окно'); return { ok: !!updateReady }; });

ipcMain.handle('set-autostart', async (_e, on) => {
  const ok = setAutostart(on);
  broadcast();
  return { ok, autostart: autostartOn() };
});

ipcMain.handle('open-logs', async () => { const f = safeLogPath(); if (f) shell.showItemInFolder(f); return { ok: true }; });
ipcMain.handle('quit', async () => { quitting = true; app.quit(); });

// ── Жизненный цикл ────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  if (!security.hosts.length && profile.name === 'prod') return; // адреса не прошли проверку — окно ошибки уже показано
  // Страницам разрешения (камера, геолокация, уведомления) не выдаются нигде.
  try { const { session } = require('electron'); session.defaultSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false)); } catch { /* ignore */ }
  store = new Store({ file: path.join(app.getPath('userData'), `bridge-${profile.name}.json`), codec: safeStorageCodec(safeStorage) });
  sessionB = new Session({ profile, store, host, version: VERSION, log });
  createTray();
  ensureAutostart();
  setupUpdates();
  // `--pair=КОД` — подключение без окна (установка администратором по
  // удалёнке, прогон на стенде). Делает ровно то же, что кнопка в окне.
  const pairArg = process.argv.find((a) => a.startsWith('--pair='));
  if (pairArg && !sessionB.isPaired) {
    try {
      const p = await sessionB.pair(pairArg.slice('--pair='.length));
      log.info('[bridge] подключён из командной строки к', p.tenantId, p.branchId);
    } catch (e) {
      log.error('[bridge] подключение из командной строки:', e.message);
    }
  }
  if (sessionB.isPaired) {
    await startWorker();
    if (!process.argv.includes('--hidden')) openWindow();
  } else {
    openWindow();
  }
});

app.on('window-all-closed', () => { /* живём в трее */ });
app.on('before-quit', () => { quitting = true; if (worker) worker.stop(); if (portal) portal.destroy(); });
