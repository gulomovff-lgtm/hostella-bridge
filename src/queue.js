'use strict';
/**
 * queue — очередь задач моста: забрать, выполнить, записать итог.
 *
 * Контракт — hostella-cloud/docs/МОСТ.md. Кратко:
 *
 *   pending → claimed → running → done | failed
 *
 *   • берём задачу транзакцией (предусловие «документ не менялся»): два
 *     моста одного филиала не возьмут одну и ту же;
 *   • аренда 2 минуты и продлевается, пока мастер работает, — если мост
 *     умер посреди задачи, её перехватит любой мост филиала (в том числе
 *     этот же после перезапуска): `claimed/running` с истёкшей арендой
 *     берётся тем же предусловием, попытка засчитывается; когда попытки
 *     кончились — `failed/stale`, чтобы касса решила сама;
 *   • итог не перетирает отмену: перед записью документ перечитывается,
 *     и если он уже конечный (`cancelled` от сервера при отзыве моста),
 *     запись не делается;
 *   • невзятую и просроченную (`expiresAt`) задачу переводим в `expired`:
 *     регистрировать гостя по задаче получасовой давности уже не просят;
 *   • временный сбой на нашей стороне возвращает задачу в `pending`, пока
 *     не исчерпаны попытки; исход портала пишется как есть (src/outcome.js);
 *   • «нет входа» останавливает очередь до входа кассира — иначе каждая
 *     следующая задача падала бы тем же.
 *
 * Чистые помощники вынесены наружу и покрыты тестами (tests/queue.test.mjs);
 * класс Worker держит только время и побочные действия.
 */
const { whereEq, whereIn, whereAll, isTransient } = require('./firebaseRest');
const { classify, transportFailure, DESCRIBE } = require('./outcome');
const { TIMING, TERMINAL } = require('./config');

/** Разбор снимка очереди: что брать, что гасить. */
function pickJobs(docs, now = Date.now()) {
  const pending = (docs || []).filter((d) => d && d.status === 'pending');
  const expired = pending.filter((d) => d.expiresAt && Date.parse(d.expiresAt) < now);
  const ready = pending.filter((d) => !expired.includes(d))
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  return { ready, expired };
}

/**
 * Зависшие задачи: взяты (`claimed`/`running`), а аренда истекла.
 * Старшие первыми — они ждут дольше всех.
 */
function pickStale(docs, now = Date.now()) {
  return (docs || [])
    .filter((d) => d && (d.status === 'claimed' || d.status === 'running'))
    .filter((d) => d.leaseUntil && Number.isFinite(Date.parse(d.leaseUntil)) && Date.parse(d.leaseUntil) < now)
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}

/** Что писать после неудачи: повтор или конец. */
function afterFailure(job, { transient, now = Date.now() } = {}) {
  const attempts = (Number(job && job.attempts) || 0) + 1;
  const max = Number(job && job.maxAttempts) || 3;
  if (transient && attempts < max) {
    return { status: 'pending', attempts, claimedBy: null, claimedAt: null, leaseUntil: null, updatedAt: new Date(now).toISOString() };
  }
  return { status: 'failed', attempts, leaseUntil: null, updatedAt: new Date(now).toISOString() };
}

const iso = (ms) => new Date(ms).toISOString();

class Worker {
  /**
   * @param {object} p
   * @param {import('./firebaseRest').Firestore} p.fs
   * @param {string} p.tenantId
   * @param {string} p.branchId
   * @param {string} p.bridgeId   идентификатор этого моста (host + случайный хвост)
   * @param {object} p.runner     { run(type, payload, job) → Promise<result>, onNeedLogin?, isLoggedIn? }
   * @param {object} [p.meta]     { host, version } для heartbeat
   * @param {object} [p.log]
   * @param {Function} [p.onState]
   * @param {object} [p.timing]
   */
  constructor({ fs, tenantId, branchId, bridgeId, runner, meta = {}, log = console, onState = () => {}, timing = TIMING }) {
    this.fs = fs;
    this.tenantId = tenantId;
    this.branchId = branchId;
    this.bridgeId = bridgeId;
    this.runner = runner;
    this.meta = meta;
    this.log = log;
    this.onState = onState;
    this.timing = timing;
    this.state = { running: false, busy: false, paused: null, queue: 0, lastPollAt: null, lastJob: null, lastError: null, jobsDone: 0, jobsFailed: 0 };
    this._hb = null;
    this._poll = null;
  }

  jobsPath() { return `tenants/${this.tenantId}`; }
  jobPath(id) { return `tenants/${this.tenantId}/emehmonJobs/${id}`; }
  bridgePath() { return `tenants/${this.tenantId}/bridges/${this.branchId}`; }

  setState(patch) {
    Object.assign(this.state, patch);
    try { this.onState({ ...this.state }); } catch { /* слушатель не должен ронять очередь */ }
  }

  start() {
    if (this.state.running) return;
    this.setState({ running: true });
    this.heartbeat().catch(() => {});
    this._hb = setInterval(() => this.heartbeat().catch(() => {}), this.timing.HEARTBEAT_MS);
    this._poll = setInterval(() => this.tick().catch((e) => this.log.warn('[queue] tick:', e.message)), this.timing.POLL_MS);
    setTimeout(() => this.tick().catch(() => {}), 1500);
  }

  stop() {
    clearInterval(this._hb); clearInterval(this._poll);
    this._hb = null; this._poll = null;
    this.setState({ running: false });
  }

  /** Остановить разбор очереди (нет входа в портал) — heartbeat продолжается. */
  pause(reason) { if (this.state.paused !== reason) this.setState({ paused: reason }); }
  resume() { if (this.state.paused) this.setState({ paused: null }); }

  async heartbeat() {
    try {
      await this.fs.patch(this.bridgePath(), {
        at: new Date(),
        hostelId: this.branchId,
        version: String(this.meta.version || ''),
        host: String(this.meta.host || '').slice(0, 80),
        queue: Number(this.state.queue) || 0,
        // Кассе это поле не нужно, а человеку, смотрящему документ, — да.
        paused: this.state.paused || null,
        bridgeId: this.bridgeId,
      });
      if (this.state.lastError && this.state.lastError.kind === 'heartbeat') this.setState({ lastError: null });
    } catch (e) {
      this.setState({ lastError: { kind: 'heartbeat', message: e.message, at: iso(Date.now()) } });
      throw e;
    }
  }

  async fetchPending() {
    const docs = await this.fs.runQuery(this.jobsPath(), {
      from: [{ collectionId: 'emehmonJobs' }],
      where: whereAll(whereEq('hostelId', this.branchId), whereEq('status', 'pending')),
      // Индекс кассы: hostelId, status, createdAt DESC. Порядок для нас
      // не важен — старшие первыми сортирует pickJobs.
      orderBy: [{ field: { fieldPath: 'createdAt' }, direction: 'DESCENDING' }],
      limit: 20,
    });
    return docs;
  }
  /**
   * Взятые задачи своего филиала — среди них ищем те, у кого истекла аренда.
   * Срок отбирается на месте, а не в запросе: неравенство по `leaseUntil`
   * вместе с двумя равенствами потребовало бы составного индекса в кассе,
   * а взятых задач у филиала единицы.
   */
  async fetchTaken() {
    const docs = await this.fs.runQuery(this.jobsPath(), {
      from: [{ collectionId: 'emehmonJobs' }],
      where: whereAll(whereEq('hostelId', this.branchId), whereIn('status', ['claimed', 'running'])),
      limit: 20,
    });
    return docs;
  }

  async tick() {
    if (!this.state.running || this.state.busy) return;
    this.setState({ busy: true });
    try {
      const docs = await this.fetchPending();
      const { ready, expired } = pickJobs(docs, Date.now());
      this.setState({ queue: ready.length, lastPollAt: iso(Date.now()) });
      for (const j of expired) {
        await this.fs.patch(this.jobPath(j.id), { status: 'expired', updatedAt: iso(Date.now()) }).catch((e) => this.log.warn('[queue] expired:', e.message));
      }
      if (this.state.paused) {
        // Вход есть? — снимаем паузу сами, кассиру не придётся ничего нажимать.
        if (this.runner.isLoggedIn && await this.runner.isLoggedIn().catch(() => false)) this.resume();
        else return;
      }
      for (const job of ready) {
        if (!this.state.running || this.state.paused) break;
        const took = await this.claim(job);
        if (!took) continue;
        await this.execute({ ...job, status: 'claimed' });
      }
      // Зависшее после чужого (или своего прежнего) падения — перехватить.
      const stale = pickStale(await this.fetchTaken(), Date.now());
      for (const job of stale) {
        if (!this.state.running || this.state.paused) break;
        const took = await this.reclaim(job);
        if (!took) continue;
        // Попытку уже засчитал reclaim; итог допишет ту же цифру, не удвоив.
        await this.execute({ ...job, status: 'claimed' });
      }
    } catch (e) {
      this.setState({ lastError: { kind: 'poll', message: e.message, at: iso(Date.now()) } });
      if (!isTransient(e)) this.log.error('[queue] опрос очереди:', e.message);
    } finally {
      this.setState({ busy: false });
    }
  }

  async claim(job) {
    const now = Date.now();
    const ok = await this.fs.commitUpdate(this.jobPath(job.id), {
      status: 'claimed', claimedBy: this.bridgeId, claimedAt: iso(now),
      leaseUntil: iso(now + this.timing.LEASE_MS), updatedAt: iso(now),
    }, { updateTime: job.updateTime });
    if (!ok) this.log.info('[queue] задачу уже взял другой мост:', job.id);
    return ok;
  }

  /**
   * Перехватить задачу с истёкшей арендой. Попытка засчитывается: мост,
   * который её брал, до итога не дошёл. Когда попытки кончились — `failed`
   * с кодом `stale`, а не бесконечный круг: касса решит, повторять ли.
   * @returns {boolean} взяли ли (false — успел другой мост или задача исчезла)
   */
  async reclaim(job) {
    const now = Date.now();
    const attempts = (Number(job.attempts) || 0) + 1;
    const max = Number(job.maxAttempts) || 3;
    if (attempts >= max) {
      const gaveUp = await this.fs.commitUpdate(this.jobPath(job.id), {
        status: 'failed', attempts, leaseUntil: null, updatedAt: iso(now),
        error: { code: 'stale', message: DESCRIBE.stale, staleFrom: job.claimedBy || null },
      }, { updateTime: job.updateTime });
      if (gaveUp) this.log.warn(`[queue] ${job.type} ${job.id}: аренда истекла ${attempts} раз — failed/stale`);
      return false;
    }
    const ok = await this.fs.commitUpdate(this.jobPath(job.id), {
      status: 'claimed', claimedBy: this.bridgeId, claimedAt: iso(now), attempts,
      leaseUntil: iso(now + this.timing.LEASE_MS), reclaimedFrom: job.claimedBy || null, updatedAt: iso(now),
    }, { updateTime: job.updateTime });
    if (ok) this.log.info(`[queue] ${job.type} ${job.id}: перехвачена после ${job.claimedBy || '?'} (попытка ${attempts})`);
    return ok;
  }
  async execute(job) {
    const started = Date.now();
    this.setState({ lastJob: { id: job.id, type: job.type, guestId: job.guestId || null, startedAt: iso(started), status: 'running' } });
    await this.fs.patch(this.jobPath(job.id), { status: 'running', updatedAt: iso(started) }).catch(() => {});
    const renew = setInterval(() => {
      this.fs.patch(this.jobPath(job.id), { leaseUntil: iso(Date.now() + this.timing.LEASE_MS) }).catch(() => {});
    }, this.timing.LEASE_RENEW_MS);

    let outcome;
    try {
      const res = await withTimeout(this.runner.run(job.type, job.payload || {}, job), this.timing.JOB_TIMEOUT_MS);
      outcome = classify(job.type, res);
    } catch (e) {
      outcome = transportFailure(e);
      this.log.warn(`[queue] ${job.type} ${job.id}: сбой — ${e.message}`);
    } finally {
      clearInterval(renew);
    }

    const now = Date.now();
    let patch;
    if (outcome.status === 'done') {
      patch = { status: 'done', result: outcome.result, error: null, attempts: (Number(job.attempts) || 0) + 1, leaseUntil: null, updatedAt: iso(now) };
    } else {
      patch = { ...afterFailure(job, { transient: !!outcome.transient, now }), error: outcome.error };
      if (patch.status === 'pending') patch.error = null;
    }
    try {
      // Отмену не перетираем: пока мастер работал, сервер мог отозвать мост
      // и поставить `cancelled`. Итог, записанный поверх, выглядел бы как
      // выполненная задача, которую никто не заказывал.
      const cur = await this.fs.get(this.jobPath(job.id)).catch(() => null);
      if (cur && TERMINAL.includes(cur.status)) {
        this.log.warn(`[queue] ${job.type} ${job.id}: уже ${cur.status} — итог не записан`);
        patch = { status: cur.status };
      } else {
        await this.fs.patch(this.jobPath(job.id), patch);
      }
    } catch (e) {
      this.log.error('[queue] итог не записан:', job.id, e.message);
      this.setState({ lastError: { kind: 'write', message: e.message, at: iso(now) } });
    }

    const finished = { id: job.id, type: job.type, guestId: job.guestId || null, startedAt: iso(started), finishedAt: iso(now), status: patch.status, code: outcome.code };
    this.setState({
      lastJob: finished,
      jobsDone: this.state.jobsDone + (patch.status === 'done' ? 1 : 0),
      jobsFailed: this.state.jobsFailed + (patch.status === 'failed' ? 1 : 0),
    });
    this.log.info(`[queue] ${job.type} ${job.id} → ${patch.status} (${outcome.code}) за ${Math.round((now - started) / 1000)} с`);

    if (outcome.code === 'need_login') {
      this.pause('need_login');
      try { await this.runner.onNeedLogin?.(job); } catch (e) { this.log.warn('[queue] onNeedLogin:', e.message); }
    }
    return finished;
  }
}

function withTimeout(promise, ms) {
  let t;
  const timer = new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`timeout ${Math.round(ms / 1000)} с`)), ms); });
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}

module.exports = { Worker, pickJobs, pickStale, afterFailure, withTimeout };
