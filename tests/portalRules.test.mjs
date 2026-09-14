/**
 * Решения портала без окна: адрес портала, страница входа, напоминание.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isEmehmonUrl, isLoginUrl, shouldRemindLogin } = require('../src/portalRules.js');
const { TIMING } = require('../src/config.js');

describe('адрес портала', () => {
  test('только https и только emehmon.uz с поддоменами', () => {
    assert.equal(isEmehmonUrl('https://emehmon.uz/listok'), true);
    assert.equal(isEmehmonUrl('https://api.emehmon.uz/x'), true);
    assert.equal(isEmehmonUrl('http://emehmon.uz/listok'), false, 'http — нет');
    assert.equal(isEmehmonUrl('https://emehmon.uz.evil.com/'), false, 'подстрока в чужом домене — нет');
    assert.equal(isEmehmonUrl('https://notemehmon.uz/'), false);
    assert.equal(isEmehmonUrl('мусор'), false);
    assert.equal(isEmehmonUrl(''), false);
  });
});

describe('страница входа', () => {
  test('распознаётся с хвостами и без', () => {
    for (const u of ['https://emehmon.uz/login', 'https://emehmon.uz/login/', 'https://emehmon.uz/login?next=%2Flistok', 'https://emehmon.uz/LOGIN']) {
      assert.equal(isLoginUrl(u), true, u);
    }
    assert.equal(isLoginUrl('https://emehmon.uz/listok'), false);
    assert.equal(isLoginUrl('https://emehmon.uz/loginless'), false, 'слово с другим хвостом — не вход');
  });
});

describe('напоминание о входе', () => {
  test('не чаще раза в LOGIN_WAIT_MS', () => {
    const now = 1_000_000_000_000;
    assert.equal(shouldRemindLogin(0, now), true, 'ни разу не показывали');
    assert.equal(shouldRemindLogin(now - TIMING.LOGIN_WAIT_MS + 1000, now), false, 'только что показывали');
    assert.equal(shouldRemindLogin(now - TIMING.LOGIN_WAIT_MS - 1, now), true);
  });
});
