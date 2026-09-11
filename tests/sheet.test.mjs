/**
 * Модуль листа убытия (electron/emehmonSheet.js) — то, что проверяется без Electron:
 * заглушка печати, имя файла, состав экспорта. Сам захват проверяет
 * scripts/sheet-selftest.js под Electron.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const sheet = require('../electron/emehmonSheet.js');

describe('emehmonSheet', () => {
  test('экспорт — то, чем пользуются portal.js и main.js', () => {
    for (const k of ['installWindowOpenHandler', 'armSheetCapture', 'isCapturing', 'sheetFileName']) {
      assert.equal(typeof sheet[k], 'function', k);
    }
    assert.equal(sheet.isCapturing(), false);
  });

  test('заглушка печати ставит метку вместо диалога и уступает настоящей печати после dispose', () => {
    const w = { print: () => { w.realCalled = true; } };
    new Function('window', sheet.PRINT_STUB)(w);
    w.print();
    assert.equal(w.__hostellaPrintWanted, true);
    assert.equal(w.realCalled, undefined);
    w.__hostellaSheetOff = true;
    w.print();
    assert.equal(w.realCalled, true);
  });

  test('имя файла: паспорт без пробелов и метка времени, без символов пути', () => {
    const name = sheet.sheetFileName({ passport: 'AB 1234567', at: new Date(2026, 8, 11, 14, 5) });
    assert.equal(name, 'AB1234567_20260911_1405.pdf');
    assert.match(sheet.sheetFileName({ passport: '../x/y' }), /^xy_\d{8}_\d{4}\.pdf$/);
    assert.match(sheet.sheetFileName({}), /^guest_\d{8}_\d{4}\.pdf$/);
  });

  test('скрипт убытия несёт заглушку печати со стороны родителя (флаг sheet)', () => {
    const src = fs.readFileSync(fileURLToPath(new URL('../electron/emehmonAutofill.js', import.meta.url)), 'utf8');
    assert.equal((src.match(/__hostellaOpenWrapped/g) || []).length >= 4, true, 'заглушка должна стоять в одиночном и массовом убытии');
    assert.ok(src.includes('GUEST.sheet') && src.includes('DATA.sheet'));
  });
});
