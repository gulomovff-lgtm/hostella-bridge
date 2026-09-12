'use strict';
/**
 * emehmonSheetPreload — заглушка печати в окне портала ДО скриптов страницы.
 *
 * Пока main-процесс снимает лист убытия (emehmonSheet.js), ни одна страница
 * портала — окно списка, окно-потомок с листом, скрытый iframe — не должна
 * открыть диалог печати: его некому закрыть. Preload выполняется раньше любого
 * скрипта страницы в каждом кадре (nodeIntegrationInSubFrames), поэтому
 * подмена `window.print` успевает всегда, в отличие от отладчика, который
 * подключается уже после создания окна.
 *
 * Вне снятия ничего не делает: кассир, печатающий сам в видимом окне,
 * получает обычный диалог. «Снимаем или нет» спрашивается у main синхронно —
 * к моменту первого скрипта страницы ответ уже есть.
 *
 * Копия в мосте (hostella-bridge/electron/) — побайтно, как остальные файлы
 * этого каталога. Текст заглушки тот же, что PRINT_STUB в emehmonSheet.js.
 */
const { ipcRenderer, webFrame } = require('electron');

let armed = false;
try { armed = ipcRenderer.sendSync('hostella-sheet-armed') === true; } catch { armed = false; }

if (armed) {
  const STUB = '(function(){ try { if (window.__hostellaSheetOff) return; var real = window.print;'
    + ' window.print = function(){ if (window.__hostellaSheetOff && typeof real === "function") return real.apply(window, arguments);'
    + ' window.__hostellaPrintWanted = true; }; } catch (e) {} })();';
  try {
    if (webFrame && typeof webFrame.executeJavaScript === 'function') {
      // Основной мир страницы — то, что видит её собственный скрипт.
      webFrame.executeJavaScript(STUB);
    } else if (typeof window !== 'undefined' && !process.contextIsolated) {
      // Без изоляции контекста preload и страница делят одно окно.
      // eslint-disable-next-line no-eval
      (0, eval)(STUB);
    }
  } catch { /* подстрахует отладчик из emehmonSheet.js */ }
}
