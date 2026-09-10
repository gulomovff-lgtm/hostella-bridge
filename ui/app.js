/* Окно настроек моста: показывает состояние и передаёт действия в main. */
(() => {
  const $ = (id) => document.getElementById(id);
  const fmt = (iso) => { try { return iso ? new Date(iso).toLocaleString('ru-RU') : '—'; } catch { return iso || '—'; } };
  const pill = (el, text, tone) => { el.textContent = text; el.className = `pill ${tone || ''}`; };
  let state = null;
  let credsDirty = false;

  function render(s) {
    state = s;
    $('hdr-sub').textContent = `мост e-mehmon для Hosti Cloud · v${s.version}${s.profile === 'demo' ? ' · demo' : ''}`;
    $('hdr-host').textContent = s.host || '';

    // Подключение
    const paired = s.paired && s.pairing;
    $('pair-form').hidden = !!paired;
    $('pair-info').hidden = !paired;
    if (paired) {
      $('p-tenant').textContent = s.pairing.tenantId;
      $('p-branch').textContent = s.pairing.branchId;
      $('p-at').textContent = fmt(s.pairing.pairedAt);
      const ses = s.session || {};
      let tone = 'ok', text = 'в сети', note = 'Мост пишет heartbeat раз в 30 секунд; касса считает его «в сети», пока молчание короче 90 секунд.';
      if (ses.starting) { tone = ''; text = 'подключаюсь…'; note = ''; }
      else if (ses.reason === 'revoked') { tone = 'bad'; text = 'отключён администратором'; note = 'В кассе нажали «Отключить мост». Чтобы продолжить, возьмите новый код и подключитесь заново.'; }
      else if (!ses.ok) { tone = 'warn'; text = ses.reason === 'offline' ? 'нет связи' : 'ошибка'; note = ses.message || 'Проверьте интернет. Мост попробует снова через минуту.'; }
      pill($('pair-pill'), text, tone);
      $('p-session').textContent = text;
      $('p-note').textContent = note;
      $('hdr-status').textContent = text;
    } else {
      pill($('pair-pill'), 'не подключён', 'warn');
      $('hdr-status').textContent = 'не подключён';
    }

    // Портал
    if (!credsDirty) {
      $('login').value = s.portal.login || '';
      if (!$('password').value && s.portal.hasPassword) $('password').placeholder = '•••••••• (сохранён)';
    }
    const w = s.worker;
    if (w && w.paused === 'need_login') { pill($('portal-pill'), 'нужен вход', 'bad'); $('hdr-status').textContent = 'нужен вход в e-mehmon'; }
    else if (!s.portal.hasLogin) pill($('portal-pill'), 'логин не задан', 'warn');
    else pill($('portal-pill'), 'учётка сохранена', 'ok');

    // Работа
    if (!w) { pill($('work-pill'), paired ? 'запускается' : 'ожидание', ''); }
    else if (!w.running) pill($('work-pill'), 'остановлен', 'warn');
    else if (w.paused) pill($('work-pill'), 'пауза: нет входа', 'bad');
    else if (w.lastJob && w.lastJob.status === 'running') pill($('work-pill'), `выполняю ${w.lastJob.type}`, 'ok');
    else pill($('work-pill'), 'жду задачи', 'ok');
    $('w-queue').textContent = w ? String(w.queue) : '—';
    $('w-last').textContent = w && w.lastJob ? `${w.lastJob.type} · ${w.lastJob.status}${w.lastJob.code ? ` (${w.lastJob.code})` : ''} · ${fmt(w.lastJob.finishedAt || w.lastJob.startedAt)}` : '—';
    $('w-count').textContent = w ? `${w.jobsDone} / ${w.jobsFailed}` : '—';
    $('w-poll').textContent = w ? fmt(w.lastPollAt) : '—';
    const err = w && w.lastError;
    $('w-err').hidden = !err;
    if (err) $('w-err').textContent = `${err.kind === 'heartbeat' ? 'Heartbeat' : err.kind === 'poll' ? 'Опрос очереди' : 'Запись итога'}: ${err.message} (${fmt(err.at)})`;
    $('autostart').checked = !!s.autostart;
    $('btn-sweep').disabled = !w;
  }

  async function refresh() { render(await window.bridge.getState()); }

  $('btn-pair').addEventListener('click', async () => {
    const code = $('code').value.trim();
    $('pair-err').hidden = true;
    $('btn-pair').disabled = true;
    try {
      const r = await window.bridge.pair(code);
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
    await window.bridge.unpair();
    refresh();
  });

  $('login').addEventListener('input', () => { credsDirty = true; });
  $('password').addEventListener('input', () => { credsDirty = true; });
  $('btn-creds').addEventListener('click', async () => {
    const login = $('login').value.trim();
    const password = $('password').value;
    await window.bridge.setCreds({ login, password: password || undefined });
    credsDirty = false;
    $('password').value = '';
    $('portal-note').textContent = 'Сохранено.';
    $('portal-note').className = 'note ok';
    $('portal-note').hidden = false;
    refresh();
  });
  $('btn-login').addEventListener('click', async () => {
    if (credsDirty) await $('btn-creds').click();
    await window.bridge.openPortal();
  });
  $('btn-test').addEventListener('click', async () => {
    $('btn-test').disabled = true;
    $('portal-note').hidden = true;
    try {
      const r = await window.bridge.testPortal();
      $('portal-note').textContent = !r.ok ? `Не удалось: ${r.message}` : r.loggedIn ? 'Сессия портала жива — вход не нужен.' : 'Портал просит войти — нажмите «Войти в e-mehmon…».';
      $('portal-note').className = `note ${!r.ok ? 'bad' : r.loggedIn ? 'ok' : 'bad'}`;
      $('portal-note').hidden = false;
    } finally {
      $('btn-test').disabled = false;
      refresh();
    }
  });
  $('btn-sweep').addEventListener('click', async () => { await window.bridge.sweepNow(); refresh(); });
  $('autostart').addEventListener('change', async (e) => { await window.bridge.setAutostart(e.target.checked); });
  $('btn-logs').addEventListener('click', () => window.bridge.openLogs());
  $('btn-quit').addEventListener('click', () => {
    if (confirm('Выйти? Пока мост выключен, касса не сможет регистрировать гостей в e-mehmon.')) window.bridge.quit();
  });

  window.bridge.onState(render);
  refresh();
})();
