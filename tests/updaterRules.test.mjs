/**
 * Когда ставить скачанное обновление: не посреди задачи и не при вводе капчи.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { canInstallNow } = require('../src/updaterRules.js');

describe('обновление ставится, когда очередь свободна', () => {
  test('скачано, очередь свободна, окна входа нет — можно', () => {
    assert.equal(canInstallNow({ updateReady: '0.3.2', quitting: false, busy: false, loginMode: false }).ok, true);
  });
  test('нечего ставить — нельзя', () => {
    assert.match(canInstallNow({ updateReady: null }).why, /не скачано/);
  });
  test('задача в портале — ждём: мастер оборвался бы на полпути', () => {
    assert.match(canInstallNow({ updateReady: '0.3.2', busy: true }).why, /задача/);
  });
  test('кассир в окне входа — ждём: капча пропала бы вместе с окном', () => {
    assert.match(canInstallNow({ updateReady: '0.3.2', loginMode: true }).why, /входа/);
  });
  test('уже выходим — второй раз не запускаем', () => {
    assert.match(canInstallNow({ updateReady: '0.3.2', quitting: true }).why, /выходим/);
  });
});
