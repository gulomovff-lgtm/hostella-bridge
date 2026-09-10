#!/usr/bin/env node
/**
 * Консольный прогон ядра моста БЕЗ Electron — для эмуляторов Hosti Cloud.
 *
 *   node scripts/core-run.mjs --demo pair <код>       подключиться кодом из кассы
 *   node scripts/core-run.mjs --demo status            что помним, жива ли сессия
 *   node scripts/core-run.mjs --demo run [scenarios]   очередь со stub-порталом
 *   node scripts/core-run.mjs --demo unpair
 *
 * Stub-портал отвечает по файлу сценариев (по типу задачи, по гостю,
 * `whenGate`/`whenForce` — как боевые скрипты при gateStays/force). Так
 * проверяется всё, кроме самого портала: подключение, heartbeat, взятие
 * задачи, запись итога, реакция кассы. Настоящий портал — только в Electron.
 *
 * Данные лежат в ./.data (в git не попадают), секреты — простым кодеком:
 * это стенд, а не касса.
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import cfg from '../src/config.js';
import storeMod from '../src/store.js';
import authMod from '../src/auth.js';
import rest from '../src/firebaseRest.js';
import queueMod from '../src/queue.js';

const { profileFor, VERSION, TIMING } = cfg;
const { Store } = storeMod;
const { Session } = authMod;
const { Firestore } = rest;
const { Worker } = queueMod;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const profile = profileFor(argv, process.env);
const cmd = argv.find((a) => !a.startsWith('--')) || 'status';
const rest_ = argv.filter((a) => !a.startsWith('--')).slice(1);

const store = new Store({ file: path.join(HERE, '..', '.data', `bridge-${profile.name}.json`) });
const session = new Session({ profile, store, host: `${os.hostname()}-core`, version: `${VERSION}-core`, log: console });

function stubRunner(file) {
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
  return {
    async run(type, payload, job) {
      const all = read();
      const byGuest = (all.byGuest && job.guestId && all.byGuest[job.guestId]) || {};
      let s = byGuest[type] || all[type] || null;
      if (s && s.whenForce && payload.force) s = s.whenForce;
      if (s && s.whenGate && payload.gateStays && !payload.force) s = s.whenGate;
      console.log(`→ ${type} ${job.guestId || ''} gate=${!!payload.gateStays} force=${!!payload.force} →`, s ? (s.failed ? `failed ${s.failed.code}` : s.status) : 'нет сценария → error');
      await new Promise((r) => setTimeout(r, 800));
      if (!s) return { status: 'error', message: 'нет сценария' };
      if (s.failed) return { status: s.failed.code, message: s.failed.message };
      const { whenForce, whenGate, ...result } = s;
      return result;
    },
    async isLoggedIn() { return true; },
    async onNeedLogin() { console.log('!! нужен вход в портал'); },
  };
}

async function main() {
  if (cmd === 'pair') {
    const p = await session.pair(rest_[0]);
    console.log('подключён:', p);
    return;
  }
  if (cmd === 'unpair') { session.unpair(); console.log('отключён'); return; }
  if (!session.isPaired) { console.log('мост не подключён — сначала pair <код>'); process.exit(1); }
  const check = await session.check();
  console.log('сессия:', check.ok ? `ok (${check.claims.rol}, ${check.claims.tid}, ${check.claims.brs})` : `${check.reason}: ${check.message}`);
  if (cmd === 'status' || !check.ok) return;

  const { tenantId, branchId } = session.pairing;
  const fsc = new Firestore({ base: profile.firestoreBase, projectId: profile.projectId, databaseId: profile.databaseId, getToken: () => session.getIdToken() });
  const scen = rest_[0] ? path.resolve(rest_[0]) : path.join(HERE, 'scenarios.example.json');
  const worker = new Worker({
    fs: fsc, tenantId, branchId, bridgeId: `core-${os.hostname()}`, runner: stubRunner(scen),
    meta: { host: `${os.hostname()}-core`, version: `${VERSION}-core` }, log: console,
    timing: { ...TIMING, POLL_MS: 3000 },
    onState: (s) => { if (s.lastError) console.log('ошибка:', s.lastError.kind, s.lastError.message); },
  });
  worker.start();
  console.log(`очередь ${tenantId}/${branchId}: сценарии ${scen}; Ctrl+C для выхода`);
  process.on('SIGINT', () => { worker.stop(); process.exit(0); });
}

main().catch((e) => { console.error('ошибка:', e.message); process.exit(1); });
