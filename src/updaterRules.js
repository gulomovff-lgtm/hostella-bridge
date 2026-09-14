'use strict';
/**
 * updaterRules — когда ставить скачанное обновление.
 *
 * Мост стоит на стойке месяцами; обновление ставится тихо, но не в любой
 * момент: не посреди задачи в портале (мастер оборвётся на полпути) и не
 * когда кассир вводит капчу в окне входа. Правило чистое, чтобы его можно
 * было проверить без Electron (tests/updaterRules.test.mjs).
 *
 * @returns {{ ok: boolean, why: string }}
 */
function canInstallNow({ updateReady, quitting, busy, loginMode } = {}) {
  if (!updateReady) return { ok: false, why: 'обновление не скачано' };
  if (quitting) return { ok: false, why: 'уже выходим' };
  if (busy) return { ok: false, why: 'задача в портале' };
  if (loginMode) return { ok: false, why: 'кассир в окне входа' };
  return { ok: true, why: '' };
}

module.exports = { canInstallNow };
