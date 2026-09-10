'use strict';
/**
 * outcome — что вывод скрипта портала значит для документа задачи.
 *
 * Скрипты — боевые, из Hostella (electron/emehmonAutofill.js), их вывод
 * отдаётся кассе КАК ЕСТЬ: `status` и дампы `probe`/`last`. Здесь решается
 * только одно — `done` это или `failed` — по контракту в
 * hostella-cloud/docs/МОСТ.md:
 *
 *   `done`   — мастер дошёл до конца или до осознанной остановки: касса
 *              такую задачу в тот же день не переставляет;
 *   `failed` — временное: нет входа, портал не ответил, комнату не нашли.
 *              Касса решит сама, когда повторить.
 *
 * И одно техническое: строки таблиц в дампе делаются плоскими. Боевой
 * `harvestWizard` кладёт массив массивов, а Firestore вложенных массивов
 * не принимает — документ с таким результатом не записался бы вовсе.
 *
 * Модуль чистый (tests/outcome.test.mjs).
 */

/** Исходы, после которых задача считается выполненной (по типам). */
const DONE = Object.freeze({
  arrival:   ['done', 'needs_decision', 'not_found', 'submit_unconfirmed'],
  probe:     ['valid', 'not_found'],
  departure: ['done', 'submitted', 'not_found', 'absent'],
  check:     ['present', 'absent'],
  list:      ['ok'],
  tursbor:   ['ok'],
  recalc:    ['done', 'ok'],
});

/** Человеческий текст для `error.message`, когда скрипт своего не дал. */
const DESCRIBE = Object.freeze({
  need_login: 'Нужен вход в e-mehmon на компьютере моста',
  no_form: 'Портал не открыл форму — сайт недоступен или изменился',
  check_timeout: 'Портал не ответил на проверку паспорта',
  step2_failed: 'Портал не принял данные на втором шаге',
  no_room: 'Комната не найдена в списке портала',
  no_citizen: 'Такой страны нет в списке портала',
  no_submit: 'Кнопка «Сохранить» не найдена',
  no_table: 'Список портала не загрузился',
  no_modal: 'Окно выселения не открылось',
  no_button: 'Кнопка выселения не найдена',
  no_checkout_btn: 'Кнопка Check-Out не найдена',
  multiple: 'В списке несколько подходящих строк — нужен человек',
  timeout: 'Мастер не уложился в отведённое время',
  error: 'Сбой автоматики портала',
});

const cap = (s, n) => String(s ?? '').slice(0, n);

/** Строка таблицы → строка с ячейками через « | ». */
const flatRow = (r) => (Array.isArray(r) ? r.map((c) => cap(c, 80)).join(' | ') : cap(r, 400));

/** Дамп вкладки мастера в форме, которую примет Firestore. */
function flattenDump(d) {
  if (!d || typeof d !== 'object') return null;
  const out = {};
  if (d.fields && typeof d.fields === 'object') out.fields = mapStrings(d.fields, 160, 150);
  if (d.labels && typeof d.labels === 'object') out.labels = mapStrings(d.labels, 160, 150);
  if (Array.isArray(d.tables)) {
    out.tables = d.tables.slice(0, 5).map((t) => ({
      id: cap(t && t.id, 80),
      caption: cap(t && t.caption, 80),
      headers: ((t && t.headers) || []).slice(0, 12).map((h) => cap(h, 80)),
      rows: ((t && t.rows) || []).slice(0, 30).map(flatRow),
    }));
  }
  if (Array.isArray(d.blocks)) out.blocks = d.blocks.slice(0, 10).map((b) => cap(b, 300));
  if (Array.isArray(d.keys)) out.keys = d.keys.slice(0, 120).map((k) => cap(k, 160));
  if (d.officialName) out.officialName = cap(d.officialName, 160);
  if (Array.isArray(d.panelIds)) out.panelIds = d.panelIds.slice(0, 20).map((p) => cap(p, 40));
  return out;
}

function mapStrings(obj, valueCap, maxKeys) {
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (n++ >= maxKeys) break;
    out[cap(k, 80)] = cap(v, valueCap);
  }
  return out;
}

/** Всё остальное из вывода скрипта — без функций, undefined и вложенных массивов. */
function sanitize(v, depth = 0) {
  if (v === undefined || typeof v === 'function' || typeof v === 'symbol') return undefined;
  if (v === null) return null;
  if (typeof v === 'string') return cap(v, 4000);
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  if (depth > 6) return cap(JSON.stringify(v), 400);
  if (Array.isArray(v)) return v.slice(0, 500).map((x) => (Array.isArray(x) ? flatRow(x) : sanitize(x, depth + 1)));
  if (typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      const s = sanitize(x, depth + 1);
      if (s !== undefined) out[k] = s;
    }
    return out;
  }
  return cap(String(v), 400);
}

/**
 * Классификация вывода скрипта.
 * @param {string} type тип задачи
 * @param {object} res  то, что вернул executeJavaScript
 * @returns {{ status: 'done'|'failed', result?: object, error?: object, code: string }}
 */
function classify(type, res) {
  const raw = res && typeof res === 'object' ? res : {};
  const code = String(raw.status || 'error');
  const body = sanitize(raw) || {};
  body.status = code;
  if (raw.probe) body.probe = flattenDump(raw.probe);
  if (raw.last) body.last = flattenDump(raw.last);
  // Проверка паспорта отдаёт дамп полями сверху — сворачиваем строки таблиц и там.
  if (Array.isArray(raw.tables)) body.tables = flattenDump({ tables: raw.tables }).tables;
  if (raw.rows && Array.isArray(raw.rows)) body.rows = raw.rows.slice(0, 2000).map((r) => sanitize(r));

  const done = (DONE[type] || []).includes(code);
  if (done) return { status: 'done', code, result: body };

  const { status: _s, message, ...rest } = body;
  return {
    status: 'failed', code,
    error: { code, message: cap(message || DESCRIBE[code] || `Портал ответил «${code}»`, 300), ...rest },
  };
}

/** Сбой на нашей стороне (портал не открылся, окно упало): можно повторить. */
function transportFailure(err) {
  const message = cap((err && err.message) || String(err), 300);
  return { status: 'failed', code: 'error', transient: true, error: { code: 'error', message } };
}

module.exports = { DONE, DESCRIBE, classify, flattenDump, sanitize, transportFailure };
