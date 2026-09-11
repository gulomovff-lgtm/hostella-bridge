'use strict';
/**
 * config — куда ходит мост и с какими интервалами живёт.
 *
 * Два профиля. `prod` — рабочий проект Hosti Cloud; ключ здесь — публичный
 * web-ключ Firebase, он же лежит в бандле кассы, секретом не является. `demo` —
 * эмуляторы на этой же машине (`npm run emulators` в hostella-cloud), чтобы
 * ядро моста можно было прогнать без портала и без боевой базы.
 *
 * Паролей от e-mehmon здесь нет и быть не может: они хранятся только на
 * компьютере филиала под шифрованием Windows (src/store.js).
 */
const { version } = require('../package.json');

const PROD = Object.freeze({
  name: 'prod',
  projectId: 'hosti-cloud-5577f',
  apiKey: 'AIzaSyD8BMLE34MZes15j0bwefRgX-hLDZvWOfM',
  region: 'europe-west3',
  databaseId: 'cloud',
  functionsBase: 'https://europe-west3-hosti-cloud-5577f.cloudfunctions.net',
  identityBase: 'https://identitytoolkit.googleapis.com',
  tokenBase: 'https://securetoken.googleapis.com',
  firestoreBase: 'https://firestore.googleapis.com',
  // Лист убытия кладётся в хранилище кассы (hostella-cloud/storage.rules, каталог sheets).
  storageBase: 'https://firebasestorage.googleapis.com',
  storageBucket: 'hosti-cloud-5577f.firebasestorage.app',
});

const DEMO = Object.freeze({
  name: 'demo',
  projectId: 'demo-hostella',
  apiKey: 'demo-key',
  region: 'europe-west3',
  databaseId: 'cloud',
  functionsBase: 'http://127.0.0.1:5001/demo-hostella/europe-west3',
  identityBase: 'http://127.0.0.1:9099/identitytoolkit.googleapis.com',
  tokenBase: 'http://127.0.0.1:9099/securetoken.googleapis.com',
  firestoreBase: 'http://127.0.0.1:8080',
  storageBase: 'http://127.0.0.1:9199',
  storageBucket: 'demo-hostella.appspot.com',
});

/** Профиль по аргументам запуска (`--demo`) или переменной окружения. */
function profileFor(argv = [], env = {}) {
  if (argv.includes('--demo') || env.HOSTELLA_BRIDGE_PROFILE === 'demo') return DEMO;
  return PROD;
}

/**
 * Интервалы. Контракт (hostella-cloud/docs/МОСТ.md): heartbeat раз в 30 с,
 * порог «не в сети» у кассы 90 с; аренда задачи 2 мин, продлевается, пока
 * мастер работает; невзятая задача истекает через 30 мин (`expiresAt`).
 */
const TIMING = Object.freeze({
  HEARTBEAT_MS: 30 * 1000,
  POLL_MS: 5 * 1000,
  LEASE_MS: 2 * 60 * 1000,
  LEASE_RENEW_MS: 60 * 1000,
  JOB_TIMEOUT_MS: 4 * 60 * 1000,      // мастер с гейтом ждёт до 20 с на шаг; с запасом
  LOGIN_WAIT_MS: 15 * 60 * 1000,      // сколько ждём вход кассира, прежде чем снова напомнить
  RETRY_AFTER_ERROR_MS: 15 * 1000,
});

/** Конечные статусы задачи — как в client.js кассы. */
const TERMINAL = Object.freeze(['done', 'failed', 'cancelled', 'expired']);

module.exports = { PROD, DEMO, profileFor, TIMING, TERMINAL, VERSION: version };
