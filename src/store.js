'use strict';
/**
 * store — что мост помнит между запусками.
 *
 * Один JSON-файл в каталоге данных приложения. Секреты — refresh token моста
 * и пароль от e-mehmon — лежат в нём только зашифрованными: в Electron это
 * `safeStorage` (на Windows — DPAPI, ключ привязан к учётной записи
 * пользователя). Прочитать файл на другом компьютере или под другим
 * пользователем нельзя. Ровно поэтому пароль от портала не покидает мост,
 * а в Firestore его нет ни в каком виде (hostella-cloud/docs/МОСТ.md).
 *
 * Кодек передаётся снаружи: в тестах и в консольном прогоне он простой,
 * в Electron — safeStorage.
 */
const fs = require('node:fs');
const path = require('node:path');

const plainCodec = Object.freeze({
  encrypt: (s) => `plain:${Buffer.from(String(s), 'utf8').toString('base64')}`,
  decrypt: (b) => Buffer.from(String(b).replace(/^plain:/, ''), 'base64').toString('utf8'),
});

/** Кодек поверх Electron safeStorage; без шифрования в системе честно пишет `plain:`. */
function safeStorageCodec(safeStorage) {
  const ok = () => { try { return !!(safeStorage && safeStorage.isEncryptionAvailable()); } catch { return false; } };
  return {
    encrypt: (s) => (ok() ? `dpapi:${safeStorage.encryptString(String(s)).toString('base64')}` : plainCodec.encrypt(s)),
    decrypt: (b) => {
      const v = String(b || '');
      if (v.startsWith('dpapi:')) return safeStorage.decryptString(Buffer.from(v.slice(6), 'base64'));
      return plainCodec.decrypt(v);
    },
  };
}

class Store {
  constructor({ file, codec = plainCodec }) {
    this.file = file;
    this.codec = codec;
    this.data = this._read();
  }

  _read() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  _write() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  get(key, fallback = null) { return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : fallback; }

  set(key, value) {
    if (value === undefined || value === null) delete this.data[key];
    else this.data[key] = value;
    this._write();
  }

  setSecret(name, value) {
    const s = { ...(this.data.secrets || {}) };
    if (value === undefined || value === null || value === '') delete s[name];
    else s[name] = this.codec.encrypt(value);
    this.data.secrets = s;
    this._write();
  }

  getSecret(name) {
    const s = this.data.secrets || {};
    if (!s[name]) return null;
    try { return this.codec.decrypt(s[name]); } catch { return null; }
  }

  hasSecret(name) { return !!((this.data.secrets || {})[name]); }

  clear() {
    this.data = {};
    this._write();
  }
}

module.exports = { Store, plainCodec, safeStorageCodec };
