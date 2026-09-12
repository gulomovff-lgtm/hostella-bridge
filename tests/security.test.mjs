/**
 * Защита данных: только https в бою, паспорта не в журнале, имя — Hosti Bridge.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROD, DEMO, assertSecure } from '../src/config.js';
import { redact, redactAny, logHook } from '../src/redact.js';

const at = (rel) => fileURLToPath(new URL(rel, import.meta.url));

describe('assertSecure', () => {
  test('боевой профиль — только https, хосты перечислены', () => {
    const r = assertSecure(PROD);
    assert.equal(r.httpsOnly, true);
    assert.ok(r.hosts.includes('firestore.googleapis.com') && r.hosts.includes('firebasestorage.googleapis.com'));
  });
  test('http в боевом профиле — отказ запускаться', () => {
    assert.throws(() => assertSecure({ ...PROD, firestoreBase: 'http://firestore.googleapis.com' }), /небезопасные адреса/);
  });
  test('demo: http только на этой машине', () => {
    assert.equal(assertSecure(DEMO).httpsOnly, false);
    assert.throws(() => assertSecure({ ...DEMO, functionsBase: 'http://example.com/fn' }), /эмуляторов/);
  });
});

describe('redact', () => {
  test('серия и номер паспорта вырезаются, остальное — как было', () => {
    assert.equal(redact('гость AB1234567 в комнате 3'), 'гость AB******* в комнате 3');
    assert.equal(redact('паспорт AB 1234567'), 'паспорт AB*******');
    assert.equal(redact('TJK 406474180'), 'TJK 40*******');
    assert.equal(redact('sheet__b1__g-out__2026-09-11-0733 → done (48211 байт)'), 'sheet__b1__g-out__2026-09-11-0733 → done (48211 байт)');
  });
  test('хук чистит каждый аргумент строки журнала, включая объекты и ошибки', () => {
    const m = logHook({ data: ['паспорт AE7427755', { passport: 'AD5498547' }, new Error('AB1234567 not found'), 42] });
    assert.equal(m.data[0], 'паспорт AE*******');
    assert.ok(m.data[1].includes('AD*******') && !m.data[1].includes('5498547'));
    assert.ok(m.data[2].includes('AB*******'));
    assert.equal(m.data[3], 42);
    assert.equal(redactAny(null), null);
  });
});

describe('имя продукта', () => {
  test('везде Hosti Bridge; старое имя осталось только там, где снимается его автозапуск и переносятся настройки', () => {
    const pkg = JSON.parse(fs.readFileSync(at('../package.json'), 'utf8'));
    assert.equal(pkg.build.productName, 'Hosti Bridge');
    assert.equal(pkg.build.appId, 'com.hostella.bridge', 'appId менять нельзя: по нему обновляется установленная копия');
    for (const f of ['../ui/index.html', '../ui/app.js', '../README.md']) {
      assert.ok(!fs.readFileSync(at(f), 'utf8').includes('Hostella Bridge'), `${f} ещё зовёт мост старым именем`);
    }
    const main = fs.readFileSync(at('../main.js'), 'utf8');
    const stale = main.split('Hostella Bridge').length - 1;
    assert.ok(stale >= 2 && stale <= 4, 'в main.js старое имя — только для снятия автозапуска и переноса настроек');
    assert.ok(main.includes("getLoginItemSettings({ path: process.execPath, args: AUTOSTART_ARGS })"), 'автозапуск читается без аргументов — галочка снова будет врать');
    assert.ok(fs.existsSync(at('../assets/icon.png')) && fs.existsSync(at('../assets/tray.png')));
  });
});
