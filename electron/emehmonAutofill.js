// Скрипт автозаполнения e-mehmon. Инжектится в дочернее окно через executeJavaScript.
// Заполняет вход (email+пароль) и поля мастера, известные из Hostella.
// Капчу, проверку и «Войти»/«Сохранить» делает человек. Поля, которые e-mehmon ставит сам
// (страна рождения/прибытия, пол, Кпп №, дата заезда Кпп, ФИО), НЕ трогаем.

function buildAutofillScript(guest) {
  const G = JSON.stringify(guest || {});
  return `(function(){
  try {
    var GUEST = ${G};
    var $ = window.jQuery || window.$;

    // Прибытие: если мы УЖЕ были на create-page и теперь ушли с неё (после
    // сохранения нажали OK → /listok, или закрыли) — регистрация завершена,
    // закрываем окно и НЕ возвращаемся на создание.
    try {
      if (GUEST.mode !== 'departure') {
        var _arr = sessionStorage.getItem('hostellaArrivedTarget') === '1';
        var _onCreateNow = (location.pathname || '').indexOf('create-page') !== -1;
        var _onLoginNow = (location.pathname || '').indexOf('login') !== -1;
        if (_arr && !_onCreateNow && !_onLoginNow) {
          document.title = '__HOSTELLA_REG_DONE__';
          try { window.close(); } catch(e){}
          return;
        }
      }
    } catch(e){}

    // После входа — авто-редирект на нужную страницу (прибытие → create-page, убытие → /listok).
    // Редиректим только пока ни разу не достигли целевой страницы (иначе после
    // сохранения возвращало бы на новую регистрацию).
    try {
      var _target = GUEST.path || '/listok/create-page';
      // Защита от увода окна на чужой домен: path приходит из Hostella, но
      // берём только «чистый» относительный путь. Строка вида '@evil.com/' или
      // '//evil.com' иначе увела бы окно на чужой origin при редиректе ниже —
      // а туда инжектится автозаполнение с логином/паролем портала.
      if (typeof _target !== 'string' || !/^\\/[A-Za-z0-9\\/_.\\-?=&%]*$/.test(_target) || _target.indexOf('//') === 0) {
        _target = '/listok/create-page';
      }
      var _p = location.pathname || '';
      var _onTarget = _target === '/listok'
        ? (_p.replace(/\\/+$/, '') === '/listok')
        : (_p.indexOf('create-page') !== -1);
      if (sessionStorage.getItem('hostellaTarget') !== _target) {
        sessionStorage.removeItem('hostellaArrivedTarget');
        sessionStorage.setItem('hostellaTarget', _target);
      }
      if (_onTarget) sessionStorage.setItem('hostellaArrivedTarget', '1');
      if (_p.indexOf('login') === -1 && !_onTarget && !sessionStorage.getItem('hostellaArrivedTarget')) {
        location.href = 'https://emehmon.uz' + _target;
        return;
      }
    } catch(e){}

    function byId(id){ return document.getElementById(id); }
    function isVisible(el){ return !!(el && el.offsetParent !== null); }
    function fire(el){ el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }

    function fillEl(el, val, onlyIfEmpty){
      if (!el || val == null || val === '') return false;
      if (onlyIfEmpty && el.value && el.value.length) return false;
      try { if ($) { $(el).val(val).trigger('input').trigger('change'); } } catch(e){}
      el.value = val; fire(el);
      return true;
    }
    function fillInput(id, val){ return fillEl(byId(id), val); }
    function fillSelectValue(id, val){
      var el = byId(id);
      if (!el || val == null || val === '') return false;
      el.value = String(val);
      try { if ($) { $(el).val(String(val)).trigger('change'); return true; } } catch(e){}
      el.dispatchEvent(new Event('change',{bubbles:true}));
      return true;
    }
    function fillSelectByCode(id, code){
      var el = byId(id);
      if (!el || !code) return false;
      var opt = Array.prototype.filter.call(el.options, function(o){ return o.text.indexOf('('+code+')') !== -1; })[0];
      if (!opt) return false;
      return fillSelectValue(id, opt.value);
    }

    function toast(msg, ok){
      var t = document.createElement('div');
      t.textContent = msg;
      t.style.cssText = 'position:fixed;z-index:1000000;left:50%;transform:translateX(-50%);bottom:74px;max-width:320px;text-align:center;'
        + 'background:'+(ok===false?'#e11d48':'#0f9688')+';color:#fff;padding:10px 14px;border-radius:10px;'
        + 'font:600 13px sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.25);';
      document.body.appendChild(t);
      setTimeout(function(){ t.remove(); }, 3500);
    }

    // ── Авто-вход (только email+пароль; капчу и кнопку входа жмёт человек) ──
    function fillLogin(){
      if (!GUEST.login && !GUEST.password) return 0;
      // если это мастер листка — не трогаем
      if (byId('passportNumber') || byId('wdays')) return 0;
      var pw = document.querySelector('input[type="password"]');
      if (!pw) return 0;
      var email = document.querySelector('input[type="email"]')
        || document.querySelector('input[name="email"]')
        || document.querySelector('input[name="login"]')
        || document.querySelector('input[name="username"]');
      if (!email) {
        var texts = Array.prototype.filter.call(
          document.querySelectorAll('input[type="text"], input:not([type])'), isVisible);
        email = texts[0];
      }
      var n = 0;
      if (email && fillEl(email, GUEST.login, true)) n++;
      if (fillEl(pw, GUEST.password, true)) n++;
      if (n) toast('Логин подставлен — введите капчу и войдите.');
      return n;
    }

    // ── Мастер листка прибытия ──
    function fillStep1(){
      var n=0;
      if (fillSelectByCode('id_citizen', GUEST.citizenCode)) n++;
      if (fillSelectValue('id_passporttype', GUEST.docType || '1')) n++;
      if (fillInput('datebirth', GUEST.birthDate)) n++;
      if (fillInput('passportNumber', GUEST.passport)) n++;
      return n;
    }
    function fillStep2(){
      // Местные граждане (Узбекистан) — на шаге 2 ничего не заполняем
      if ((GUEST.citizenCode || '') === 'UZB') return 0;
      var n=0;
      if (fillInput('datePassport', GUEST.passportIssueDate)) n++;
      // Страна рождения = страна гостя (как гражданство / страна прибытия)
      if (fillSelectByCode('id_country', GUEST.citizenCode)) n++;
      if (GUEST.passportIssuedBy && fillInput('passportissuedby', GUEST.passportIssuedBy)) n++;
      return n;
    }
    function fillRoom(room){
      var el = byId('propiska');
      if (!el || room == null || room === '') return false;
      var rStr = String(room).trim();
      var rInt = parseInt(rStr, 10);
      var opt = Array.prototype.filter.call(el.options, function(o){
        if (!o.value) return false;
        var t = (o.text || '').replace(/\\s+/g, ' ').trim();
        if (String(o.value) === rStr) return true;
        if (!isNaN(rInt) && parseInt(t, 10) === rInt) return true;
        return t.indexOf(rStr + ' ') === 0 || t.indexOf(rStr + '-') === 0;
      })[0];
      if (!opt) return false;
      return fillSelectValue('propiska', opt.value);
    }
    // Список комнат в e-mehmon подгружается с задержкой — повторяем попытки
    function fillRoomRetry(room, attempts){
      if (fillRoom(room)) return;
      if (attempts > 0) { setTimeout(function(){ fillRoomRetry(room, attempts - 1); }, 800); return; }
      console.warn('[Hostella] комната не найдена в e-mehmon:', String(room), '— проверьте совпадение номеров комнат');
    }
    function fillStep3(){
      var n=0;
      if (fillInput('wdays', GUEST.days)) n++;
      if (GUEST.room) { fillRoomRetry(GUEST.room, 6); n++; }  // Номер/Комната (с повтором — список грузится с задержкой)
      if (fillSelectValue('id_visittype', '5')) n++;  // Тип визита — Другое
      if (fillSelectValue('payed', '2')) n++;         // Статус оплаты — Оплачен полностью
      // Сумма оплаты: ставка зависит от гражданства (местные / иностранцы),
      // задаётся в настройках приложения и приходит в GUEST.amount.
      if (fillInput('amount', String(GUEST.amount || '1'))) n++;
      if (fillSelectValue('id_guest', '4')) n++;      // Тип гостя — Другое
      return n;
    }
    function currentStep(){
      if (isVisible(byId('passportNumber')) || isVisible(byId('initialForm'))) return 1;
      if (isVisible(byId('datePassport')) || isVisible(byId('sex'))) return 2;
      if (isVisible(byId('wdays')) || isVisible(byId('additionalInfo'))) return 3;
      return 0;
    }
    function doFill(){
      var s = currentStep(), n = 0;
      if (s===1) n=fillStep1();
      else if (s===2) n=fillStep2();
      else if (s===3) n=fillStep3();
      if (s) toast('Шаг '+s+': заполнено полей — '+n+'. Проверьте и нажмите «Далее».');
      else toast('Откройте создание листка прибытия — мастер не найден.', false);
    }

    // ── Режим убытия: найти и выделить гостя в списке /listok ──
    function findAndSelectGuest(){
      if (!$ || !$.fn || !$.fn.DataTable) return false;
      var table;
      try { table = $('#listok-table').DataTable(); } catch(e){ return false; }
      var norm = function(s){ return (s || '').replace(/\\s/g, '').toUpperCase(); };
      var gp = norm(GUEST.passport), gn = norm(GUEST.guestName);
      var node = null;
      table.rows().every(function(){
        var d = this.data() || {};
        var rp = norm(d.passport_numb || d.passport_full || d.passport);
        var rn = norm(d.guest || d.guestname);
        if ((gp && rp && rp === gp) || (gn && rn && rn === gn)) {
          this.select(); $(this.node()).addClass('selected'); node = this.node();
        }
      });
      if (node) { try { node.scrollIntoView({ block: 'center' }); } catch(e){} return true; }
      return false;
    }
    function findGuestRetry(attempts){
      if (findAndSelectGuest()) { toast('Гость выбран. Нажмите «Выселить» или «Печать».'); return; }
      if (attempts > 0) { setTimeout(function(){ findGuestRetry(attempts - 1); }, 800); return; }
      toast('Гость не найден на странице — выберите строку вручную.', false);
    }
    function setupDeparture(){
      if (byId('__hostella_dep_panel')) { findGuestRetry(6); return; }
      var wrap = document.createElement('div');
      wrap.id = '__hostella_dep_panel';
      wrap.style.cssText = 'position:fixed;z-index:1000000;left:50%;transform:translateX(-50%);bottom:18px;display:flex;gap:8px;';
      function mk(txt, bg){
        var b = document.createElement('button'); b.type = 'button'; b.textContent = txt;
        b.style.cssText = 'background:' + bg + ';color:#fff;border:none;border-radius:10px;padding:12px 16px;font:700 14px sans-serif;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.25);';
        return b;
      }
      var bOut = mk('✈️ Выселить', '#e11d48');
      bOut.addEventListener('click', function(){ if (!findAndSelectGuest()) { toast('Гость не выбран — выберите строку.', false); return; } try { $('#checkout').trigger('click'); } catch(e){} });
      var bPrint = mk('🖨 Печать / PDF', '#0f9688');
      bPrint.addEventListener('click', function(){ if (!findAndSelectGuest()) { toast('Гость не выбран — выберите строку.', false); return; } try { $('#custom-print-btn').trigger('click'); } catch(e){} });
      wrap.appendChild(bOut); wrap.appendChild(bPrint);
      document.body.appendChild(wrap);
      findGuestRetry(6);
    }

    if (GUEST.mode === 'departure') {
      setupDeparture();
    } else if (!byId('__hostella_fill_btn')) {
      // Плавающая кнопка для шагов мастера прибытия (idempotent)
      var btn = document.createElement('button');
      btn.id = '__hostella_fill_btn';
      btn.type = 'button';
      btn.textContent = '🏨 Заполнить из Hostella';
      btn.style.cssText = 'position:fixed;z-index:1000000;left:50%;transform:translateX(-50%);bottom:18px;background:#0f9688;color:#fff;'
        + 'border:none;border-radius:10px;padding:12px 16px;font:700 14px sans-serif;cursor:pointer;'
        + 'box-shadow:0 6px 20px rgba(0,0,0,.25);';
      btn.addEventListener('click', doFill);
      document.body.appendChild(btn);
    }

    // Прибытие: авто-закрытие окна после успешного сохранения листка.
    // e-mehmon показывает swal2-success «Muvaffaqiyatli saqlandi» — ловим его и
    // закрываем окно (сигналим main через document.title + пробуем window.close()).
    if (GUEST.mode !== 'departure' && !window.__hostellaRegWatch) {
      window.__hostellaRegWatch = true;
      var _regWatch = setInterval(function(){
        var okIcon = document.querySelector('.swal2-popup .swal2-icon.swal2-success, .swal2-success.swal2-icon-show');
        var ttlEl = document.querySelector('.swal2-popup .swal2-title, .swal2-title');
        var saved = ttlEl && /saqland|сохран|success|muvaffaqiyat/i.test(ttlEl.textContent || '');
        if (okIcon && saved) {
          clearInterval(_regWatch);
          toast('Регистрация сохранена — закрываю окно…');
          // Сразу сигналим main (он закроет окно и поставит галочку), затем пробуем сами.
          try { document.title = '__HOSTELLA_REG_DONE__'; } catch(e){}
          setTimeout(function(){ try { window.close(); } catch(e){} }, 400);
        }
      }, 350);
    }

    // Авто-вход при загрузке (форма может появиться с задержкой)
    fillLogin();
    setTimeout(fillLogin, 900);

    window.__hostellaGuest = GUEST;
  } catch(e){ console.error('[Hostella autofill]', e); }
})();`;
}

// ── Фоновый автомат убытия ──────────────────────────────────────────────────
// Инжектится на /listok и САМ доводит выселение до конца: находит гостя в списке,
// открывает модалку «Chiqish», выставляет TO‘LOV / тип оплаты / галочку печати и
// жмёт «Check-Out». Возвращает Promise со статусом — его дожидается main-процесс.
//   done       — модалка закрылась, выселение прошло
//   submitted  — кнопку нажали, но закрытие модалки не подтвердилось
//   need_login — портал на странице входа (нужны капча/логин)
//   not_found  — гость не найден в списке
//   multiple   — найдено несколько совпадений (авто-выселение небезопасно)
//   no_table / no_modal / no_button / no_checkout_btn / error — сбой автоматизации
function buildDepartureAutoScript(guest) {
  const G = JSON.stringify(guest || {});
  return `(async function(){
  var GUEST = ${G};
  var $ = window.jQuery || window.$;
  var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
  function norm(s){ return (s||'').replace(/\\s/g,'').toUpperCase(); }
  function fire(el){ el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }

  try {
    // 0) страница входа → нужен человек (капча/логин)
    if ((location.pathname||'').indexOf('login') !== -1 || document.querySelector('input[type="password"]')) {
      return { status: 'need_login' };
    }

    // 1) дождаться DataTable списка листков
    function getTable(){ try { return ($ && $.fn && $.fn.DataTable) ? $('#listok-table').DataTable() : null; } catch(e){ return null; } }
    var table = null;
    for (var i=0;i<20 && !table;i++){ table = getTable(); if(!table){ await sleep(400); } }
    if (!table) return { status: 'no_table' };

    // 2) найти и выделить гостя (по паспорту / ФИО)
    function selectGuest(){
      var gp = norm(GUEST.passport), gn = norm(GUEST.guestName), node=null, hits=0;
      table.rows().every(function(){
        var d = this.data() || {};
        var rp = norm(d.passport_numb || d.passport_full || d.passport);
        var rn = norm(d.guest || d.guestname);
        if ((gp && rp && rp===gp) || (gn && rn && rn===gn)) { this.select(); $(this.node()).addClass('selected'); node=this.node(); hits++; }
      });
      return { node: node, hits: hits };
    }
    var sel = null;
    for (var j=0;j<8;j++){ sel = selectGuest(); if (sel.node) break; await sleep(500); }
    if (!sel || !sel.node) return { status: 'not_found' };
    if (sel.hits > 1) return { status: 'multiple' }; // несколько совпадений — не рискуем
    try { sel.node.scrollIntoView({ block: 'center' }); } catch(e){}

    // 3) открыть модалку выселения
    try { $('#checkout').trigger('click'); } catch(e){ return { status: 'no_checkout_btn' }; }

    // 4) дождаться загрузки модалки (контент подгружается AJAX)
    function modalReady(){ return document.querySelector('.confirm input.payment-input') || document.querySelector('input.payment-input'); }
    var ready = false;
    for (var k=0;k<25;k++){ if (modalReady()){ ready = true; break; } await sleep(300); }
    if (!ready) return { status: 'no_modal' };
    await sleep(200);

    // 5) TO‘LOV (сумма) и тип оплаты
    var amount = (GUEST.amount != null && GUEST.amount !== '') ? String(GUEST.amount) : null;
    if (amount) {
      Array.prototype.forEach.call(document.querySelectorAll('input.payment-input'), function(el){
        el.value = amount; try { if ($) $(el).val(amount); } catch(e){} fire(el);
      });
    }
    var payType = (GUEST.payType != null && GUEST.payType !== '') ? String(GUEST.payType) : '1'; // 1 = Boshqa
    Array.prototype.forEach.call(document.querySelectorAll('select.paytp'), function(el){
      el.value = payType; try { if ($) $(el).val(payType).trigger('change'); } catch(e){} fire(el);
    });

    // 6) галочка печати листа убытия (по умолчанию e-mehmon ставит её — снимаем если печать не нужна)
    var pc = document.getElementById('printAll');
    if (pc) { pc.checked = !!GUEST.print; fire(pc); }

    // 7) нажать «Check-Out»
    var btns = Array.prototype.slice.call(document.querySelectorAll('.app-modal-footer .btn-success, .modal-footer .btn-success, .modal-content .btn-success'));
    var btn = btns.filter(function(b){ return /check\\s*-?\\s*out/i.test(b.textContent||''); })[0] || btns[0];
    if (!btn) return { status: 'no_button' };
    btn.click();

    // 8) закрытие модалки = успех
    function modalGone(){ return !document.querySelector('.confirm input.payment-input') && !document.querySelector('.modal.show input.payment-input'); }
    for (var m=0;m<30;m++){ if (modalGone()){ return { status: 'done' }; } await sleep(400); }
    return { status: 'submitted' };
  } catch(e){
    return { status: 'error', message: (e && e.message) || String(e) };
  }
})();`;
}

// ── Проверка: есть ли гость в активном списке /listok ────────────────────────
// /listok содержит ТОЛЬКО активных (после Check-Out гость уходит в /listokout).
// Поэтому: нашёлся → ещё не выселен (present); не нашёлся → уже выселен (absent).
//   present / absent / need_login / no_table / error
function buildDepartureCheckScript(guest) {
  const G = JSON.stringify(guest || {});
  return `(async function(){
  var GUEST = ${G};
  var $ = window.jQuery || window.$;
  var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
  function norm(s){ return (s||'').replace(/\\s/g,'').toUpperCase(); }
  try {
    if ((location.pathname||'').indexOf('login') !== -1 || document.querySelector('input[type="password"]')) {
      return { status: 'need_login' };
    }
    function getTable(){ try { return ($ && $.fn && $.fn.DataTable) ? $('#listok-table').DataTable() : null; } catch(e){ return null; } }
    var table = null;
    for (var i=0;i<20 && !table;i++){ table = getTable(); if(!table){ await sleep(400); } }
    if (!table) return { status: 'no_table' };
    var gp = norm(GUEST.passport), gn = norm(GUEST.guestName), found = false;
    table.rows().every(function(){
      var d = this.data() || {};
      var rp = norm(d.passport_numb || d.passport_full || d.passport);
      var rn = norm(d.guest || d.guestname);
      if ((gp && rp && rp===gp) || (gn && rn && rn===gn)) { found = true; }
    });
    return { status: found ? 'present' : 'absent' };
  } catch(e){ return { status:'error', message:(e&&e.message)||String(e) }; }
})();`;
}

// ── Проверка паспортных данных в госбазе (БЕЗ регистрации) ───────────────────
// Прогоняет ТОЛЬКО первый шаг мастера: гражданство + тип документа + паспорт +
// дата рождения → «Keyingi». Дальше портал либо отвечает «topilmadi» (в госбазе
// такого нет), либо открывает вкладку general-info и сам подставляет официальное
// ФИО. Переход на следующий шаг и есть признак верных данных.
//
// Ничего не сохраняет: запись создаётся только кнопкой submitForm на последнем
// шаге, сюда мы не доходим. Нужно, чтобы разобрать дубликаты клиентов и понять,
// у какой из записей паспорт настоящий (напр. AC против AS).
//
// Имя из госбазы достаём «как получится»: id полей ФИО в портале не зафиксированы,
// поэтому пробуем набор вероятных вариантов и дополнительно отдаём дамп заполненных
// полей general-info (fields) — по нему можно уточнить разбор без новой поездки в портал.
// ── Общие помощники скрытых скриптов (проверка паспорта, авто-прибытие) ────────
// Подставляются в оба скрипта как текст. Здесь же — harvestWizard: дамп полей,
// подписей, таблиц и текстовых блоков вкладки. DOM-имена даты/№ КПП и списка
// прошлых проживаний порталом не задокументированы, поэтому скрипт ничего не
// интерпретирует — отдаёт сырой дамп, разбор делает рендерер (utils/kppRules.js),
// а дамп сохраняется на госте, чтобы уточнить селекторы по живым данным.
const HIDDEN_HELPERS = `
  var $ = window.jQuery || window.$;
  var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
  function byId(id){ return document.getElementById(id); }
  function vis(el){ return !!(el && el.offsetParent !== null); }
  function fire(el){ el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }
  function setInput(id, val){ var el=byId(id); if(!el) return false; el.value=(val==null?'':val); try{ if($) $(el).val(el.value); }catch(e){} fire(el); return true; }
  function setSelect(id, val){ var el=byId(id); if(!el) return false; el.value=String(val); try{ if($) $(el).val(String(val)).trigger('change'); }catch(e){} fire(el); return true; }
  function setSelectByCode(id, code){
    var el=byId(id); if(!el||!code) return false;
    var opt=Array.prototype.filter.call(el.options, function(o){ return (o.text||'').indexOf('('+code+')')!==-1; })[0];
    if(!opt) return false;
    return setSelect(id, opt.value);
  }
  // Гражданство: Узбекистан — известный код 173; остальные — по «(ISO3)» в тексте опции.
  function selectCitizen(code){ if(!code || code==='UZB') return setSelect('id_citizen','173'); return setSelectByCode('id_citizen', code); }
  function activeTab(){ var a=document.querySelector('#myTab .nav-link.active'); return a? a.id : ''; }
  function popups(){ return document.querySelectorAll('.jconfirm, .modal.show, .app-modal-content, .swal2-popup'); }
  function notFound(){
    var nodes = popups();
    for (var i=0;i<nodes.length;i++){ if (/topilmadi/i.test(nodes[i].textContent||'')) return true; }
    return false;
  }
  function notFoundText(){
    var nodes = popups();
    for (var i=0;i<nodes.length;i++){ var tx=String(nodes[i].textContent||'').replace(/\\s+/g,' ').trim(); if (/topilmadi/i.test(tx)) return tx.slice(0,200); }
    return '';
  }
  async function waitFor(fn, tries, gap){ for(var i=0;i<tries;i++){ try{ if(fn()) return true; }catch(e){} await sleep(gap||300); } return false; }
  function textOf(el){ return String((el && el.textContent) || '').replace(/\\s+/g,' ').trim(); }
  function labelFor(el){
    var t='';
    try {
      if (el.id) { var l=document.querySelector('label[for="'+el.id+'"]'); if (l) t=textOf(l); }
      if (!t) { var grp=el.closest('.form-group, .mb-3, .form-floating, .col, .col-md-6, .col-md-4, .col-md-3'); if (grp) { var l2=grp.querySelector('label'); if (l2) t=textOf(l2); } }
      if (!t) t = el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.getAttribute('title') || '';
    } catch(e){}
    return String(t).replace(/[*:\\s]+$/,'').trim().slice(0,80);
  }
  function invalidIds(){
    try { return Array.prototype.map.call(document.querySelectorAll('.is-invalid, .has-error, .error'), function(e){ return e.id||e.name||e.className||''; }).slice(0,10); } catch(e){ return []; }
  }
  function harvestWizard(panelId){
    var out={}, labels={}, tables=[], blocks=[], parts=[], keys=[], n=0;
    var panel = byId(panelId||'general-info') || byId('myTabContent') || document.querySelector('.tab-content') || document;
    var els = panel.querySelectorAll('input, select, textarea');
    for (var i=0;i<els.length && n<150;i++){
      var el=els[i]; if ((el.type||'')==='password' || (el.type||'')==='hidden') continue;
      var key = el.id || el.name || '';
      var val='';
      try { val = el.tagName==='SELECT' ? ((el.options[el.selectedIndex]||{}).text||'') : (el.value||''); } catch(e){}
      val=String(val).replace(/\\s+/g,' ').trim();
      var lb = labelFor(el);
      // Список всех полей, включая ПУСТЫЕ: по нему видно, как портал называет
      // дату/№ КПП, даже когда для этого гостя они не заполнены.
      if (keys.length < 80 && (key || lb)) keys.push((key||'?') + ' | ' + (lb||'') + (val ? '' : ' | (пусто)'));
      if (!val || val==='0') continue;
      val=val.slice(0,160);
      if (key) { out[key]=val; n++; }
      if (lb && labels[lb]===undefined) labels[lb]=val;
    }
    // Таблицы: сначала в панели, затем во всём мастере, затем в документе.
    var scopes=[panel];
    if (panel!==document) { var tc=byId('myTabContent')||document.querySelector('.tab-content'); if (tc && tc!==panel) scopes.push(tc); scopes.push(document); }
    for (var s=0;s<scopes.length && !tables.length;s++){
      var tbs=scopes[s].querySelectorAll('table');
      for (var t=0;t<tbs.length && tables.length<5;t++){
        var tb=tbs[t], headers=[], rows=[];
        var ths=tb.querySelectorAll('thead th, thead td');
        if (!ths.length){ var fr=tb.querySelector('tr'); if (fr && fr.querySelectorAll('th').length) ths=fr.querySelectorAll('th'); }
        for (var h=0;h<ths.length && h<12;h++) headers.push(textOf(ths[h]).slice(0,80));
        var trs=tb.querySelectorAll('tbody tr'); if (!trs.length) trs=tb.querySelectorAll('tr');
        for (var r=0;r<trs.length && rows.length<30;r++){
          var tds=trs[r].querySelectorAll('td'); if (!tds.length) continue;
          var cells=[]; for (var c=0;c<tds.length && c<12;c++) cells.push(textOf(tds[c]).slice(0,80));
          rows.push(cells);
        }
        if (headers.length || rows.length) tables.push({ id: tb.id||'', caption: textOf(tb.querySelector('caption')).slice(0,80), headers: headers, rows: rows });
      }
    }
    var bl = panel.querySelectorAll('.card, .alert, .well, .list-group');
    for (var b=0;b<bl.length && blocks.length<10;b++){ var tx=String(bl[b].innerText||bl[b].textContent||'').trim(); if (tx) blocks.push(tx.slice(0,300)); }
    // ФИО из госбазы: фамилия → имя → отчество. В портале surname — фамилия,
    // firstname — имя, а lastname — ОТЧЕСТВО (у многих заглушка «XXX»); прежний
    // порядок давал «фамилия отчество имя».
    var order = ['surname','familiya','sname','firstname','firstName','name','ism','lastname','lastName','patronymic','middlename','otchestvo','sharif'];
    for (var j=0;j<order.length;j++){
      for (var key2 in out){
        var v2 = out[key2];
        if (key2.toLowerCase()===order[j].toLowerCase() && parts.indexOf(v2)===-1 && !/^(xxx|x|-|—|\\.)$/i.test(v2)) parts.push(v2);
      }
    }
    var name = parts.join(' ').replace(/\\s+/g,' ').trim();
    if (!name) { for (var lk in labels){ if (/f\\.?i\\.?o|фио|to\\W?liq ism|full ?name/i.test(lk)) { name=labels[lk]; break; } } }
    var panelIds=[]; var panes=document.querySelectorAll('.tab-pane'); for (var q=0;q<panes.length;q++) if (panes[q].id) panelIds.push(panes[q].id);
    return { fields:out, labels:labels, tables:tables, blocks:blocks, keys:keys, officialName:name, panelIds:panelIds };
  }
  // Слить дампы двух вкладок в один (поля/подписи — объединение, таблицы/блоки/ключи — конкатенация).
  function mergeProbe(a, b){
    if (!a) return b; if (!b) return a;
    var f={}, l={}, k;
    for (k in a.fields) f[k]=a.fields[k]; for (k in b.fields) if (f[k]===undefined) f[k]=b.fields[k];
    for (k in a.labels) l[k]=a.labels[k]; for (k in b.labels) if (l[k]===undefined) l[k]=b.labels[k];
    return { fields:f, labels:l, tables:(a.tables||[]).concat(b.tables||[]), blocks:(a.blocks||[]).concat(b.blocks||[]),
             keys:(a.keys||[]).concat(b.keys||[]), officialName:a.officialName||b.officialName||'', panelIds:a.panelIds||b.panelIds||[] };
  }
`;

function buildPassportCheckScript(guest) {
  const G = JSON.stringify(guest || {});
  return `(async function(){
  var G = ${G};
  ${HIDDEN_HELPERS}
  try {
    if ((location.pathname||'').indexOf('login')!==-1 || document.querySelector('input[type=password]')) return { status:'need_login' };

    // 1) ждём форму первого шага
    if (!(await waitFor(function(){ return byId('passportNumber') && byId('id_citizen'); }, 30, 400))) return { status:'no_form' };
    await sleep(300);

    // 2) заполняем проверяемые данные и жмём «Keyingi». Гражданство — по коду
    //    гостя (иностранцев проверяем так же, как местных); без кода — UZB.
    if (!selectCitizen(G.citizenCode)) return { status:'no_citizen', code: G.citizenCode||'' };
    setSelect('id_passporttype', G.docType || '1');
    setInput('datebirth', G.birthDate);
    setInput('passportNumber', (G.passport||'').toUpperCase());
    await sleep(500);
    var fcb = byId('formCheckButton');
    if (!fcb) return { status:'no_form' };
    fcb.removeAttribute('disabled');
    fcb.click();

    // 3) вердикт: «не найден» либо переход на general-info
    if (!(await waitFor(function(){ return notFound() || activeTab()==='general-info-tab' || vis(byId('datePassport')) || vis(byId('sex')); }, 40, 500))) return { status:'check_timeout' };
    if (notFound()) return { status:'not_found', notFoundText: notFoundText() };
    await sleep(700);   // даём порталу дозаполнить general-info
    // Портал дописывает вкладку асинхронно (в т.ч. дату КПП) — ждём до 3 с признаков.
    await waitFor(function(){ var p=byId('general-info')||document; return !!(p.querySelector('table') || p.querySelector('[id*="kpp" i],[name*="kpp" i],[id*="chegara" i],[name*="chegara" i]')); }, 6, 500);
    var h = harvestWizard('general-info');
    // На второй вкладке даты КПП может не быть (у портала там только дата
    // заезда). Идём на третью — она тоже до «Сохранить», ничего не пишем.
    try {
      var foreign = !!(G.citizenCode && G.citizenCode !== 'UZB');
      if (foreign) {
        if (G.passportIssueDate) setInput('datePassport', G.passportIssueDate);
        setSelectByCode('id_country', G.citizenCode);
        if (G.passportIssuedBy) setInput('passportissuedby', G.passportIssuedBy);
        await sleep(300);
      }
      var g2 = document.querySelector('#general-info button[onclick*=additional-info-tab]');
      if (g2) {
        g2.click();
        if (await waitFor(function(){ return activeTab()==='additional-info-tab' || vis(byId('wdays')); }, 20, 400)) {
          await sleep(800);
          h = mergeProbe(h, harvestWizard('additional-info'));
        }
      }
    } catch(e){}
    return { status:'valid', officialName: h.officialName, fields: h.fields, labels: h.labels, tables: h.tables, blocks: h.blocks, keys: h.keys, panelIds: h.panelIds };
  } catch(e){ return { status:'error', message:(e&&e.message)||String(e) }; }
})();`;
}

// ── Получить весь активный список /listok (для фоновой синхронизации статусов) ─
// Возвращает { status:'ok', rows:[{passport,name}] } по всем строкам текущего
// аккаунта. /listok — только активные (зарегистрированные сейчас иностранцы).
function buildListFetchScript() {
  return `(async function(){
  var $ = window.jQuery || window.$;
  var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
  function norm(s){ return (s||'').replace(/\\s/g,'').toUpperCase(); }
  try {
    if ((location.pathname||'').indexOf('login') !== -1 || document.querySelector('input[type="password"]')) {
      return { status: 'need_login' };
    }
    function getTable(){ try { return ($ && $.fn && $.fn.DataTable) ? $('#listok-table').DataTable() : null; } catch(e){ return null; } }
    var table = null;
    for (var i=0;i<20 && !table;i++){ table = getTable(); if(!table){ await sleep(400); } }
    if (!table) return { status: 'no_table' };
    try { table.page.len(-1).draw(false); } catch(e){} // показать все строки (клиентская пагинация)
    await sleep(300);
    function dec(s){ return String(s||'').replace(/&#039;|&#39;/g, "'").replace(/&amp;/g, '&'); }
    var rows = [];
    table.rows().every(function(){
      var d = this.data() || {};
      rows.push({
        passport: norm(d.passport_numb || d.passport_full || d.passport),
        name: norm(d.guest || d.guestname),
        displayName: dec(d.guest || d.guestname || ''),
        room: d.room || '',
        days: d.wdays || '',
        country: dec(d.ctzn || ''),
        checkIn: d.check_in || d.dt || '',
        regNumb: d.reg_numb || ''
      });
    });
    return { status: 'ok', rows: rows };
  } catch(e){ return { status:'error', message:(e&&e.message)||String(e) }; }
})();`;
}

// ── Турсбор: отчёт со страницы /tursborpays ───────────────────────────────────
// Портал отдаёт данные через DataTables serverSide: GET /tursborpays/data
//   tp:         HT — иностранцы, LT — местные, ST — самостоятельные туристы
//   date_range: 'YYYY-MM-DD ~ YYYY-MM-DD'
// Тянем все три типа за один проход и возвращаем строки + БРВ со страницы.
// Поля строки: qty (гостей), lived (прожито суток), minsalary (БРВ),
// percent (% БРВ), tursbor (ставка), tp_lived (начислено суток), real_tursbor (итого).
function buildTursborFetchScript(payload) {
  const P = JSON.stringify(payload || {});
  return `(async function(){
  var DATA = ${P};
  var RANGE = DATA.range || '';
  try {
    if ((location.pathname||'').indexOf('login') !== -1 || document.querySelector('input[type="password"]')) {
      return { status: 'need_login' };
    }
    // Разбор чисел портала. Форматы на одной странице разные:
    // «412,000.00» (запятая = разряды) и «110 000.00» (пробел = разряды),
    // возможен и «1 234 567,00» (запятая = дробная часть). Определяем, какой
    // разделитель дробный, по ПОСЛЕДНЕМУ вхождению, иначе сумма врала в 100 раз.
    var num = function(v){
      if (v == null) return 0;
      if (typeof v === 'number') return isFinite(v) ? v : 0;
      var s = String(v)
        .replace(/<[^>]*>/g, '')          // html-обёртки
        .replace(/&nbsp;|&#160;/g, ' ')
        .replace(/[\\u00A0\\u202F\\u2009]/g, ' ') // неразрывные пробелы
        .trim();
      var neg = /^\\(.*\\)$/.test(s) || /^-/.test(s);   // (1 234) или -1234
      s = s.replace(/[^0-9.,]/g, '');                 // валюта, буквы, пробелы
      if (!s) return 0;
      var lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
      var dec = Math.max(lastDot, lastComma);
      if (dec === -1) {
        s = s;                                        // целое без разделителей
      } else {
        var tail = s.length - dec - 1;
        // Разделитель дробный, только если после него 1–2 цифры (копейки).
        // «1,234» и «1.234» с тремя цифрами — это разряды, а не дробь.
        if (tail >= 1 && tail <= 2) {
          s = s.slice(0, dec).replace(/[.,]/g, '') + '.' + s.slice(dec + 1);
        } else {
          s = s.replace(/[.,]/g, '');
        }
      }
      var n = parseFloat(s);
      if (!isFinite(n)) return 0;
      return neg ? -n : n;
    };
    var strip = function(v){ return String(v == null ? '' : v).replace(/<[^>]*>/g, '').replace(/&nbsp;/g,' ').trim(); };

    async function fetchType(tp){
      var url = '/tursborpays/data?draw=1&start=0&length=2000'
              + '&tp=' + encodeURIComponent(tp)
              + '&date_range=' + encodeURIComponent(RANGE);
      var res = await fetch(url, { credentials: 'same-origin', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
      if (!res.ok) return { tp: tp, error: 'HTTP ' + res.status, rows: [] };
      var j = await res.json();
      var list = (j && j.data) || [];
      var rows = list.map(function(d){
        return {
          hotel:    strip(d.hotel),
          company:  strip(d.hotel_company),
          inn:      strip(d.inn),
          district: strip(d.district_name),
          guests:   num(d.qty),          // кол-во гостей
          lived:    num(d.lived),        // прожито суток
          brv:      num(d.minsalary),    // БРВ
          percent:  num(d.percent),      // % БРВ
          rate:     num(d.tursbor),      // ставка турсбора
          accrued:  num(d.tp_lived),     // начислено (сутки)
          total:    num(d.real_tursbor), // итого к оплате, сум
          // Сырые строки портала — чтобы расхождение было видно, а не гадалось
          rawTotal:  strip(d.real_tursbor),
          rawRate:   strip(d.tursbor),
          rawGuests: strip(d.qty),
          rawLived:  strip(d.lived),
        };
      });
      return { tp: tp, rows: rows, recordsTotal: (j && j.recordsTotal) || rows.length };
    }

    var types = ['HT', 'LT', 'ST'];
    var out = {};
    for (var i = 0; i < types.length; i++) {
      try { out[types[i]] = await fetchType(types[i]); }
      catch (e) { out[types[i]] = { tp: types[i], error: (e && e.message) || String(e), rows: [] }; }
    }

    // БРВ и депозит — со страницы (если открыта именно /tursborpays)
    var brvTxt = '', depTxt = '';
    try {
      var badge = document.querySelector('.card-title .badge');
      if (badge) brvTxt = strip(badge.textContent);
      var dep = document.querySelector('.hotel-info span');
      if (dep) depTxt = strip(dep.textContent);
    } catch(e){}

    return { status: 'ok', range: RANGE, data: out, brvText: brvTxt, depositText: depTxt };
  } catch(e){ return { status:'error', message:(e&&e.message)||String(e) }; }
})();`;
}

// ── Массовое выселение: выделить все совпавшие строки и выселить разом ─────────
// e-mehmon поддерживает множественный Check-Out (модалка Chiqish с несколькими
// строками). Принимает { list:[{passport,name}], amount, payType, print }.
//   done / submitted / not_found / no_modal / no_button / need_login / error
function buildDepartureBulkScript(payload) {
  const P = JSON.stringify(payload || {});
  return `(async function(){
  var DATA = ${P};
  var LIST = DATA.list || [];
  var $ = window.jQuery || window.$;
  var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
  function norm(s){ return (s||'').replace(/\\s/g,'').toUpperCase(); }
  function fire(el){ el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }
  try {
    if ((location.pathname||'').indexOf('login') !== -1 || document.querySelector('input[type="password"]')) {
      return { status: 'need_login' };
    }
    function getTable(){ try { return ($ && $.fn && $.fn.DataTable) ? $('#listok-table').DataTable() : null; } catch(e){ return null; } }
    var table = null;
    for (var i=0;i<20 && !table;i++){ table = getTable(); if(!table){ await sleep(400); } }
    if (!table) return { status: 'no_table' };
    try { table.page.len(-1).draw(false); } catch(e){}
    await sleep(300);
    var targets = LIST.map(function(g){ return { p: norm(g.passport), n: norm(g.name) }; });
    var selected = 0;
    table.rows().every(function(){
      var d = this.data() || {};
      var rp = norm(d.passport_numb || d.passport_full || d.passport);
      var rn = norm(d.guest || d.guestname);
      var hit = targets.some(function(t){ return (t.p && rp && t.p===rp) || (t.n && rn && t.n===rn); });
      if (hit) {
        try { this.select(); } catch(e){}
        $(this.node()).addClass('selected');
        var cb = this.node().querySelector('input.row-select');
        if (cb && !cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change',{bubbles:true})); }
        selected++;
      }
    });
    if (!selected) return { status: 'not_found', selected: 0, requested: LIST.length };
    try { $('#checkout').trigger('click'); } catch(e){ return { status: 'no_checkout_btn', selected: selected }; }
    function modalReady(){ return document.querySelector('.confirm input.payment-input') || document.querySelector('input.payment-input'); }
    var ready = false;
    for (var k=0;k<25;k++){ if (modalReady()){ ready = true; break; } await sleep(300); }
    if (!ready) return { status: 'no_modal', selected: selected };
    await sleep(200);
    var amount = (DATA.amount != null && DATA.amount !== '') ? String(DATA.amount) : '1';
    Array.prototype.forEach.call(document.querySelectorAll('input.payment-input'), function(el){ el.value = amount; try { if ($) $(el).val(amount); } catch(e){} fire(el); });
    var payType = (DATA.payType != null && DATA.payType !== '') ? String(DATA.payType) : '1';
    Array.prototype.forEach.call(document.querySelectorAll('select.paytp'), function(el){ el.value = payType; try { if ($) $(el).val(payType).trigger('change'); } catch(e){} fire(el); });
    var pc = document.getElementById('printAll');
    if (pc) { pc.checked = !!DATA.print; fire(pc); }
    var btns = Array.prototype.slice.call(document.querySelectorAll('.app-modal-footer .btn-success, .modal-footer .btn-success, .modal-content .btn-success'));
    var btn = btns.filter(function(b){ return /check\\s*-?\\s*out/i.test(b.textContent||''); })[0] || btns[0];
    if (!btn) return { status: 'no_button', selected: selected };
    btn.click();
    function modalGone(){ return !document.querySelector('.confirm input.payment-input') && !document.querySelector('.modal.show input.payment-input'); }
    for (var m=0;m<40;m++){ if (modalGone()){ return { status: 'done', selected: selected, requested: LIST.length }; } await sleep(400); }
    return { status: 'submitted', selected: selected, requested: LIST.length };
  } catch(e){ return { status: 'error', message: (e && e.message) || String(e) }; }
})();`;
}

// ── Пересчёт стоимости услуг в листках прибытия ───────────────────────────────
// Портал ждёт сумму за фактическое проживание: 10 суток по 30 000 = 300 000.
// Приложение считает суммы само (utils/emehmonAmount) и передаёт готовый список
// { passport, name, amount }; здесь мы находим строки в /listok, отбираем те,
// где сумма отличается, и отправляем их пачками через тот же эндпоинт, что и
// пункт меню «Изменить статус оплаты» (POST /listok/status-payment).
//   done / need_login / no_table / not_found / error
function buildRecalcScript(payload) {
  const P = JSON.stringify(payload || {});
  return `(async function(){
  var DATA = ${P};
  var ITEMS = DATA.items || [];
  var STATUS = String(DATA.paymentStatus || '2');   // 2 — оплачен полностью
  var $ = window.jQuery || window.$;
  var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
  function norm(s){ return (s||'').replace(/\\s/g,'').toUpperCase(); }
  // «30 000.00», «412,000.00», «1 234 567,00» → число. Дробным считаем ПОСЛЕДНИЙ
  // разделитель, иначе сумма врёт в сто раз.
  function money(v){
    var s = String(v == null ? '' : v).replace(/[^0-9.,]/g, '');
    if (!s) return NaN;
    var lastDot = s.lastIndexOf('.'), lastCom = s.lastIndexOf(',');
    var cut = Math.max(lastDot, lastCom);
    if (cut > -1 && s.length - cut - 1 <= 2) {
      s = s.slice(0, cut).replace(/[.,]/g, '') + '.' + s.slice(cut + 1);
    } else {
      s = s.replace(/[.,]/g, '');
    }
    var n = parseFloat(s);
    return isFinite(n) ? n : NaN;
  }
  try {
    if ((location.pathname||'').indexOf('login') !== -1 || document.querySelector('input[type="password"]')) {
      return { status: 'need_login' };
    }
    function getTable(){ try { return ($ && $.fn && $.fn.DataTable) ? $('#listok-table').DataTable() : null; } catch(e){ return null; } }
    var table = null;
    for (var i=0;i<20 && !table;i++){ table = getTable(); if(!table){ await sleep(400); } }
    if (!table) return { status: 'no_table' };
    try { table.page.len(-1).draw(false); } catch(e){}
    await sleep(300);

    var want = ITEMS.map(function(g){ return { p: norm(g.passport), n: norm(g.name), amount: Math.round(Number(g.amount)||0) }; })
                    .filter(function(g){ return g.amount > 0 && (g.p || g.n); });
    if (!want.length) return { status: 'done', updated: 0, matched: 0, skipped: 0 };

    var byAmount = {};      // сумма → [id листка]
    var matched = 0, skipped = 0;
    table.rows().every(function(){
      var d = this.data() || {};
      var rp = norm(d.passport_numb || d.passport_full || d.passport);
      var rn = norm(d.guest || d.guestname);
      var hit = null;
      for (var k=0;k<want.length;k++){
        var t = want[k];
        if ((t.p && rp && t.p === rp) || (t.n && rn && t.n === rn)) { hit = t; break; }
      }
      if (!hit || !d.id) return;
      matched++;
      var cur = money(d.amount);
      if (isFinite(cur) && Math.round(cur) === hit.amount) { skipped++; return; }   // уже верная сумма
      (byAmount[hit.amount] = byAmount[hit.amount] || []).push(d.id);
    });

    if (!matched) return { status: 'not_found', matched: 0, updated: 0, skipped: 0 };
    var groups = Object.keys(byAmount);
    if (!groups.length) return { status: 'done', updated: 0, matched: matched, skipped: skipped };

    var token = (document.querySelector('meta[name="csrf-token"]')||{}).content || '';
    var updated = 0, failed = 0, lastError = '';
    for (var gi=0; gi<groups.length; gi++){
      var amount = groups[gi];
      var ids = byAmount[amount];
      var res = await new Promise(function(resolve){
        $.ajax({
          url: '/listok/status-payment',
          type: 'POST',
          data: { _token: token, guest_ids: ids, paymentStatus: STATUS, payment: String(amount) },
          success: function(r){ resolve(r || {}); },
          error: function(xhr){ resolve({ status: 'error', message: (xhr && xhr.responseJSON && xhr.responseJSON.message) || ('HTTP ' + (xhr && xhr.status)) }); }
        });
      });
      if (res && res.status === 'success') { updated += ids.length; }
      else { failed += ids.length; lastError = (res && res.message) || lastError; }
      await sleep(250);   // не долбим портал очередью
    }
    try { table.ajax.reload(null, false); } catch(e){}
    return { status: failed && !updated ? 'error' : 'done',
             updated: updated, failed: failed, matched: matched, skipped: skipped, message: lastError };
  } catch(e){ return { status: 'error', message: (e && e.message) || String(e) }; }
})();`;
}

// ── Полный авто-мастер прибытия для граждан Узбекистана ───────────────────────
// Прогоняет весь мастер /listok/create-page без кассира: шаг 1 (UZB + паспорт +
// ДР → сервер подтягивает данные из госбазы) → шаг 2 (авто) → шаг 3 (дни, комната,
// тип визита, оплата, сумма, тип гостя) → Saqlash. Любой сбой → безопасный стоп.
//   done / need_login / not_found / no_room / no_form / step2_failed /
//   check_timeout / no_submit / submit_unconfirmed / error
function buildAutoArrivalScript(guest) {
  const G = JSON.stringify(guest || {});
  return `(async function(){
  var G = ${G};
  ${HIDDEN_HELPERS}
  try {
    if ((location.pathname||'').indexOf('login')!==-1 || document.querySelector('input[type=password]')) return { status:'need_login' };

    // 1) ждём форму шага 1
    if (!(await waitFor(function(){ return byId('passportNumber') && byId('id_citizen'); }, 30, 400))) return { status:'no_form' };
    await sleep(300);

    // 2) шаг 1: гражданство по коду (UZB → 173), паспорт, дата рождения → «Keyingi»
    if (!selectCitizen(G.citizenCode)) return { status:'no_citizen', code: G.citizenCode||'' };
    setSelect('id_passporttype', G.docType || '1');
    setInput('datebirth', G.birthDate);
    setInput('passportNumber', (G.passport||'').toUpperCase());
    await sleep(500);
    var fcb = byId('formCheckButton');
    if (!fcb) return { status:'no_form' };
    fcb.removeAttribute('disabled');
    fcb.click();

    // 3) ждём: general-info активна ИЛИ «не найден»
    if (!(await waitFor(function(){ return notFound() || activeTab()==='general-info-tab' || vis(byId('datePassport')) || vis(byId('sex')); }, 40, 500))) return { status:'check_timeout' };
    if (notFound()) return { status:'not_found', notFoundText: notFoundText() };
    await sleep(600);

    // 4) general-info. Местному портал заполняет всё сам. Иностранцу дописываем
    //    то, чего портал не знает: дату выдачи, страну, кем выдан. Поля, которые
    //    ставит портал (ФИО, пол, № и дата КПП, страна рождения), не трогаем.
    var foreign = !!(G.citizenCode && G.citizenCode !== 'UZB');
    if (foreign) {
      if (G.passportIssueDate) setInput('datePassport', G.passportIssueDate);
      setSelectByCode('id_country', G.citizenCode);
      if (G.passportIssuedBy) setInput('passportissuedby', G.passportIssuedBy);
      await sleep(300);
    }
    // Дамп вкладки — отсюда рендерер берёт дату прохода КПП.
    var probe = harvestWizard('general-info');
    var g2 = document.querySelector('#general-info button[onclick*=additional-info-tab]');
    if (g2) g2.click();
    if (!(await waitFor(function(){ return activeTab()==='additional-info-tab' || vis(byId('wdays')); }, 30, 400))) return { status:'step2_failed', probe: probe, invalid: invalidIds() };
    await sleep(300);

    // 5) additional-info: дни → (комнаты грузятся AJAX) → комната по номеру
    setInput('wdays', G.days || '1');
    await sleep(700);
    var room = String(G.room||'').trim(), roomOk=false;
    if (room) {
      roomOk = await waitFor(function(){
        var sel = byId('propiska'); if(!sel) return false;
        var opt = Array.prototype.filter.call(sel.options, function(o){ return o.value && String(o.value)===room; })[0];
        if (opt){ setSelect('propiska', opt.value); return true; }
        return false;
      }, 12, 700);
    }
    if (!roomOk) return { status:'no_room', probe: mergeProbe(probe, harvestWizard('additional-info')) };
    setSelect('id_visittype', '5');  // Boshqa
    setSelect('payed', '2');         // To'liq to'langan
    setInput('amount', G.amount || '1');
    setSelect('id_guest', '4');      // Boshqa
    await sleep(300);
    probe = mergeProbe(probe, harvestWizard('additional-info'));

    var addBtn = document.querySelector('#additional-info button[onclick*=children-info-tab]');
    if (addBtn) addBtn.click();
    await waitFor(function(){ return activeTab()==='children-info-tab'; }, 20, 400);
    await sleep(200);
    var childBtn = document.querySelector('#children-info button[onclick*=guest-info-tab]');
    if (childBtn) childBtn.click();
    await waitFor(function(){ return activeTab()==='guest-info-tab' || byId('submitForm'); }, 20, 400);
    await sleep(300);

    // 6) Последний шаг. У иностранца за пределами окна портал показывает здесь
    //    список отелей, где он жил. Если нас просили (gateStays) — читаем список
    //    и ОСТАНАВЛИВАЕМСЯ до «Сохранить»: регистрировать или направить в
    //    миграционную службу решает человек. force — решение уже принято.
    var last = harvestWizard('guest-info');
    if (G.gateStays && !G.force) return { status:'needs_decision', probe: probe, last: last };

    // 7) Saqlash
    var sub = byId('submitForm');
    if (!sub) return { status:'no_submit', probe: probe, last: last };
    sub.click();

    // 8) ждём успех swal2 «Muvaffaqiyatli saqlandi»
    var done = await waitFor(function(){
      var ic = document.querySelector('.swal2-popup .swal2-icon.swal2-success');
      var t = document.querySelector('.swal2-title');
      return !!(ic && t && /saqland|muvaffaqiyat/i.test(t.textContent||''));
    }, 50, 500);
    return { status: done ? 'done' : 'submit_unconfirmed', probe: probe, last: last };
  } catch(e){ return { status:'error', message:(e&&e.message)||String(e) }; }
})();`;
}

module.exports = { buildAutofillScript, buildDepartureAutoScript, buildDepartureCheckScript, buildPassportCheckScript, buildListFetchScript, buildTursborFetchScript, buildDepartureBulkScript, buildAutoArrivalScript, buildRecalcScript };
