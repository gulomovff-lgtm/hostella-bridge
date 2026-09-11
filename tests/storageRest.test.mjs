/**
 * Загрузка листа убытия в Firebase Storage по REST (src/storageRest.js).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { uploadObject } from '../src/storageRest.js';
import { RestError } from '../src/firebaseRest.js';

const fakeFetch = (status, json) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  };
  return { fetchImpl, calls };
};

describe('uploadObject', () => {
  test('кладёт объект в нужный бакет и путь с токеном моста', async () => {
    const { fetchImpl, calls } = fakeFetch(200, { name: 't/hst/b/markaz/sheets/g1/a.pdf', size: '4321', downloadTokens: 'tok' });
    const r = await uploadObject({
      base: 'http://127.0.0.1:9199/', bucket: 'demo-hostella.appspot.com',
      path: 't/hst/b/markaz/sheets/g1/a.pdf', bytes: Buffer.from('%PDF-1.4 test'), token: 'ID', fetchImpl,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://127.0.0.1:9199/v0/b/demo-hostella.appspot.com/o?name=t%2Fhst%2Fb%2Fmarkaz%2Fsheets%2Fg1%2Fa.pdf');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers.Authorization, 'Firebase ID');
    // multipart с метаданными, как у JS SDK: иначе правила не видят contentType
    assert.match(calls[0].init.headers['Content-Type'], /^multipart\/related; boundary=/);
    assert.equal(calls[0].init.headers['X-Goog-Upload-Protocol'], 'multipart');
    const text = Buffer.from(calls[0].init.body).toString('utf8');
    assert.ok(text.includes('{"name":"t/hst/b/markaz/sheets/g1/a.pdf","contentType":"application/pdf"}'));
    assert.ok(text.includes('Content-Type: application/pdf\r\n\r\n%PDF-1.4 test'));
    assert.deepEqual(r, { path: 't/hst/b/markaz/sheets/g1/a.pdf', bytes: 4321, token: 'tok' });
  });

  test('отказ правил — RestError со статусом хранилища, а не «успех без файла»', async () => {
    const { fetchImpl } = fakeFetch(403, { error: { code: 403, message: 'Permission denied.' } });
    await assert.rejects(
      uploadObject({ base: 'https://firebasestorage.googleapis.com', bucket: 'b', path: 't/x/b/y/sheets/g/a.pdf', bytes: Buffer.from('x'), token: 'ID', fetchImpl }),
      (e) => e instanceof RestError && e.status === 403 && /Permission denied/.test(e.message),
    );
  });

  test('пустой файл и ненормализованный путь не уходят в сеть', async () => {
    const { fetchImpl, calls } = fakeFetch(200, {});
    await assert.rejects(uploadObject({ base: 'x', bucket: 'b', path: 't/x/b/y/sheets/g/a.pdf', bytes: Buffer.alloc(0), token: 'ID', fetchImpl }));
    await assert.rejects(uploadObject({ base: 'x', bucket: 'b', path: '/t/x/b/y/sheets/g/a.pdf', bytes: Buffer.from('x'), token: 'ID', fetchImpl }));
    await assert.rejects(uploadObject({ base: 'x', bucket: 'b', path: 't/x/../y/sheets/g/a.pdf', bytes: Buffer.from('x'), token: 'ID', fetchImpl }));
    assert.equal(calls.length, 0);
  });
});
