'use strict';
/**
 * storageRest — Firebase Storage по REST: положить один объект.
 *
 * Мосту это нужно ради одного файла — листа убытия e-mehmon в PDF. Права
 * решают правила хранилища кассы (hostella-cloud/storage.rules): мост с ролью
 * `bridge` может создать файл только в каталоге `sheets` своего филиала и
 * только `application/pdf`. Токен — тот же ID token, что и для Firestore,
 * заголовок в форме, которую понимает и боевое хранилище, и эмулятор.
 */
const { RestError } = require('./firebaseRest');

async function readJsonSafe(res) {
  try { return await res.json(); } catch { return null; }
}

/**
 * @param {object} p
 * @param {string} p.base         https://firebasestorage.googleapis.com или эмулятор
 * @param {string} p.bucket       имя бакета
 * @param {string} p.path         путь объекта (без ведущего слеша)
 * @param {Buffer|Uint8Array} p.bytes
 * @param {string} [p.contentType]
 * @param {string} p.token        ID token моста
 * @returns {Promise<{path:string, bytes:number, token:string}>}
 */
async function uploadObject({ base, bucket, path, bytes, contentType = 'application/pdf', token, fetchImpl = globalThis.fetch }) {
  if (!path || /^\//.test(path) || path.includes('..')) throw new RestError('путь объекта не задан или не нормализован', { status: 400 });
  if (!bytes || !bytes.length) throw new RestError('пустой файл', { status: 400 });
  const url = `${String(base).replace(/\/$/, '')}/v0/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(path)}`;
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Firebase ${token}`, 'Content-Type': contentType },
      body: bytes,
    });
  } catch (e) {
    throw new RestError(`сеть: ${(e && e.message) || e}`, { status: 0 });
  }
  const json = await readJsonSafe(res);
  if (!res.ok) {
    const msg = (json && json.error && (json.error.message || json.error.code)) || `хранилище ответило ${res.status}`;
    throw new RestError(String(msg), { status: res.status });
  }
  return {
    path: (json && json.name) || path,
    bytes: Number(json && json.size) || bytes.length,
    token: (json && json.downloadTokens) || '',
  };
}

module.exports = { uploadObject };
