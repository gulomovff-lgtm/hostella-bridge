/**
 * Очередь моста (src/queue.js): что берём, как отдаём итог, когда стоим.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import queue from '../src/queue.js';

const { Worker, pickJobs, afterFailure } = queue;

const NOW = Date.parse('2026-09-11T10:00:00.000Z');
const job = (o = {}) => ({
  id: 'j', path: 'projects/p/databases/cloud/documents/tenants/t1/emehmonJobs/j', updateTime: 'T1',
  type: 'arrival', hostelId: 'b1', guestId: 'g1', status: 'pending', attempts: 0, maxAttempts: 3,
  createdAt: '2026-09-11T09:00:00.000Z', expiresAt: '2026-09-11T09:30:00.000Z', payload: { passport: 'AA1' }, ...o,
});

describe('разбор снимка очереди', () => {
  test('старшие первыми, просроченные отдельно, чужие статусы мимо', () => {
    const { ready, expired } = pickJobs([
      job({ id: 'new', createdAt: '2026-09-11T09:50:00.000Z', expiresAt: '2026-09-11T10:20:00.000Z' }),
      job({ id: 'old', createdAt: '2026-09-11T09:40:00.000Z', expiresAt: '2026-09-11T10:10:00.000Z' }),
      job({ id: 'dead', createdAt: '2026-09-11T09:00:00.000Z', expiresAt: '2026-09-11T09:30:00.000Z' }),
      job({ id: 'busy', status: 'claimed' }),
    ], NOW);
    assert.deepEqual(ready.map((j) => j.id), ['old', 'new']);
    assert.deepEqual(expired.map((j) => j.id), ['dead']);
  });
  test('после неудачи: временную повторяем, пока есть попытки; иначе failed', () => {
    assert.equal(afterFailure(job({ attempts: 0 }), { transient: true }).status, 'pending');
    assert.equal(afterFailure(job({ attempts: 2 }), { transient: true }).status, 'failed');
    assert.equal(afterFailure(job({ attempts: 0 }), { transient: false }).status, 'failed');
    assert.equal(afterFailure(job({ attempts: 0 }), { transient: true }).attempts, 1);
  });
});

/** Память вместо Firestore: те же три операции, что зовёт Worker. */
class FakeFs {
  constructor(docs = []) {
    this.docs = new Map();
    this.queries = [];
    this.writes = [];
    for (const d of docs) this.docs.set(`tenants/t1/emehmonJobs/${d.id}`, { ...d });
  }
  async patch(path, data) {
    this.writes.push({ path, data });
    const cur = this.docs.get(path) || { id: path.split('/').pop(), path };
    this.docs.set(path, { ...cur, ...data, updateTime: `T${this.writes.length}` });
    return this.docs.get(path);
  }
  async commitUpdate(path, data, { updateTime }) {
    const cur = this.docs.get(path);
    if (!cur || cur.updateTime !== updateTime) return false;
    await this.patch(path, data);
    return true;
  }
  async runQuery(parent, q) {
    this.queries.push({ parent, q });
    return [...this.docs.values()].filter((d) => d.status === 'pending' && d.type);
  }
  doc(id) { return this.docs.get(`tenants/t1/emehmonJobs/${id}`); }
}

const worker = (fs, runner, extra = {}) => new Worker({
  fs, tenantId: 't1', branchId: 'b1', bridgeId: 'PC-1', runner, meta: { host: 'PC', version: '0.1.0' },
  log: { info() {}, warn() {}, error() {} }, ...extra,
});

describe('Worker', () => {
  test('берёт задачу своего филиала, ведёт её к done и пишет результат', async () => {
    const fs = new FakeFs([job({ id: 'j1', expiresAt: '2099-01-01T00:00:00.000Z' })]);
    const seen = [];
    const w = worker(fs, { run: async (type, payload) => { seen.push([type, payload.passport]); return { status: 'done', probe: { fields: {} } }; } });
    w.state.running = true;
    await w.tick();
    const d = fs.doc('j1');
    assert.equal(d.status, 'done');
    assert.equal(d.result.status, 'done');
    assert.equal(d.attempts, 1);
    assert.equal(d.claimedBy, 'PC-1');
    assert.equal(d.leaseUntil, null);
    assert.deepEqual(seen, [['arrival', 'AA1']]);
    const where = fs.queries[0].q.where.compositeFilter.filters.map((f) => f.fieldFilter.field.fieldPath);
    assert.deepEqual(where, ['hostelId', 'status'], 'запрос ограничен своим филиалом — иначе правила его не пропустят');
    assert.equal(w.state.jobsDone, 1);
  });

  test('нет входа — failed need_login, очередь на паузе до входа', async () => {
    const fs = new FakeFs([job({ id: 'j1', expiresAt: '2099-01-01T00:00:00.000Z' }), job({ id: 'j2', createdAt: '2026-09-11T09:10:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' })]);
    let loggedIn = false; let asked = 0;
    const w = worker(fs, { run: async () => ({ status: 'need_login' }), isLoggedIn: async () => loggedIn, onNeedLogin: async () => { asked += 1; } });
    w.state.running = true;
    await w.tick();
    assert.equal(fs.doc('j1').status, 'failed');
    assert.equal(fs.doc('j1').error.code, 'need_login');
    assert.equal(w.state.paused, 'need_login');
    assert.equal(asked, 1);
    assert.equal(fs.doc('j2').status, 'pending', 'вторую не трогаем — упала бы тем же');
    await w.tick();
    assert.equal(fs.doc('j2').status, 'pending');
    loggedIn = true;
    w.runner.run = async () => ({ status: 'done' });
    await w.tick();
    assert.equal(w.state.paused, null);
    assert.equal(fs.doc('j2').status, 'done');
  });

  test('сбой на нашей стороне — задача возвращается в pending с попыткой', async () => {
    const fs = new FakeFs([job({ id: 'j1', expiresAt: '2099-01-01T00:00:00.000Z' })]);
    const w = worker(fs, { run: async () => { throw new Error('портал не загрузился'); } });
    w.state.running = true;
    await w.tick();
    const d = fs.doc('j1');
    assert.equal(d.status, 'pending');
    assert.equal(d.attempts, 1);
    assert.equal(d.error, null);
    assert.equal(d.claimedBy, null);
  });

  test('исход портала не повторяется сам: no_room — failed сразу', async () => {
    const fs = new FakeFs([job({ id: 'j1', expiresAt: '2099-01-01T00:00:00.000Z' })]);
    const w = worker(fs, { run: async () => ({ status: 'no_room' }) });
    w.state.running = true;
    await w.tick();
    assert.equal(fs.doc('j1').status, 'failed');
    assert.equal(fs.doc('j1').error.code, 'no_room');
  });

  test('задачу уже взял другой мост — пропускаем', async () => {
    const fs = new FakeFs([job({ id: 'j1', updateTime: 'OLD', expiresAt: '2099-01-01T00:00:00.000Z' })]);
    fs.docs.get('tenants/t1/emehmonJobs/j1').updateTime = 'NEW';
    fs.runQuery = async () => [{ ...job({ id: 'j1', updateTime: 'OLD', expiresAt: '2099-01-01T00:00:00.000Z' }) }];
    let ran = 0;
    const w = worker(fs, { run: async () => { ran += 1; return { status: 'done' }; } });
    w.state.running = true;
    await w.tick();
    assert.equal(ran, 0);
    assert.equal(fs.doc('j1').status, 'pending');
  });

  test('просроченная невзятая задача гасится', async () => {
    const fs = new FakeFs([job({ id: 'j1', expiresAt: '2000-01-01T00:00:00.000Z' })]);
    let ran = 0;
    const w = worker(fs, { run: async () => { ran += 1; return { status: 'done' }; } });
    w.state.running = true;
    await w.tick();
    assert.equal(fs.doc('j1').status, 'expired');
    assert.equal(ran, 0);
  });

  test('heartbeat: at, филиал, версия, очередь', async () => {
    const fs = new FakeFs([]);
    const w = worker(fs, { run: async () => ({}) });
    w.state.queue = 3;
    await w.heartbeat();
    const hb = fs.docs.get('tenants/t1/bridges/b1');
    assert.ok(hb.at instanceof Date);
    assert.equal(hb.hostelId, 'b1');
    assert.equal(hb.version, '0.1.0');
    assert.equal(hb.queue, 3);
  });
});
