'use strict';
/**
 * Hostella Bridge — мост e-mehmon для Hosti Cloud.
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
const os = require('node:os');
const crypto = require('node:crypto');
const log = require('electron-log');
const { autoUpdater } = require('electron-updater');

const { profileFor, TIMING, VERSION } = require('./src/config');
const { Store, safeStorageCodec } = require('./src/store');
const { Session } = require('./src/auth');
const { Firestore, isTransient } = require('./src/firebaseRest');
const { Worker } = require('./src/queue');
const { Portal } = require('./src/portal');
const { uploadObject } = require('./src/storageRest');
const { sheetFileName } = require('./electron/emehmonSheet');

log.transports.file.level = 'info';
log.transports.file.maxSize = 5 * 1024 * 1024;

const profile = profileFor(process.argv, process.env);
const host = os.hostname();

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
    autostart: app.isPackaged ? !!app.getLoginItemSettings().openAtLogin : false,
    updateReady,
    logFile: safeLogPath(),
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

function iconImage() {
  const p = path.join(__dirname, 'assets', 'icon.ico');
  const img = nativeImage.createFromPath(p);
  return img.isEmpty() ? nativeImage.createEmpty() : img;
}

function createTray() {
  tray = new Tray(iconImage());
  tray.on('double-click', () => openWindow());
  tray.on('click', () => openWindow());
  updateTray(snapshot());
}

function updateTray(s) {
  if (!tray) return;
  tray.setToolTip(`Hostella Bridge ${VERSION} — ${statusLine(s)}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Hostella Bridge ${VERSION}${profile.name === 'demo' ? ' · demo' : ''}`, enabled: false },
    { label: statusLine(s), enabled: false },
    { type: 'separator' },
    { label: 'Открыть', click: () => openWindow() },
    { label: 'Войти в e-mehmon…', click: () => openPortalLogin(), enabled: !!portal || !!s.paired },
    { label: 'Проверить очередь сейчас', click: () => worker && worker.tick().catch(() => {}), enabled: !!worker },
    { type: 'separator' },
    ...(updateReady ? [{ label: `Обновить до ${updateReady} и перезапустить`, click: () => installUpdate('меню') }] : []),
    { label: 'Журнал', click: () => { const f = safeLogPath(); if (f) shell.showItemInFolder(f); } },
    { label: 'Выйти', click: () => { quitting = true; app.quit(); } },
  ]));
}

function openWindow() {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); return; }
  win = new BrowserWindow({
    width: 560, height: 720, minWidth: 480, minHeight: 560,
    title: 'Hostella Bridge',
    icon: iconImage(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'ui', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
  win.on('closed', () => { win = null; });
  win.webContents.on('did-finish-load', () => broadcast());
}

function notify(title, body) {
  try { if (Notification.isSupported()) new Notification({ title, body, icon: iconImage() }).show(); } catch { /* без уведомлений */ }
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

async function openPortalLogin() {
  const branchId = (sessionB && sessionB.pairing && sessionB.pairing.branchId) || 'default';
  await ensurePortal(branchId).openLogin();
  broadcast();
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
      notify('Hostella Bridge', 'Мост отключён администратором. Подключите его заново кодом.');
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
      notify('Hostella Bridge', 'Войдите в e-mehmon — очередь регистрации ждёт входа.');
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

ipcMain.handle('open-portal', async () => { await openPortalLogin(); return { ok: true }; });

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
  // `--hidden`: при входе в Windows мост поднимается в трей, окно не мешает.
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!on, path: process.execPath, args: ['--hidden'] });
  broadcast();
  return { ok: true };
});

ipcMain.handle('open-logs', async () => { const f = safeLogPath(); if (f) shell.showItemInFolder(f); return { ok: true }; });
ipcMain.handle('quit', async () => { quitting = true; app.quit(); });

// ── Жизненный цикл ────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  store = new Store({ file: path.join(app.getPath('userData'), `bridge-${profile.name}.json`), codec: safeStorageCodec(safeStorage) });
  sessionB = new Session({ profile, store, host, version: VERSION, log });
  createTray();
  // Первый запуск после установки — включаем автозапуск: мост должен
  // подниматься вместе с компьютером стойки, а не когда о нём вспомнят.
  if (app.isPackaged && !store.get('autostartSet')) {
    app.setLoginItemSettings({ openAtLogin: true, path: process.execPath, args: ['--hidden'] });
    store.set('autostartSet', true);
  }
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
