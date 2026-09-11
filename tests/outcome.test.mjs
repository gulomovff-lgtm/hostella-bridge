/**
 * Что вывод скрипта портала значит для задачи (src/outcome.js) —
 * по контракту hostella-cloud/docs/МОСТ.md.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import outcome from '../src/outcome.js';

const { classify, flattenDump, sanitize, transportFailure, DESCRIBE } = outcome;

describe('done против failed', () => {
  test('мастер дошёл до конца — done, статус внутри результата', () => {
    const r = classify('arrival', { status: 'done', probe: { fields: { a: '1' } }, last: { tables: [] } });
    assert.equal(r.status, 'done');
    assert.equal(r.result.status, 'done');
    assert.deepEqual(r.result.probe.fields, { a: '1' });
  });
  test('остановка перед «Сохранить» — done needs_decision со списком отелей', () => {
    const r = classify('arrival', { status: 'needs_decision', probe: { labels: { 'Kpp': '03.09.2026' } },
      last: { tables: [{ headers: ['Mehmonxona', 'Kirish', 'Chiqish'], rows: [['Hotel A', '01.09.2026', '03.09.2026']] }] } });
    assert.equal(r.status, 'done');
    assert.equal(r.code, 'needs_decision');
    assert.deepEqual(r.result.last.tables[0].rows, ['Hotel A | 01.09.2026 | 03.09.2026']);
  });
  test('не найден в госбазе — done not_found (повтор только новыми данными)', () => {
    const r = classify('arrival', { status: 'not_found', notFoundText: 'topilmadi' });
    assert.equal(r.status, 'done');
    assert.equal(r.result.notFoundText, 'topilmadi');
    assert.equal(classify('probe', { status: 'not_found' }).status, 'done');
  });
  test('временное — failed с кодом, текстом и дампом', () => {
    const r = classify('arrival', { status: 'no_room', probe: { fields: { wdays: '3' }, tables: [{ rows: [['x', 'y']] }] } });
    assert.equal(r.status, 'failed');
    assert.equal(r.error.code, 'no_room');
    assert.equal(r.error.message, DESCRIBE.no_room);
    assert.deepEqual(r.error.probe.tables[0].rows, ['x | y']);
    assert.equal(r.error.status, undefined, 'status в error не дублируется');
  });
  test('need_login у любого типа — failed', () => {
    for (const t of ['arrival', 'probe', 'list', 'departure', 'tursbor']) assert.equal(classify(t, { status: 'need_login' }).status, 'failed', t);
  });
  test('проверка паспорта: valid — done, дамп сверху со свёрнутыми строками', () => {
    const r = classify('probe', { status: 'valid', officialName: 'IVANOV IVAN', fields: { a: '1' }, tables: [{ headers: ['h'], rows: [['1', '2']] }], keys: ['a | A'] });
    assert.equal(r.status, 'done');
    assert.equal(r.result.officialName, 'IVANOV IVAN');
    assert.deepEqual(r.result.tables[0].rows, ['1 | 2']);
  });
  test('список и турсбор: ok — done, прочее — failed', () => {
    assert.equal(classify('list', { status: 'ok', rows: [{ passport: 'A', name: 'B' }] }).status, 'done');
    assert.equal(classify('list', { status: 'no_table' }).status, 'failed');
    assert.equal(classify('tursbor', { status: 'ok', data: {} }).status, 'done');
  });
  test('выселение: done/submitted/absent/not_found — done; multiple — человеку', () => {
    for (const s of ['done', 'submitted', 'not_found']) assert.equal(classify('departure', { status: s }).status, 'done', s);
    assert.equal(classify('departure', { status: 'multiple' }).status, 'failed');
    assert.equal(classify('check', { status: 'absent' }).status, 'done');
  });
  test('пустой или странный ответ — failed error', () => {
    assert.equal(classify('arrival', undefined).error.code, 'error');
    assert.equal(classify('arrival', 'строка').error.code, 'error');
    assert.equal(classify('unknown', { status: 'done' }).status, 'failed', 'неизвестный тип задачи не бывает done');
  });
  test('сбой на нашей стороне — временный', () => {
    const r = transportFailure(new Error('портал не загрузился'));
    assert.equal(r.status, 'failed');
    assert.equal(r.transient, true);
    assert.match(r.error.message, /не загрузился/);
  });
});

describe('дамп для Firestore', () => {
  test('flattenDump режет размеры и сворачивает строки', () => {
    const d = flattenDump({ fields: { k: 'x'.repeat(500) }, tables: Array.from({ length: 8 }, () => ({ rows: Array.from({ length: 40 }, () => ['a', 'b']) })), blocks: ['b'.repeat(500)], keys: ['k'] });
    assert.equal(d.fields.k.length, 160);
    assert.equal(d.tables.length, 5);
    assert.equal(d.tables[0].rows.length, 30);
    assert.equal(d.tables[0].rows[0], 'a | b');
    assert.equal(d.blocks[0].length, 300);
    assert.equal(flattenDump(null), null);
  });
  test('sanitize убирает функции и undefined, вложенные массивы делает строками', () => {
    const s = sanitize({ a: 1, f: () => 1, u: undefined, rows: [[1, 2], [3]] });
    assert.deepEqual(s, { a: 1, rows: ['1 | 2', '3'] });
  });
});

describe('лист убытия', () => {
  test('убытие done несёт лист отдельной картой — путь, размер, время', () => {
    const r = classify('departure', { status: 'done', sheet: { path: 't/hst/b/markaz/sheets/g1/AB123_20260911_1432.pdf', bytes: 48211, at: '2026-09-11T09:32:00.000Z', source: 'child' } });
    assert.equal(r.status, 'done');
    assert.equal(r.result.sheet.path, 't/hst/b/markaz/sheets/g1/AB123_20260911_1432.pdf');
    assert.equal(r.result.sheet.bytes, 48211);
    assert.equal(r.result.sheet.source, 'child');
  });
  test('лист не снят — задача всё равно done, причина в sheetError', () => {
    const r = classify('departure', { status: 'submitted', sheetError: { code: 'no_sheet', message: '' } });
    assert.equal(r.status, 'done');
    assert.equal(r.code, 'submitted');
    assert.equal(r.result.sheetError.code, 'no_sheet');
    assert.equal(r.result.sheet, undefined);
  });
});

describe('лист убытия заново (sheet)', () => {
  test('снят и загружен — done с листом; не найден среди выехавших — done not_found', () => {
    const ok = classify('sheet', { status: 'done', sheet: { path: 't/h/b/m/sheets/g/a.pdf', bytes: 100, at: 'x', source: 'child' } });
    assert.equal(ok.status, 'done');
    assert.equal(ok.result.sheet.path, 't/h/b/m/sheets/g/a.pdf');
    assert.equal(classify('sheet', { status: 'not_found' }).status, 'done');
  });
  test('портал не открыл лист или нет кнопки печати — failed с понятной причиной', () => {
    const a = classify('sheet', { status: 'no_sheet', code: 'sheet_empty' });
    assert.equal(a.status, 'failed');
    assert.match(a.error.message, /не открыл лист/);
    const b = classify('sheet', { status: 'no_print_btn' });
    assert.equal(b.status, 'failed');
    assert.match(b.error.message, /Кнопка печати/);
  });
});
