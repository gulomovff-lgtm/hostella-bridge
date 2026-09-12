'use strict';
/**
 * emehmonSheet — лист убытия e-mehmon как PDF.
 *
 * После «Check-Out» с галочкой печати портал отдаёт лист одним из способов:
 *   • открывает окно (window.open на emehmon.uz) со страницей листа, которая
 *     сама зовёт печать;
 *   • отдаёт готовый PDF — файлом (Content-Disposition: attachment, у Chromium
 *     это загрузка с диалогом «Сохранить как») или в окне встроенного
 *     просмотрщика (inline).
 * Человеку это диалоги печати и сохранения; автомату — окно, которое нельзя
 * показывать, и диалоги, которые некому закрыть. Модуль:
 *
 *   1. создаёт окно-потомок СКРЫТЫМ (installWindowOpenHandler);
 *   2. глушит печать в нём до загрузки страницы (протокол отладчика,
 *      Page.addScriptToEvaluateOnNewDocument); окно без адреса, в которое
 *      родитель пишет сам, страхует подмена print со стороны родителя — её
 *      ставит скрипт убытия (emehmonAutofill.js, флаг `sheet: true`);
 *   3. пока идёт снятие, ответ с application/pdf делает вложением, а
 *      загрузку забирает сам — в буфер, без диалога (hookSession);
 *   4. страницу листа снимает printToPDF.
 *
 * Если портал печатает не окном-потомком, а самой страницей списка, скрипт
 * убытия оставляет метку `window.__hostellaPrintWanted` — тогда снимается
 * родительское окно.
 *
 * Общий для боевой Hostella (electron/main.js) и моста (hostella-bridge/
 * src/portal.js). Копия в мосте — побайтно, как emehmonAutofill.js. Кроме
 * Electron зависимостей нет: снаружи BrowserWindow, webContents, session.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

/** Текущий захват — ему достаётся перехваченная загрузка. */
let pending = null;
const hookedSessions = new WeakSet();

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * executeJavaScript ждёт конца загрузки страницы; у окна, чья навигация стала
 * загрузкой файла, конца не будет — без предела ожидание висело бы вечно.
 */
const evalIn = (wc, code, ms = 1500) => Promise.race([
  wc.executeJavaScript(code, true),
  wait(ms).then(() => { throw new Error('eval timeout'); }),
]);

/**
 * Обработчик всплывающих окон портала — один на оба приложения.
 *
 * Разрешён только emehmon.uz, а на время снятия листа — ещё пустое окно:
 * портал может открыть `about:blank` и написать в него сам. Пока идёт
 * снятие, окно создаётся скрытым; в остальное время (кассир печатает сам в
 * видимом окне) — видимым, как раньше.
 */
function installWindowOpenHandler(win, { isAllowedUrl, partition, parent = null, log = console }) {
  // parent — окно или функция, возвращающая окно: главное окно кассы пересоздаётся.
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
    const par = typeof parent === 'function' ? parent() : parent;
    if (par && !par.isDestroyed()) opts.parent = par;
    return { action: 'allow', overrideBrowserWindowOptions: opts };
  });
}

/**
 * Сессия портала: PDF-ответ на время снятия — вложение, загрузка — в буфер.
 *
 * `onHeadersReceived` у сессии один; в приложениях на этой сессии стоит только
 * `onBeforeRequest` (облегчение), поэтому здесь конфликта нет. Вне снятия ни
 * заголовки, ни загрузки не трогаем: кассир, печатающий сам в видимом окне,
 * получает обычное поведение.
 */
function hookSession(ses, log) {
  if (!ses || hookedSessions.has(ses)) return;
  hookedSessions.add(ses);
  try {
    ses.webRequest.onHeadersReceived({ urls: ['*://*/*'] }, (details, cb) => {
      if (!isCapturing() || !pending || !['mainFrame', 'subFrame'].includes(details.resourceType)) return cb({});
      const headers = details.responseHeaders || {};
      const ctKey = Object.keys(headers).find((k) => k.toLowerCase() === 'content-type');
      const ct = String((ctKey && headers[ctKey] && headers[ctKey][0]) || '').toLowerCase();
      if (!ct.includes('application/pdf')) return cb({});
      const out = {};
      for (const k of Object.keys(headers)) if (k.toLowerCase() !== 'content-disposition') out[k] = headers[k];
      out['Content-Disposition'] = ['attachment; filename="sheet.pdf"'];
      cb({ responseHeaders: out });
    });
  } catch (e) {
    log.warn('[emehmon] заголовки листа не перехвачены:', e.message);
  }
  ses.on('will-download', (_event, item) => {
    const cap = pending;
    if (!isCapturing() || !cap) return; // не снимаем — диалог сохранения, как раньше
    const file = path.join(os.tmpdir(), `hostella-sheet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pdf`);
    try { item.setSavePath(file); } catch (e) { log.warn('[emehmon] загрузка листа без пути:', e.message); return; }
    item.once('done', (_e, state) => {
      if (state !== 'completed') { cap.resolveDownload({ ok: false, code: 'sheet_download', message: String(state) }); return; }
      try {
        const pdf = fs.readFileSync(file);
        fs.unlink(file, () => {});
        if (!pdf.length) { cap.resolveDownload({ ok: false, code: 'sheet_empty' }); return; }
        cap.resolveDownload({ ok: true, pdf, bytes: pdf.length, source: 'download' });
      } catch (e) {
        cap.resolveDownload({ ok: false, code: 'sheet_download', message: e.message });
      }
    });
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
  wc.on('dom-ready', () => { evalIn(wc, PRINT_STUB, 3000).catch(() => {}); });
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
    const len = await evalIn(wc, '(document.body && document.body.innerText || "").length').catch(() => -1);
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
 *   result({ graceMs }) — ждёт файл или окно-потомок не дольше graceMs после
 *   вызова, иначе смотрит метку печати на родителе; отдаёт
 *   { ok:true, pdf:Buffer, bytes, source:'download'|'child'|'parent' } либо
 *   { ok:false, code: no_sheet | sheet_empty | sheet_error | sheet_gone | sheet_download }.
 *   dispose() — снимает слушатели, закрывает окно-потомок и возвращает
 *   странице настоящую печать (для ручного окна кассира).
 */
function armSheetCapture(parentWin, { log = console, timeoutMs = SHEET_TIMEOUT_MS } = {}) {
  const wc = parentWin.webContents;
  hookSession(wc.session, log);
  capturing += 1;
  let child = null;
  let childUrl = '';
  let resolveChild = () => {};
  const childSeen = new Promise((r) => { resolveChild = r; });
  let resolveDownload = () => {};
  const downloaded = new Promise((r) => { resolveDownload = r; });
  const mine = { resolveDownload: (v) => resolveDownload(v) };
  pending = mine;

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
    // Жёсткий предел на всё: ни одно ожидание внутри не должно пережить его.
    return Promise.race([
      resultInner({ graceMs }),
      wait(timeoutMs + 2000).then(() => ({ ok: false, code: 'sheet_timeout' })),
    ]);
  }

  async function resultInner({ graceMs }) {
    const deadline = Date.now() + timeoutMs;
    const first = await Promise.race([
      downloaded.then((d) => ({ kind: 'download', d })),
      childSeen.then((w) => ({ kind: 'child', w })),
      wait(graceMs).then(() => ({ kind: 'none' })),
    ]);
    if (first.kind === 'download') return first.d;
    if (first.kind === 'child') {
      // Окно могло лишь запустить загрузку файла: ждём и её, и содержимое окна.
      const res = await Promise.race([downloaded, captureWindow(first.w, { deadline, log })]);
      if (res && res.ok) return res;
      const late = await Promise.race([downloaded, wait(Math.max(0, deadline - Date.now())).then(() => null)]);
      return (late && late.ok) ? late : (res || late || { ok: false, code: 'no_sheet' });
    }
    // Ни окна, ни файла: печать могла быть на самой странице списка…
    const parentWanted = await evalIn(wc, '!!window.__hostellaPrintWanted').catch(() => false);
    if (parentWanted) return capturePdf(wc, { log, source: 'parent' });
    // …или файл ещё в пути.
    const late = await Promise.race([downloaded, wait(Math.min(5000, Math.max(0, deadline - Date.now()))).then(() => null)]);
    return late || { ok: false, code: 'no_sheet' };
  }

  function dispose() {
    capturing = Math.max(0, capturing - 1);
    if (pending === mine) pending = null;
    wc.removeListener('did-create-window', onCreate);
    if (!wc.isDestroyed()) evalIn(wc, 'window.__hostellaSheetOff = true; true').catch(() => {});
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
