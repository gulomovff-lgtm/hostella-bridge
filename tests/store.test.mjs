/**
 * Локальное хранилище моста (src/store.js): секреты только зашифрованными.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import storeMod from '../src/store.js';

const { Store, plainCodec, safeStorageCodec } = storeMod;

describe('Store', () => {
  test('значения переживают перезапуск, секреты в файле не в открытом виде', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'bridge-')), 'bridge.json');
    const rev = { encrypt: (s) => `rev:${[...s].reverse().join('')}`, decrypt: (b) => [...b.replace(/^rev:/, '')].reverse().join('') };
    const a = new Store({ file, codec: rev });
    a.set('pairing', { tenantId: 't1', branchId: 'b1' });
    a.setSecret('refreshToken', 'SECRET-123');
    const raw = readFileSync(file, 'utf8');
    assert.ok(!raw.includes('SECRET-123'), 'секрет лежит в файле открытым текстом');
    assert.ok(raw.includes('rev:'), 'кодек не применён');
    const b = new Store({ file, codec: rev });
    assert.deepEqual(b.get('pairing'), { tenantId: 't1', branchId: 'b1' });
    assert.equal(b.getSecret('refreshToken'), 'SECRET-123');
    assert.equal(b.hasSecret('refreshToken'), true);
    b.setSecret('refreshToken', null);
    assert.equal(b.getSecret('refreshToken'), null);
    b.clear();
    assert.equal(new Store({ file, codec: rev }).get('pairing'), null);
  });

  test('plainCodec обратим; safeStorageCodec без шифрования честно пишет plain:', () => {
    assert.equal(plainCodec.decrypt(plainCodec.encrypt('пароль')), 'пароль');
    const c = safeStorageCodec({ isEncryptionAvailable: () => false });
    assert.match(c.encrypt('x'), /^plain:/);
    assert.equal(c.decrypt(c.encrypt('x')), 'x');
    const d = safeStorageCodec({
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(`enc(${s})`),
      decryptString: (b) => b.toString().replace(/^enc\((.*)\)$/, '$1'),
    });
    assert.match(d.encrypt('y'), /^dpapi:/);
    assert.equal(d.decrypt(d.encrypt('y')), 'y');
  });
});
