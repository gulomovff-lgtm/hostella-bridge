'use strict';
/**
 * emehmonSheet — лист убытия e-mehmon как PDF.
 *
 * После «Check-Out» с галочкой печати портал открывает лист убытия отдельным
 * окном (window.open на emehmon.uz) и сам зовёт печать. Человеку это диалог
 * печати; автомату — окно, которое нельзя показывать, и диалог, который
 * некому закрыть. Модуль делает три вещи:
 *
 *   1. окно-потомок создаётся СКРЫТЫМ (installWindowOpenHandler);
 *   2. печать в нём глушится до того, как страница выполнит свой скрипт —
 *      через протокол отладчика (Page.addScriptToEvaluateOnNewDocument);
 *      окно без адреса, в которое родитель пишет сам (document.write),
 *      страхует подмена print со стороны родителя — её ставит скрипт убытия
 *      (emehmonAutofill.js, флаг `sheet: true`);
 *   3. содержимое снимается printToPDF и отдаётся буфером.
 *
 * Если портал печатает не окном-потомком, а самой страницей списка, скрипт
 * убытия оставляет метку `window.__hostellaPrintWanted` — тогда снимается
 * родительское окно.
 *
 * Общий для боевой Hostella (electron/main.js) и моста (hostella-bridge/
 * src/portal.js). Копия в мосте — побайтно, как emehmonAutofill.js. Кроме
 * Electron зависимостей нет: снаружи только BrowserWindow и webContents.
 */

/** Заглушка печати: вместо диалога — метка, которую читает main-процесс. */
const PRINT_STUB = `(function(){
  try {
    if (window.__hostellaSheetOff) return;
    var real = window.print;
    window.print = function(){
      if (window.__hostellaSheetOff && typeof real === 'function') return real.apply(window, arguments);
      window.__hostellaPrintWanted = true;
    };
  } catch (e) {}
})();`;

/** Сколько ждём лист целиком и сколько — «успокоения» содержимого. */
const SHEET_TIMEOUT_MS = 20 * 1000;
const SETTLE_MS = 600;
const STABLE_TICKS = 2;

let capturing = 0;
/** Идёт ли снятие листа: фильтр сессии на это время пропускает картинки и шрифты. */
const isCapturing = () => capturing > 0;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Обработчик всплывающих окон портала — один на оба приложения.
 *
 * Разрешён только emehmon.uz, а на время снятия листа — ещё пустое окно:
 * портал может открыть `about:blank` и написать в него сам. Пока идёт
 * снятие, окно создаётся скрытым; в остальное время (кассир печатает сам в
 * видимом окне) — видимым, как раньше.
 */
function installWindowOpenHandler(win, { isAllowedUrl, partition, parent = null, log = console }) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    const blank = !url || url === 'about:blank';
    if (!(isAllowedUrl(url) || (blank && isCapturing()))) {
      log.warn('[emehmon] заблокировано всплывающее окно', url);
      return { action: 'deny' };
    }
    const opts = {
      show: !isCapturing(),
      autoHideMenuBar: true,
      webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
    };
    if (parent && !parent.isDestroyed()) opts.parent = parent;
    return { action: 'allow', overrideBrowserWindowOptions: opts };
  });
}

/** Заглушить print в окне до загрузки страницы; запасной путь — после dom-ready. */
async function stubPrint(wc, log) {
  try {
    const dbg = wc.debugger;
    if (!dbg.isAttached()) dbg.attach('1.3');
    await dbg.sendCommand('Page.enable');
    await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: PRINT_STUB });
  } catch (e) {
    log.warn('[emehmon] печать в окне листа не заглушена через отладчик:', e.message);
  }
  wc.on('dom-ready', () => { wc.executeJavaScript(PRINT_STUB, true).catch(() => {}); });
}

/** Снять PDF с webContents. */
async function capturePdf(wc, { log, source }) {
  try {
    const pdf = await wc.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      preferCSSPageSize: true,
      margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 },
    });
    if (!pdf || !pdf.length) return { ok: false, code: 'sheet_empty' };
    return { ok: true, pdf, bytes: pdf.length, source };
  } catch (e) {
    log.warn('[emehmon] printToPDF:', e.message);
    return { ok: false, code: 'sheet_error', message: e.message };
  }
}

/** Дождаться загрузки окна-потомка и покоя содержимого, снять его. */
async function captureWindow(win, { deadline, log }) {
  if (!win || win.isDestroyed()) return { ok: false, code: 'sheet_gone' };
  const wc = win.webContents;
  await Promise.race([
    new Promise((r) => { if (!wc.isLoading()) r(); else wc.once('did-stop-loading', r); }),
    wait(Math.max(0, deadline - Date.now())),
  ]);
  let last = -1;
  let stable = 0;
  while (Date.now() < deadline) {
    if (win.isDestroyed()) return { ok: false, code: 'sheet_gone' };
    const len = await wc.executeJavaScript('(document.body && document.body.innerText || "").length', true).catch(() => -1);
    if (len > 0 && len === last) { stable += 1; if (stable >= STABLE_TICKS) break; } else stable = 0;
    last = len;
    await wait(SETTLE_MS);
  }
  if (last <= 0) return { ok: false, code: 'sheet_empty' };
  return capturePdf(wc, { log, source: 'child' });
}

/**
 * Взвести захват на окне портала ПЕРЕД скриптом убытия.
 *
 * Возвращает { result(opts), dispose() }:
 *   result({ graceMs }) — ждёт окно-потомок не дольше graceMs после вызова,
 *   иначе смотрит метку печати на родителе; отдаёт
 *   { ok:true, pdf:Buffer, bytes, source:'child'|'parent' } либо
 *   { ok:false, code: no_sheet | sheet_empty | sheet_error | sheet_gone }.
 *   dispose() — снимает слушатели, закрывает окно-потомок и возвращает
 *   странице настоящую печать (для ручного окна кассира).
 */
function armSheetCapture(parentWin, { log = console, timeoutMs = SHEET_TIMEOUT_MS } = {}) {
  const wc = parentWin.webContents;
  capturing += 1;
  let child = null;
  let childUrl = '';
  let resolveChild = () => {};
  const childSeen = new Promise((r) => { resolveChild = r; });

  const onCreate = (win, details) => {
    if (child && !child.isDestroyed()) { try { win.destroy(); } catch { /* уже закрыто */ } return; }
    child = win;
    childUrl = String((details && details.url) || '');
    try { win.hide(); } catch { /* окно могло не успеть создаться */ }
    stubPrint(win.webContents, log);
    resolveChild(win);
  };
  wc.on('did-create-window', onCreate);

  async function result({ graceMs = 8000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    const win = await Promise.race([childSeen, wait(graceMs).then(() => null)]);
    if (win) return captureWindow(win, { deadline, log });
    const parentWanted = await wc.executeJavaScript('!!window.__hostellaPrintWanted', true).catch(() => false);
    if (parentWanted) return capturePdf(wc, { log, source: 'parent' });
    return { ok: false, code: 'no_sheet' };
  }

  function dispose() {
    capturing = Math.max(0, capturing - 1);
    wc.removeListener('did-create-window', onCreate);
    if (!wc.isDestroyed()) wc.executeJavaScript('window.__hostellaSheetOff = true; true', true).catch(() => {});
    if (child && !child.isDestroyed()) { try { child.destroy(); } catch { /* ignore */ } }
    child = null;
  }

  return { result, dispose, get url() { return childUrl; }, get child() { return child; } };
}

/** Имя файла листа: паспорт без пробелов и метка времени. */
function sheetFileName({ passport = '', at = new Date() } = {}) {
  const p = String(passport || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 16) || 'guest';
  const d = at instanceof Date ? at : new Date(at);
  const pad = (n) => String(n).padStart(2, '0');
  return `${p}_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.pdf`;
}

module.exports = { installWindowOpenHandler, armSheetCapture, isCapturing, sheetFileName, PRINT_STUB, SHEET_TIMEOUT_MS };
