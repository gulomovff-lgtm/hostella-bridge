'use strict';
/**
 * Самопроверка снятия листа убытия (electron/emehmonSheet.js) без портала.
 *
 *   npx electron scripts/sheet-selftest.js [каталог-для-pdf]
 *
 * Локальный HTTP-сервер играет портал: страница «списка», страница «листа»,
 * которая, как настоящая, зовёт window.print() при загрузке, и готовый PDF.
 * Способы, которыми портал может отдать лист, проверяются по очереди:
 *   A. window.open(адрес) — лист грузится своей страницей и печатает сам;
 *   B. window.open('') + document.write(...) + print() — окно без адреса;
 *   C. window.print() на самой странице списка;
 *   D. window.open(PDF как вложение) — у Chromium это загрузка с диалогом «Сохранить»;
 *   E. window.open(PDF inline) — встроенный просмотрщик;
 *   F. переход страницы списка на PDF-вложение — загрузка без окна.
 * Успех: везде получен непустой PDF, диалогов печати и сохранения нет,
 * лишних окон не осталось.
 */
const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const sheet = require('../electron/emehmonSheet');
const scripts = require('../electron/emehmonAutofill');

const outDir = process.argv.find((a) => !a.startsWith('-') && a !== process.execPath && !/sheet-selftest\.js$/.test(a) && !/electron/i.test(a)) || null;

const SHEET_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Chiqish varaqasi</title>
<style>body{font-family:sans-serif;padding:24px} h1{font-size:20px} table{border-collapse:collapse} td{border:1px solid #333;padding:6px 10px}</style>
</head><body onload="window.print()">
<h1>E-MEHMON — Chiqish varaqasi</h1>
<table><tr><td>Mehmon</td><td>IVANOV IVAN</td></tr><tr><td>Pasport</td><td>AB1234567</td></tr>
<tr><td>Kelgan</td><td>08.09.2026</td></tr><tr><td>Ketgan</td><td>11.09.2026</td></tr><tr><td>To‘lov</td><td>90 000</td></tr></table>
<p>Ushbu varaqa avtomatik shakllantirildi.</p>
</body></html>`;

// Минимальный PDF (без xref — для загрузки достаточно), с запасом по размеру.
const PDF_BYTES = Buffer.from([
  '%PDF-1.4',
  '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
  '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
  '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >> endobj',
  '4 0 obj << /Length 44 >> stream',
  'BT /F1 24 Tf 72 720 Td (Chiqish varaqasi) Tj ET',
  'endstream endobj',
  '% ' + 'x'.repeat(1200),
  'trailer << /Root 1 0 R >>',
  '%%EOF',
].join('\n'));

const LIST_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>listok</title></head><body>
<h1>Ro‘yxat</h1>
<script>
  window.openA = function(){ window.open(location.origin + '/sheet', '_blank'); };
  window.openB = function(){
    var w = window.open('', '_blank');
    w.document.open(); w.document.write(${JSON.stringify(SHEET_HTML.replace(' onload="window.print()"', ''))}); w.document.close();
    setTimeout(function(){ try { w.print(); } catch(e){} }, 200);
  };
  window.openC = function(){ setTimeout(function(){ window.print(); }, 100); };
  window.openD = function(){ window.open(location.origin + '/sheet.pdf?attach=1', '_blank'); };
  window.openE = function(){ window.open(location.origin + '/sheet.pdf', '_blank'); };
  window.openF = function(){ location.href = location.origin + '/sheet.pdf?attach=1'; };
</script></body></html>`;

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.url.startsWith('/sheet.pdf')) {
        res.setHeader('Content-Type', 'application/pdf');
        if (/attach=1/.test(req.url)) res.setHeader('Content-Disposition', 'attachment; filename="chiqish.pdf"');
        res.end(PDF_BYTES);
        return;
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(req.url.startsWith('/sheet') ? SHEET_HTML : LIST_HTML);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function scenario(win, name, trigger, base, expectSource) {
  const before = BrowserWindow.getAllWindows().length;
  await win.loadURL(`${base}/`);
  const cap = sheet.armSheetCapture(win, { log: console, timeoutMs: 15000 });
  // Боевой скрипт убытия ставит заглушку со стороны родителя, потом ищет
  // таблицу списка (её тут нет — вернёт no_table через несколько секунд).
  win.webContents.executeJavaScript(scripts.buildDepartureAutoScript({ sheet: true, print: true, guestName: 'X', passport: 'AB1234567' }), true).catch(() => {});
  await wait(300);
  await win.webContents.executeJavaScript(`${trigger}()`, true).catch(() => {});
  const got = await cap.result({ graceMs: 4000 });
  let stubbed = null;
  if (expectSource !== 'download') {
    // У окна, чья навигация стала загрузкой, executeJavaScript не вернётся — там не спрашиваем.
    try {
      const target = cap.child && !cap.child.isDestroyed() ? cap.child.webContents : win.webContents;
      stubbed = await Promise.race([target.executeJavaScript('!!window.__hostellaPrintWanted', true), wait(2000).then(() => null)]);
    } catch { stubbed = null; }
  }
  const childUrl = cap.url;
  cap.dispose();
  await wait(300);
  const after = BrowserWindow.getAllWindows().length;
  const okPdf = got.ok && got.bytes > 800 && got.pdf.slice(0, 5).toString() === '%PDF-';
  const needStub = expectSource !== 'download';
  const result = {
    scenario: name,
    ok: !!(okPdf && got.source === expectSource && (!needStub || stubbed) && after === before),
    got: { ok: got.ok, code: got.code, bytes: got.bytes, source: got.source }, stubbed, childUrl, windowsBefore: before, windowsAfter: after,
  };
  if (got.ok && outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, `selftest-${name}.pdf`), got.pdf);
  }
  console.log(JSON.stringify(result));
  return result.ok;
}

app.whenReady().then(async () => {
  const srv = await serve();
  const base = `http://127.0.0.1:${srv.address().port}`;
  const part = 'selftest-sheet';
  const win = new BrowserWindow({ width: 900, height: 700, show: false, webPreferences: { partition: part, contextIsolation: true, nodeIntegration: false, sandbox: true } });
  sheet.installWindowOpenHandler(win, { isAllowedUrl: (u) => String(u || '').startsWith(base), partition: part, log: console });
  let allOk = true;
  try {
    allOk = (await scenario(win, 'A-url-child', 'openA', base, 'child')) && allOk;
    allOk = (await scenario(win, 'B-blank-write', 'openB', base, 'child')) && allOk;
    allOk = (await scenario(win, 'C-parent-print', 'openC', base, 'parent')) && allOk;
    allOk = (await scenario(win, 'D-pdf-attachment', 'openD', base, 'download')) && allOk;
    allOk = (await scenario(win, 'E-pdf-inline', 'openE', base, 'download')) && allOk;
    allOk = (await scenario(win, 'F-parent-download', 'openF', base, 'download')) && allOk;
  } catch (e) {
    console.log(JSON.stringify({ error: e.message }));
    allOk = false;
  }
  console.log(JSON.stringify({ selftest: allOk ? 'ok' : 'FAILED' }));
  srv.close();
  app.exit(allOk ? 0 : 1);
});
