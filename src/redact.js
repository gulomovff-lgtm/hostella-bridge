'use strict';
/**
 * redact — номера паспортов не должны оседать в журнале на диске стойки.
 *
 * Журнал нужен, чтобы понять, что сломалось; для этого хватает типа задачи,
 * её ключа и кода ошибки. Серия и номер паспорта (две буквы + семь цифр —
 * Узбекистан и большинство соседей, либо девять цифр подряд — паспорта
 * ряда стран СНГ) вырезаются из каждой строки журнала прямо в electron-log.
 */
const PASSPORT_RX = /\b([A-Z]{2})\s?(\d{7})\b/g;
const DIGITS9_RX = /\b(\d{2})\d{7}\b/g;

function redact(text) {
  return String(text).replace(PASSPORT_RX, (_m, series) => `${series}*******`).replace(DIGITS9_RX, (_m, head) => `${head}*******`);
}

/** Аргумент строки журнала любого вида — строка, Error, объект. */
function redactAny(value) {
  if (typeof value === 'string') return redact(value);
  if (value instanceof Error) return redact(value.stack || value.message || String(value));
  if (value && typeof value === 'object') {
    try { return redact(JSON.stringify(value)); } catch { return '[object]'; }
  }
  return value;
}

/** Хук electron-log: применяется к каждому сообщению перед записью. */
function logHook(message) {
  if (message && Array.isArray(message.data)) message.data = message.data.map(redactAny);
  return message;
}

module.exports = { redact, redactAny, logHook, PASSPORT_RX };
