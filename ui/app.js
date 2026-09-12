/* Окно Hosti Bridge: показывает состояние и передаёт действия в main. */
(() => {
  const $ = (id) => document.getElementById(id);
  const fmt = (iso) => { try { return iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'; } catch { return iso || '—'; } };
  const pill = (el, text, tone) => { el.textContent = text; el.className = `pill ${tone || ''}`; };

  // Слова вместо кодов: кассир видит «убытие · выполнено», а не «departure · done».
  const JOB = { arrival: 'регистрация прибытия', departure: 'убытие', probe: 'проверка в госбазе', sheet: 'лист убытия', check: 'проверка списка', list: 'список портала', tursbor: 'турсбор', recalc: 'пересчёт сумм' };
  const STATUS = { done: 'выполнено', failed: 'отказ', running: 'выполняется', pending: 'в очереди', cancelled: 'отменено', expired: 'просрочено' };
  const CODE = {
    need_login: 'нужен вход в e-mehmon', not_found: 'гость не найден', multiple: 'несколько совпадений', no_room: 'комната не найдена',
    no_citizen: 'страны нет в списке', needs_decision: 'ждёт решения кассира', valid: 'найден в госбазе', submitted: 'отправлено',
    no_sheet: 'лист не получен', sheet_upload: 'лист не загружен', timeout: 'не уложился в срок', error: 'сбой', no_form: 'форма не открылась',
  };
  const jobLine = (j) => {
    if (!j) return '—';
    const code = j.code && j.code !== j.status ? ` (${CODE[j.code] || j.code})` : '';
    return `${JOB[j.type] || j.type} · ${STATUS[j.status] || j.status}${code} · ${fmt(j.finishedAt || j.startedAt)}`;
  };

  // Без main-процесса (открыли index.html в браузере при вёрстке) — показной снимок.
  const demoApi = () => {
    const state = {
      version: '0.3.0', profile: 'demo', host: 'STAND-PC', paired: true,
      pairing: { tenantId: 'demo-hostel', branchId: 'b1', pairedAt: new Date().toISOString() },
      session: { ok: true }, portal: { hasLogin: true, hasPassword: true, login: '1742t@emehmon.uz' },
      worker: { running: true, queue: 0, jobsDone: 12, jobsFailed: 1, lastPollAt: new Date().toISOString(), lastJob: { type: 'departure', status: 'done', code: 'done', finishedAt: new Date().toISOString() } },
      autostart: true, updateReady: null,
      security: { tlsMin: 'TLS 1.2', httpsOnly: true, hosts: ['europe-west3-hosti-cloud-5577f.cloudfunctions.net', 'firestore.googleapis.com', 'firebasestorage.googleapis.com', 'emehmon.uz'], secretsEncrypted: true },
    };
    const ok = async () => ({ ok: true });
    return { getState: async () => state, pair: ok, unpair: ok, setCreds: ok, openPortal: ok, testPortal: async () => ({ ok: true, loggedIn: true }), sweepNow: ok, setAutostart: ok, openLogs: ok, installUpdate: ok, quit: ok, onState: () => {} };
  };
  const api = window.bridge || demoApi();

  let state = null;
  let credsDirty = false;

  function render(s) {
    state = s;
    $('hdr-sub').textContent = `мост e-mehmon для Hosti Cloud · v${s.version}${s.profile === 'demo' ? ' · demo' : ''}`;
    $('hdr-host').textContent = s.host || '';

    // Подключение
    const paired = s.paired && s.pairing;
    const w = s.worker;
    $('pair-form').hidden = !!paired;
    $('pair-info').hidden = !paired;
    let head = { text: 'не подключён', tone: 'warn' };
    if (paired) {
      $('p-tenant').textContent = s.pairing.tenantId;
      $('p-branch').textContent = s.pairing.branchId;
      $('p-at').textContent = fmt(s.pairing.pairedAt);
      const ses = s.session || {};
      let tone = 'ok', text = 'в сети', note = 'Мост отмечается в кассе каждые 30 секунд; касса считает его в сети, пока молчание короче 90 секунд.';
      if (ses.starting) { tone = ''; text = 'подключаюсь…'; note = ''; }
      else if (ses.reason === 'revoked') { tone = 'bad'; text = 'отключён администратором'; note = 'В кассе нажали «Отключить мост». Чтобы продолжить, возьмите новый код и подключитесь заново.'; }
      else if (!ses.ok) { tone = 'warn'; text = ses.reason === 'offline' ? 'нет связи' : 'ошибка'; note = ses.message || 'Проверьте интернет. Мост попробует снова через минуту.'; }
      pill($('pair-pill'), text, tone);
      $('p-session').textContent = text;
      $('p-note').textContent = note;
      head = { text, tone };
      if (w && w.paused === 'need_login') head = { text: 'нужен вход в e-mehmon', tone: 'bad' };
      else if (tone === 'ok' && w && w.lastJob && w.lastJob.status === 'running') head = { text: `выполняю: ${JOB[w.lastJob.type] || w.lastJob.type}`, tone: 'ok' };
    } else {
      pill($('pair-pill'), 'не подключён', 'warn');
    }
    $('hdr-pill').textContent = head.text;
    $('hdr-pill').className = `pill-big ${head.tone}`;

    // Портал
    if (!credsDirty) {
      $('login').value = s.portal.login || '';
      if (!$('password').value && s.portal.hasPassword) $('password').placeholder = '•••••••• (сохранён)';
    }
    if (w && w.paused === 'need_login') pill($('portal-pill'), 'нужен вход', 'bad');
    else if (!s.portal.hasLogin) pill($('portal-pill'), 'логин не задан', 'warn');
    else pill($('portal-pill'), 'учётка сохранена', 'ok');

    // Работа
    if (!w) pill($('work-pill'), paired ? 'запускается' : 'ожидание', '');
    else if (!w.running) pill($('work-pill'), 'остановлен', 'warn');
    else if (w.paused) pill($('work-pill'), 'пауза: нет входа', 'bad');
    else if (w.lastJob && w.lastJob.status === 'running') pill($('work-pill'), `выполняю: ${JOB[w.lastJob.type] || w.lastJob.type}`, 'ok');
    else pill($('work-pill'), 'жду задачи', 'ok');
    $('w-queue').textContent = w ? String(w.queue) : '—';
    $('w-last').textContent = w ? jobLine(w.lastJob) : '—';
    $('w-count').textContent = w ? `${w.jobsDone} / ${w.jobsFailed}` : '—';
    $('w-poll').textContent = w ? fmt(w.lastPollAt) : '—';
    const err = w && w.lastError;
    $('w-err').hidden = !err;
    if (err) $('w-err').textContent = `${err.kind === 'heartbeat' ? 'Отметка в кассе' : err.kind === 'poll' ? 'Опрос очереди' : 'Запись итога'}: ${err.message} (${fmt(err.at)})`;
    $('autostart').checked = !!s.autostart;
    $('upd-row').hidden = !s.updateReady;
    if (s.updateReady) $('upd-note').textContent = `Скачана версия ${s.updateReady}. Поставится сама, когда очередь свободна.`;
    $('btn-sweep').disabled = !w;

    // Защита данных — по фактам из main, не по обещаниям
    const sec = s.security || {};
    $('sec-hosts-list').textContent = (sec.hosts || []).join(', ') || '—';
    $('sec-tls').classList.toggle('off', sec.httpsOnly === false);
    $('sec-dpapi').classList.toggle('off', sec.secretsEncrypted === false);
    const secOk = sec.httpsOnly !== false && sec.secretsEncrypted !== false;
    pill($('sec-pill'), secOk ? 'включена' : 'внимание', secOk ? 'ok' : 'bad');
  }

  async function refresh() { render(await api.getState()); }

  $('btn-pair').addEventListener('click', async () => {
    const code = $('code').value.trim();
    $('pair-err').hidden = true;
    $('btn-pair').disabled = true;
    try {
      const r = await api.pair(code);
      if (!r.ok) { $('pair-err').textContent = r.message || 'Не удалось подключиться'; $('pair-err').hidden = false; }
      else $('code').value = '';
    } finally {
      $('btn-pair').disabled = false;
      refresh();
    }
  });
  $('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-pair').click(); });

  $('btn-unpair').addEventListener('click', async () => {
    if (!confirm('Отключить мост от Hosti Cloud? Госрегистрация из кассы этого филиала остановится, пока мост не подключат заново.')) return;
    await api.unpair();
    refresh();
  });

  $('login').addEventListener('input', () => { credsDirty = true; });
  $('password').addEventListener('input', () => { credsDirty = true; });
  $('btn-creds').addEventListener('click', async () => {
    const login = $('login').value.trim();
    const password = $('password').value;
    await api.setCreds({ login, password: password || undefined });
    credsDirty = false;
    $('password').value = '';
    $('portal-note').textContent = 'Сохранено.';
    $('portal-note').className = 'note ok';
    $('portal-note').hidden = false;
    refresh();
  });
  $('btn-login').addEventListener('click', async () => {
    if (credsDirty) await $('btn-creds').click();
    await api.openPortal();
  });
  $('btn-test').addEventListener('click', async () => {
    $('btn-test').disabled = true;
    $('portal-note').hidden = true;
    try {
      const r = await api.testPortal();
      $('portal-note').textContent = !r.ok ? `Не удалось: ${r.message}` : r.loggedIn ? 'Сессия портала жива — вход не нужен.' : 'Портал просит войти — нажмите «Войти в e-mehmon…».';
      $('portal-note').className = `note ${!r.ok ? 'bad' : r.loggedIn ? 'ok' : 'bad'}`;
      $('portal-note').hidden = false;
    } finally {
      $('btn-test').disabled = false;
      refresh();
    }
  });
  $('btn-sweep').addEventListener('click', async () => { await api.sweepNow(); refresh(); });
  $('autostart').addEventListener('change', async (e) => {
    const r = await api.setAutostart(e.target.checked);
    if (r && r.ok === false) { e.target.checked = !e.target.checked; }
    refresh();
  });
  $('btn-logs').addEventListener('click', () => api.openLogs());
  $('btn-update').addEventListener('click', () => api.installUpdate());
  $('btn-quit').addEventListener('click', () => {
    if (confirm('Выйти? Пока мост выключен, касса не сможет регистрировать гостей в e-mehmon.')) api.quit();
  });

  api.onState(render);
  refresh();
})();
