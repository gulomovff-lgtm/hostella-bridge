'use strict';
/**
 * portalRules — решения портала без Electron: что считать адресом портала,
 * что страницей входа, когда напоминать о входе. Вынесено из portal.js,
 * чтобы проверяться тестами без окна (tests/portalRules.test.mjs).
 */
const { TIMING } = require('./config');

/** Только https и только домен emehmon.uz с поддоменами. */
const isEmehmonUrl = (url) => {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return h === 'emehmon.uz' || h.endsWith('.emehmon.uz');
  } catch { return false; }
};

/** Страница входа портала: /login, /login/, /login?next=… */
const isLoginUrl = (url) => /\/login(\b|\/|\?|$)/i.test(String(url || ''));

/** Напоминать о входе не чаще раза в LOGIN_WAIT_MS. */
const shouldRemindLogin = (lastShownAt, now = Date.now(), waitMs = TIMING.LOGIN_WAIT_MS) =>
  now - (Number(lastShownAt) || 0) > waitMs;

module.exports = { isEmehmonUrl, isLoginUrl, shouldRemindLogin };
