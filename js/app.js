/**
 * 追火車組隊媒合 — 前端畫面。
 * 所有規則以後端（apps-script/Code.gs）為準，這裡只負責顯示與送出。
 */
(function () {
  'use strict';

  const $app = document.getElementById('app');
  const $busy = document.getElementById('busy');
  const $busyText = document.getElementById('busy-text');
  const $toast = document.getElementById('toast');
  const $modal = document.getElementById('modal');

  // ============================================================
  //  儲存（無痕模式等情況可能無法使用，失敗時就只存在記憶體）
  // ============================================================
  function storage(kind) {
    return {
      get: function (k) { try { return window[kind].getItem('trainRelay.' + k); } catch (e) { return null; } },
      set: function (k, v) {
        try {
          if (v == null) window[kind].removeItem('trainRelay.' + k);
          else window[kind].setItem('trainRelay.' + k, v);
        } catch (e) { /* 無法保存不影響使用 */ }
      },
    };
  }
  const store = storage('localStorage');
  const session = storage('sessionStorage');

  const state = {
    view: 'loading', tab: store.get('tab') || 'team', config: null, dash: null,
    token: store.get('token'), adminToken: session.get('adminToken'), admin: null, adminPick: [], adminQuery: '',
    invite: null, inviteInfo: null, inviteError: '', teamsFilter: 'open', welcome: '', fatal: '',
    lastLoad: 0, dirty: false, prevView: '', prevTab: '', brandShown: false,
  };

  // ============================================================
  //  安全的 HTML 樣板：插入的值一律跳脫，避免使用者輸入的文字被當成 HTML
  // ============================================================
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ESC[c]; }); }
  function Raw(s) { this.s = s; }
  function out(v) {
    if (v instanceof Raw) return v.s;
    if (Array.isArray(v)) return v.map(out).join('');
    if (v === false || v === null || v === undefined) return '';
    return esc(v);
  }
  function html(strings) {
    let s = strings[0];
    for (let i = 1; i < strings.length; i++) s += out(arguments[i]) + strings[i];
    return new Raw(s);
  }

  // ============================================================
  //  後端呼叫
  // ============================================================
  let busyTimer = null;
  function setBusy(on, text) {
    clearTimeout(busyTimer);
    if (on) {
      $busyText.textContent = text || '處理中…';
      busyTimer = setTimeout(function () { $busy.hidden = false; }, 200);
    } else {
      $busy.hidden = true;
    }
  }

  async function api(action, payload, opts) {
    opts = opts || {};
    const body = Object.assign({ action: action }, payload || {});
    if (action.indexOf('admin') === 0) body.adminToken = state.adminToken || '';
    else if (state.token) body.token = state.token;
    if (!opts.quiet) setBusy(true, opts.busyText);
    try {
      const res = await window.Api.call(body);
      if (!res || !res.ok) {
        const err = new Error((res && res.error) || '伺服器沒有回應，請稍後再試');
        err.code = res && res.code;
        throw err;
      }
      return res;
    } finally {
      if (!opts.quiet) setBusy(false);
    }
  }

  function setToken(t) {
    state.token = t;
    store.set('token', t);
  }

  function applyDash(d) {
    state.dash = d;
    state.config = d.config;
    state.lastLoad = Date.now();
  }

  async function memberAction(action, payload, opts) {
    const res = await api(action, payload, opts);
    applyDash(res.dashboard);
    render();
    toast(res.message || '完成', 'ok');
    return res;
  }

  async function adminAction(action, payload) {
    const res = await api(action, payload);
    state.admin = res.data;
    state.config = res.data.config;
    render();
    if (res.message) toast(res.message, 'ok');
    return res;
  }

  async function refreshDashboard(quiet) {
    const res = await api('dashboard', {}, { quiet: quiet });
    applyDash(res.dashboard);
    render();
  }

  // ============================================================
  //  小工具
  // ============================================================
  function cfg() { return state.config || {}; }

  function genderText(g) {
    if (g === '女') return '♀ 女';
    if (g === '男') return '♂ 男';
    return g || '未填';
  }

  function legText(leg) {
    if (!leg) return '未分配棒次';
    if (leg === '候補') return '候補';
    return '第' + leg + '棒';
  }

  function shortTime(s) {
    const m = /^\d{4}-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(s || '');
    return m ? Number(m[1]) + '/' + Number(m[2]) + ' ' + m[3] + ':' + m[4] : '';
  }

  function field(label, control, hint, opts) {
    opts = opts || {};
    return html`<label class="field">
      <span class="label">${label}${opts.optional ? html` <em>選填</em>` : ''}</span>
      ${control}
      ${hint ? html`<small class="hint">${hint}</small>` : ''}
    </label>`;
  }

  function genderField(value) {
    return html`<fieldset class="field">
      <legend class="label">性別</legend>
      <div class="radio-row">
        ${cfg().genders.map(function (g) {
          return html`<label class="pill-radio"><input type="radio" name="gender" value="${g}" ${g === value ? 'checked' : ''}><span>${genderText(g)}</span></label>`;
        })}
      </div>
      <small class="hint">依 2026 年規定，第一棒必須是女性，所以組隊時需要知道性別。</small>
    </fieldset>`;
  }

  function phase2Fields(values) {
    values = values || {};
    return html`<fieldset class="phase2">
      <legend>📋 第二階段資料</legend>
      ${cfg().phase2Fields.map(function (f) {
        const v = values[f.key] || '';
        if (f.type === 'multi') {
          const chosen = v ? v.split(',') : [];
          return html`<fieldset class="field">
            <legend class="label">${f.label}${f.required ? '' : html` <em>選填</em>`}</legend>
            <div class="check-grid">
              ${f.options.map(function (o) {
                return html`<label class="pill-check"><input type="checkbox" name="p2_${f.key}" value="${o.value}" ${chosen.indexOf(o.value) >= 0 ? 'checked' : ''}><span>${o.label}</span></label>`;
              })}
            </div>
            ${f.help ? html`<small class="hint">${f.help}</small>` : ''}
          </fieldset>`;
        }
        return field(f.label, html`<select name="p2_${f.key}">
            <option value="">請選擇</option>
            ${f.options.map(function (o) { return html`<option value="${o.value}" ${o.value === v ? 'selected' : ''}>${o.label}</option>`; })}
          </select>`, f.help, { optional: !f.required });
      })}
    </fieldset>`;
  }

  function readPhase2(form) {
    const o = {};
    cfg().phase2Fields.forEach(function (f) {
      if (f.type === 'multi') {
        o[f.key] = Array.prototype.map.call(form.querySelectorAll('input[name="p2_' + f.key + '"]:checked'), function (i) { return i.value; });
      } else {
        const el = form.querySelector('[name="p2_' + f.key + '"]');
        o[f.key] = el ? el.value : '';
      }
    });
    return o;
  }

  /** 第二階段資料的一行摘要。all = true 時顯示全部（隊友），否則只顯示公開欄位。 */
  function phase2Summary(m, all) {
    if (!cfg().phase2Open) return '';
    const parts = [];
    cfg().phase2Fields.forEach(function (f) {
      if (!all && !f.share) return;
      const v = m[f.key];
      if (!v) return;
      if (f.key === 'legPrefs') {
        parts.push('想跑 ' + v.split(',').map(function (x) { return x === '都可以' ? '都可以' : '第' + x + '棒'; }).join('、'));
      } else if (f.key === 'adult') {
        parts.push(v === '是' ? '已滿 18 歲' : '未滿 18 歲');
      } else if (f.key === 'distance') {
        parts.push('可跑 ' + v);
      } else if (f.key === 'pace') {
        parts.push('配速 ' + v);
      } else if (f.key === 'substitute') {
        parts.push(v === '願意' ? '願意當候補' : '不當候補');
      } else if (f.key === 'volunteerCaptain') {
        parts.push(v === '願意' ? '願意代表報名' : '');
      } else if (f.key === 'shirt') {
        parts.push('跑衣 ' + v);
      } else {
        parts.push(v);
      }
    });
    return parts.filter(Boolean).join('・');
  }

  function consentBlock() {
    const c = cfg();
    const shared = c.phase2Open ? c.phase2Fields.filter(function (f) { return f.share; }).map(function (f) { return f.label.replace(/（.*?）/g, ''); }) : [];
    return html`<div class="consent">
      <details>
        <summary>個人資料蒐集告知事項（點開閱讀）</summary>
        <ul>
          <li><b>蒐集者：</b>本組隊群組的管理員（跑友自發，<b>不是</b>新北市政府或賽事主辦單位）。</li>
          <li><b>目的：</b>2027 追火車（新北市鐵道馬拉松接力賽）的組隊媒合與聯繫。</li>
          <li><b>資料：</b>姓名、手機、LINE ID、性別、生日月日（只用來查詢驗證，以不可還原的雜湊保存，管理員也看不到）、希望同組的人${c.phase2Open ? '，以及第二階段填寫的資料' : ''}。</li>
          <li><b>誰看得到：</b>姓名、性別、所屬隊伍${shared.length ? '、' + shared.join('、') : ''}會顯示給已報名的人；LINE ID 只有同隊隊友看得到；手機只有管理員看得到。</li>
          <li><b>保存期限：</b>${c.retention}。</li>
          <li><b>你的權利：</b>可以隨時請管理員查詢、更正或刪除你的資料。不提供資料就無法使用媒合功能。</li>
        </ul>
      </details>
      <label class="check"><input type="checkbox" name="consent"> 我已閱讀並同意個人資料蒐集告知事項</label>
    </div>`;
  }

  function lineCard(url) {
    if (!url) {
      return html`<section class="card line-card">
        <h3>💬 LINE 群組</h3>
        <p class="muted">群組連結準備中，管理員設定好之後會顯示在這裡。</p>
      </section>`;
    }
    return html`<section class="card line-card">
      <h3>💬 加入 LINE 群組</h3>
      <p>組隊討論、最新公告都在群組裡。</p>
      <a class="btn line big" href="${url}" target="_blank" rel="noopener">加入 LINE 群組</a>
      <details class="qr-box">
        <summary>用電腦開的話：用手機掃 QR code</summary>
        <div class="qr" data-qr="${url}"></div>
      </details>
    </section>`;
  }

  function meter(t) {
    const pct = Math.min(100, Math.round(t.size / t.capacity * 100));
    const officialPct = Math.round(t.official / t.capacity * 100);
    const official = Math.min(t.size, t.official);
    const subs = Math.max(t.size - t.official, 0);
    return html`<div class="meter">
      <div class="meter-bar" role="img" aria-label="目前 ${t.size} 人，上限 ${t.capacity} 人">
        <span style="width:${pct}%"></span><i style="left:${officialPct}%"></i>
      </div>
      <div class="meter-text">
        <span><b>${t.size}</b> / ${t.capacity} 人 <span class="muted">（正式 ${official}/${t.official}・候補 ${subs}/${t.sub}）</span></span>
        ${t.full ? html`<span class="tag full">🈵 已額滿</span>` : html`<span class="tag">還有 ${t.spots} 個位置</span>`}
      </div>
    </div>`;
  }

  const RECRUIT = {
    '需隊長同意': { icon: '✋', cls: 'ask', hint: '別人申請後，要隊長同意才會加入（建議）' },
    '開放直接加入': { icon: '🟢', cls: 'open', hint: '任何已報名的人按「加入」就直接入隊' },
    '暫停招募': { icon: '⏸️', cls: 'closed', hint: '不接受申請，邀請連結也暫時不能用' },
  };
  function recruitBadge(mode) {
    const r = RECRUIT[mode] || { icon: '', cls: '' };
    return html`<span class="tag recruit ${r.cls}">${r.icon} ${mode}</span>`;
  }

  const STATUS = { '待回覆': ['⏳', 'pending'], '已同意': ['✅', 'ok'], '已婉拒': ['✖️', 'no'], '已取消': ['↩️', 'no'], '已失效': ['⚠️', 'warn'] };
  function statusBadge(s) {
    const x = STATUS[s] || ['', ''];
    return html`<span class="tag status ${x[1]}">${x[0]} ${s}</span>`;
  }

  function inviteLink(code) {
    return location.origin + location.pathname + '?join=' + encodeURIComponent(code);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) { /* LINE 內建瀏覽器可能不支援，改用舊方法 */ }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }

  function normalizePhone(v) {
    let s = String(v || '').replace(/[\s\-()]/g, '');
    if (s.indexOf('+886') === 0) s = '0' + s.slice(4);
    else if (/^886\d{9}$/.test(s)) s = '0' + s.slice(3);
    return s;
  }

  function birthdayError(v) {
    const days = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    const mm = Number(String(v).slice(0, 2));
    const dd = Number(String(v).slice(2, 4));
    if (!/^\d{4}$/.test(v) || mm < 1 || mm > 12 || dd < 1 || dd > days[mm - 1]) {
      return '生日請輸入 4 位數字（月月日日），例如 7 月 31 日請輸入 0731';
    }
    return '';
  }

  function val(form, name) {
    const el = form.querySelector('[name="' + name + '"]');
    if (!el) return '';
    if (el.type === 'checkbox') return el.checked;
    return el.value;
  }

  function radio(form, name) {
    const el = form.querySelector('input[name="' + name + '"]:checked');
    return el ? el.value : '';
  }

  function showFormError(form, msg) {
    const el = form.querySelector('.form-error');
    if (el) {
      el.textContent = '⚠️ ' + msg;
      el.hidden = false;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    toast(msg, 'error');
  }

  // ============================================================
  //  版面
  // ============================================================
  function render() {
    let body;
    switch (state.view) {
      case 'fatal': body = viewFatal(); break;
      case 'landing': body = viewLanding(); break;
      case 'register': body = viewRegister(); break;
      case 'login': body = viewLogin(); break;
      case 'welcome': body = viewWelcome(); break;
      case 'dashboard': body = viewDashboard(); break;
      case 'admin': body = viewAdmin(); break;
      default: body = html`<p class="loading-text">載入中…</p>`;
    }
    $app.innerHTML = html`${viewHeader()}${localBanner()}<main>${body}</main>${viewFooter()}`.s;
    state.dirty = false;
    if (state.view !== state.prevView || (state.view === 'dashboard' && state.tab !== state.prevTab)) window.scrollTo(0, 0);
    state.prevView = state.view;
    state.prevTab = state.tab;
    renderQrs();
    if (state.view === 'admin') applyAdminFilter();
  }

  function viewHeader() {
    const c = cfg();
    const d = state.dash;
    const who = (state.view === 'dashboard' || state.view === 'welcome') && d
      ? html`<div class="who"><span>👤 ${d.me.name}</span><button class="link light" data-act="logout">登出</button></div>`
      : (state.view === 'admin' && state.admin ? html`<div class="who"><span>🛠️ 管理員</span><button class="link light" data-act="adminLogout">登出</button></div>` : '');
    // 標題字樣只在第一次顯示時播放動畫，之後畫面更新不再重播
    const animate = !state.brandShown;
    state.brandShown = true;
    return html`<header class="top">
      <button class="brand ${animate ? 'animate' : ''}" data-act="home" aria-label="2027 山貓追火車 GOGOGO，回首頁">
        <img class="logo" src="img/lynx.svg?v=1.1.1" alt="" width="52" height="52">
        <span class="wordmark" aria-hidden="true">
          <span class="wm-top"><span class="wm-year">2027</span><span class="wm-name">山貓追火車</span></span>
          <span class="wm-go"><b>GO</b><b>GO</b><b>GO</b></span>
          <span class="sub">跑友自發組隊・非官方報名網站</span>
        </span>
      </button>
      ${who}
    </header>
    ${c.announcement && state.view !== 'admin' ? html`<div class="announce" role="note">📢 ${c.announcement}</div>` : ''}`;
  }

  function localBanner() {
    if (!window.Api.isLocal) return '';
    const pw = window.LocalBackend ? window.LocalBackend.adminPassword : 'admin1234';
    return html`<div class="local-banner">
      <b>🧪 本機模擬模式</b>：資料只存在這台電腦的瀏覽器，不會送到 Google。
      <div class="local-actions">
        <button class="btn small" data-act="seedDemo">產生示範資料</button>
        <button class="btn small" data-act="resetLocal">清除模擬資料</button>
      </div>
      <details><summary>示範帳號</summary>電話 0900000001～0900000012，生日都是 0101；管理頁：網址後面加 #admin，密碼 ${pw}</details>
    </div>`;
  }

  function viewFooter() {
    return html`<footer class="foot">
      <p>本站是跑友自發的組隊工具，與新北市政府觀光旅遊局及賽事主辦單位無關。正式報名、規則與費用請以官方公告為準。</p>
      <p><a href="#admin" class="muted">管理頁</a></p>
    </footer>`;
  }

  function viewFatal() {
    return html`<section class="card">
      <h2>😵 目前無法連線</h2>
      <p>${state.fatal}</p>
      <button class="btn primary" data-act="reload">重新整理</button>
    </section>`;
  }

  function inviteNotice() {
    if (!state.invite) return '';
    if (state.inviteError) {
      return html`<div class="notice warn">⚠️ 這個邀請連結有問題：${state.inviteError}。還是可以先報名，之後再找隊伍。</div>`;
    }
    const i = state.inviteInfo;
    if (!i) return '';
    return html`<div class="notice invite">🎟️ 你收到「<b>${i.teamName}</b>」的邀請（目前 ${i.size}/${i.capacity} 人${i.full ? '，已額滿' : ''}）。<br>
      第一次來請按「第一次報名」，送出後會直接加入；已經報名過的話，請按「我已報名」登入後加入。</div>`;
  }

  function viewLanding() {
    const c = cfg();
    return html`
    <section class="hero card">
      <img class="hero-art" src="img/hero.svg?v=1.1.1" alt="山貓追著火車在海邊奔跑的插圖" width="360" height="160">
      <h2>山貓們，一起追火車！</h2>
      <p>在這裡登記、找隊友。等官方報名開放時，各隊隊長就能拿著名單直接去報名。</p>
      ${inviteNotice()}
      <div class="stack">
        ${c.registrationOpen
          ? html`<button class="btn primary big" data-act="go" data-view="register">📝 第一次報名</button>`
          : html`<button class="btn big" disabled>📝 目前暫停新報名</button>`}
        <button class="btn big" data-act="go" data-view="login">🔎 我已報名，查詢／登入</button>
      </div>
    </section>
    <section class="card">
      <h3>怎麼組隊？</h3>
      <ol class="how">
        <li><b>🚩 已經約好朋友：</b>一個人建立隊伍當隊長，把邀請連結傳給朋友，朋友點連結報名就會直接入隊。</li>
        <li><b>🔍 想加入別人：</b>報名後看「所有隊伍」，申請加入有空位的隊伍，隊長同意就入隊。</li>
        <li><b>🤝 人數不夠：</b>你們隊可以「整隊申請併入」別隊，一起移過去，朋友不會被拆散。</li>
        <li><b>⏳ 還沒想法：</b>先待安排就好，隊長可以邀請你，管理員也會協助安排。</li>
      </ol>
    </section>
    <section class="card muted-card">
      <h3>2026 年的規定（僅供參考）</h3>
      <ul>
        <li>每隊 ${c.capacity ? c.capacity.official : 7} 位正式隊員＋${c.capacity ? c.capacity.sub : 2} 位候補，全程約 51 公里、共 7 棒</li>
        <li>所有組別的第一棒必須是女性</li>
        <li>須年滿 12 歲；12–18 歲需要家長同意書</li>
        <li>組別：競賽組、企業團體競賽組、變裝組</li>
      </ul>
      <p class="small">2027 年的規定以官方公告為準，公布後這裡會更新。</p>
    </section>`;
  }

  function viewRegister() {
    const c = cfg();
    if (!c.registrationOpen) {
      return html`<section class="card"><h2>目前暫停新報名</h2><p>${c.adminContact}</p>
        <button class="btn" data-act="go" data-view="landing">回首頁</button></section>`;
    }
    return html`<section class="card">
      <button class="link back" data-act="go" data-view="landing">← 回首頁</button>
      <h2>📝 第一次報名</h2>
      ${inviteNotice()}
      <form data-form="register" novalidate>
        ${field('姓名', html`<input name="name" maxlength="20" autocomplete="name" required>`, '請填真實姓名，之後正式報名會用到。')}
        ${field('手機號碼', html`<input name="phone" type="tel" inputmode="numeric" autocomplete="tel" placeholder="0912345678" maxlength="16" required>`, '之後用手機號碼查詢你的報名資料。')}
        ${field('生日（月日 4 碼）', html`<input name="birthday" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="4" placeholder="0731" autocomplete="off" required>`, '例如 7 月 31 日填 0731。查詢時當作密碼使用，請記住。')}
        ${field('LINE ID', html`<input name="lineId" maxlength="30" autocomplete="off" autocapitalize="off" spellcheck="false" required>`, '方便隊友聯絡你，只有同隊隊友看得到。LINE「主頁 → 設定（齒輪）→ 個人檔案 → ID」可以查到。')}
        ${genderField('')}
        ${field('希望同組的人', html`<textarea name="wish" maxlength="100" rows="2" placeholder="例如：已經約好小明、小華"></textarea>`, '寫朋友的名字就好，方便管理員安排。請不要填別人的電話。', { optional: true })}
        ${c.phase2Open ? phase2Fields({}) : ''}
        ${consentBlock()}
        <p class="form-error" role="alert" hidden></p>
        <button class="btn primary big" type="submit">送出報名</button>
      </form>
    </section>`;
  }

  function viewLogin() {
    const c = cfg();
    return html`<section class="card narrow">
      <button class="link back" data-act="go" data-view="landing">← 回首頁</button>
      <h2>🔎 查詢／登入</h2>
      ${inviteNotice()}
      <form data-form="login" novalidate>
        ${field('手機號碼', html`<input name="phone" type="tel" inputmode="numeric" autocomplete="tel" placeholder="0912345678" maxlength="16" required>`)}
        ${field('生日（月日 4 碼）', html`<input name="birthday" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" placeholder="0731" autocomplete="off" required>`, '報名時填的生日，例如 7 月 31 日是 0731。')}
        <p class="form-error" role="alert" hidden></p>
        <button class="btn primary big" type="submit">查詢</button>
      </form>
      <p class="small muted">忘記當初填的生日？${c.adminContact}</p>
      ${c.registrationOpen ? html`<p class="small">還沒報名？<button class="link" data-act="go" data-view="register">第一次報名</button></p>` : ''}
    </section>`;
  }

  function viewWelcome() {
    const d = state.dash;
    return html`
    <section class="card success">
      <h2>🎉 ${state.welcome || '報名完成！'}</h2>
      <p>之後用 <b>手機號碼＋生日 4 碼</b> 就能查詢與修改資料。</p>
    </section>
    ${lineCard(d.lineGroupUrl)}
    <section class="card">
      <h3>下一步：組隊</h3>
      <p>${d.myTeam ? '你已經在「' + d.myTeam.name + '」了，去看看隊友吧！' : '可以自己建立隊伍、加入朋友的隊伍，或先待安排。'}</p>
      <button class="btn primary big" data-act="tab" data-tab="team">前往組隊 →</button>
    </section>`;
  }

  // ============================================================
  //  登入後：分頁
  // ============================================================
  function viewDashboard() {
    const d = state.dash;
    const c = cfg();
    const toAnswer = d.requests.incoming.filter(function (r) { return r.canRespond; }).length;
    const tabs = [
      ['team', '🏃', '我的隊伍', toAnswer ? html`<span class="dot" aria-label="${toAnswer} 個待回覆">${toAnswer}</span>` : ''],
      ['teams', '🚩', '所有隊伍', html`<span class="count">${d.teams.length}</span>`],
      ['pool', '⏳', '待安排', html`<span class="count">${d.pool.length}</span>`],
      ['profile', '👤', '我的資料', ''],
    ];
    let content;
    if (state.tab === 'teams') content = tabTeams(d);
    else if (state.tab === 'pool') content = tabPool(d);
    else if (state.tab === 'profile') content = tabProfile(d);
    else content = tabTeam(d);
    return html`
    <nav class="tabs" aria-label="分頁">
      ${tabs.map(function (t) {
        const active = state.tab === t[0] || (t[0] === 'team' && ['teams', 'pool', 'profile'].indexOf(state.tab) < 0);
        return html`<button class="tab ${active ? 'active' : ''}" data-act="tab" data-tab="${t[0]}" ${active ? 'aria-current="page"' : ''}>
          <span class="tab-icon" aria-hidden="true">${t[1]}</span><span class="tab-label">${t[2]}</span>${t[3]}
        </button>`;
      })}
    </nav>
    ${c.teamsLocked ? html`<div class="notice lock">🔒 隊伍已鎖定（準備正式報名中），不能自行建隊、加入或離開。需要調整請：${c.adminContact}</div>` : ''}
    ${c.phase2Open && !d.me.phase2.adult ? html`<div class="notice info">📋 第二階段資料開放填寫了！<button class="link" data-act="tab" data-tab="profile">到「我的資料」補填 →</button></div>` : ''}
    ${content}
    <div class="refresh-row"><span class="muted small">資料時間 ${shortTime(d.serverTime)}</span><button class="link" data-act="refresh">🔄 重新整理</button></div>`;
  }

  // ---------- 我的隊伍 ----------
  function tabTeam(d) {
    if (!d.myTeam) return tabNoTeam(d);
    const c = cfg();
    const t = d.myTeam;
    const link = inviteLink(t.inviteCode);
    const shareText = '2027 山貓追火車 GOGOGO！點這個連結報名，就會加入「' + t.name + '」：' + link;
    const incoming = d.requests.incoming;
    const outgoing = d.requests.outgoing;
    return html`
    ${inviteNoticeLoggedIn(d)}
    <section class="card team-main">
      <div class="team-head">
        <h2>🚩 ${t.name}</h2>
        ${d.isCaptain ? html`<span class="tag captain">👑 你是隊長</span>` : html`<span class="tag">隊員</span>`}
      </div>
      ${t.intro ? html`<p class="intro">${t.intro}</p>` : ''}
      ${meter(t)}
      <div class="tags">${recruitBadge(t.recruit)}<span class="tag">♀ 女性 ${t.femaleCount} 人</span></div>
      ${t.warnings.length ? html`<ul class="warnings">${t.warnings.map(function (w) { return html`<li>⚠️ ${w}</li>`; })}</ul>` : html`<p class="ok-text">✅ 人數與基本條件都齊了</p>`}
    </section>

    ${incoming.length ? html`<section class="card">
      <h3>📥 收到的申請</h3>
      ${!d.isCaptain ? html`<p class="small muted">只有隊長可以同意或婉拒。</p>` : ''}
      <ul class="req-list">${incoming.map(function (r) { return requestItem(r, true); })}</ul>
    </section>` : ''}

    ${t.recruit !== '暫停招募' && !t.full ? html`<section class="card invite-card">
      <h3>🔗 邀請朋友</h3>
      <p>朋友點這個連結報名（或登入），就會<b>直接加入</b>你們隊，不用審核。請只傳給認識的人。</p>
      <div class="copy-row"><input readonly value="${link}" aria-label="邀請連結"><button class="btn" data-act="copy" data-text="${link}">複製</button></div>
      <div class="stack-row">
        <a class="btn line" href="https://line.me/R/share?text=${encodeURIComponent(shareText)}" target="_blank" rel="noopener">用 LINE 傳給朋友</a>
        <span class="small muted">邀請碼：<b class="mono">${t.inviteCode}</b></span>
      </div>
    </section>` : ''}

    ${outgoing.length ? html`<section class="card">
      <h3>📤 送出的申請與邀請</h3>
      <ul class="req-list">${outgoing.map(function (r) { return requestItem(r, false); })}</ul>
    </section>` : ''}

    ${c.phase2Open ? legTable(t) : ''}

    <section class="card">
      <h3>👥 隊員（${t.size} 人）</h3>
      <ul class="member-list">${t.members.map(function (m) { return teammateItem(m, d); })}</ul>
      ${d.isCaptain ? html`<p class="small muted">想找更多人？到「⏳ 待安排」邀請還沒有隊伍的人，或到「🚩 所有隊伍」整隊申請併入別隊。</p>` : ''}
    </section>

    ${d.isCaptain ? teamEditor(t) : ''}

    <section class="card danger-zone">
      <button class="btn danger-outline" data-act="leaveTeam" ${c.teamsLocked ? 'disabled' : ''}>離開隊伍</button>
      <p class="small muted">${d.isCaptain ? (t.size > 1 ? '你是隊長，離開後隊長會交給最早入隊的隊員。' : '你是最後一位隊員，離開後隊伍會解散。') : '離開後你會回到待安排區。'}</p>
    </section>`;
  }

  function inviteNoticeLoggedIn(d) {
    if (!state.invite) return '';
    if (state.inviteError) {
      return html`<div class="notice warn">⚠️ 邀請連結有問題：${state.inviteError} <button class="link" data-act="dismissInvite">知道了</button></div>`;
    }
    const i = state.inviteInfo;
    if (!i) return '';
    if (d.myTeam) {
      if (d.myTeam.name === i.teamName) return '';
      return html`<div class="notice warn">🎟️ 你收到「${i.teamName}」的邀請連結，但你已經在「${d.myTeam.name}」。要換隊請先離開目前的隊伍。
        <button class="link" data-act="dismissInvite">知道了</button></div>`;
    }
    return html`<section class="card notice-card invite">
      <h3>🎟️ 你收到「${i.teamName}」的邀請</h3>
      <p>目前 ${i.size}/${i.capacity} 人${i.full ? '，已經額滿' : ''}。</p>
      <div class="stack-row">
        <button class="btn primary" data-act="joinInvite" ${i.full ? 'disabled' : ''}>加入「${i.teamName}」</button>
        <button class="btn" data-act="dismissInvite">先不要</button>
      </div>
    </section>`;
  }

  function tabNoTeam(d) {
    const c = cfg();
    const invitations = d.requests.incoming;
    const mine = d.requests.outgoing;
    const locked = c.teamsLocked;
    return html`
    ${inviteNoticeLoggedIn(d)}
    <section class="card status-card">
      <h2>⏳ 你目前在「待安排區」</h2>
      <p>隊長們可以在「待安排」看到你、邀請你加入，管理員也會協助安排。你也可以自己選下面的方式組隊。</p>
    </section>

    ${invitations.length ? html`<section class="card">
      <h3>📥 收到的邀請</h3>
      <ul class="req-list">${invitations.map(function (r) { return requestItem(r, true); })}</ul>
    </section>` : ''}

    ${mine.length ? html`<section class="card">
      <h3>📤 我送出的申請</h3>
      <ul class="req-list">${mine.map(function (r) { return requestItem(r, false); })}</ul>
    </section>` : ''}

    <section class="card">
      <h3>選一種方式組隊</h3>
      <div class="options">
        <details class="option" ${locked ? '' : 'open'}>
          <summary><span class="opt-icon">🚩</span><span><b>我來建隊（當隊長）</b><small>已經約好朋友？建好隊伍後把邀請連結傳給他們。</small></span></summary>
          <form data-form="createTeam" novalidate class="opt-body">
            ${field('隊名', html`<input name="teamName" maxlength="16" required placeholder="例如：福隆衝衝衝">`, '中文 8 個字或英文 16 個字母以內（2026 官方規定）。')}
            ${recruitField('需隊長同意')}
            ${field('隊伍介紹', html`<textarea name="intro" maxlength="100" rows="2" placeholder="例如：輕鬆跑、享受山海線，歡迎新手"></textarea>`, '', { optional: true })}
            <p class="form-error" role="alert" hidden></p>
            <button class="btn primary" type="submit" ${locked ? 'disabled' : ''}>建立隊伍</button>
          </form>
        </details>
        <details class="option">
          <summary><span class="opt-icon">🔗</span><span><b>我有邀請碼</b><small>朋友已經建好隊伍，輸入 6 碼邀請碼直接加入。</small></span></summary>
          <form data-form="joinCode" novalidate class="opt-body">
            ${field('邀請碼', html`<input name="code" maxlength="10" autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="例如 K7P2QX" class="mono">`)}
            <p class="form-error" role="alert" hidden></p>
            <button class="btn primary" type="submit" ${locked ? 'disabled' : ''}>加入</button>
          </form>
        </details>
        <button class="option as-button" data-act="tab" data-tab="teams">
          <span class="opt-icon">🔍</span><span><b>瀏覽招募中的隊伍</b><small>找一隊申請加入，隊長同意後入隊。</small></span><span class="chev" aria-hidden="true">›</span>
        </button>
        <div class="option static">
          <span class="opt-icon">⏳</span><span><b>先待安排</b><small>什麼都不用做，你已經在待安排區了。</small></span>
        </div>
      </div>
    </section>`;
  }

  function recruitField(value) {
    return html`<fieldset class="field">
      <legend class="label">招募方式</legend>
      <div class="radio-col">
        ${cfg().recruitModes.map(function (m) {
          const r = RECRUIT[m] || {};
          return html`<label class="radio-card"><input type="radio" name="recruit" value="${m}" ${m === value ? 'checked' : ''}>
            <span><b>${r.icon} ${m}</b><small>${r.hint}</small></span></label>`;
        })}
      </div>
    </fieldset>`;
  }

  function teamEditor(t) {
    return html`<details class="card editor">
      <summary>⚙️ 修改隊伍資料（隊長）</summary>
      <form data-form="updateTeam" novalidate>
        ${field('隊名', html`<input name="teamName" maxlength="16" value="${t.name}" required>`, '中文 8 個字或英文 16 個字母以內。')}
        ${recruitField(t.recruit)}
        ${field('隊伍介紹', html`<textarea name="intro" maxlength="100" rows="2">${t.intro}</textarea>`, '', { optional: true })}
        <p class="form-error" role="alert" hidden></p>
        <button class="btn primary" type="submit">儲存</button>
      </form>
      <hr>
      <p class="small muted">邀請連結不小心傳給不認識的人？可以重新產生，舊的連結就不能再用。</p>
      <button class="btn" data-act="regenerateInvite">🔄 重新產生邀請連結</button>
    </details>`;
  }

  function teammateItem(m, d) {
    const c = cfg();
    const captain = d.isCaptain;
    return html`<li class="member ${m.isMe ? 'me' : ''}">
      <div class="m-top">
        <span class="m-name">${m.name}${m.isMe ? '（你）' : ''}</span>
        ${m.role === '隊長' ? html`<span class="tag captain">👑 隊長</span>` : ''}
        <span class="tag">${genderText(m.gender)}</span>
        ${c.phase2Open ? html`<span class="tag leg">${legText(m.leg)}</span>` : ''}
      </div>
      <div class="m-line">LINE ID：<b class="mono">${m.lineId}</b> <button class="link small" data-act="copy" data-text="${m.lineId}">複製</button></div>
      ${c.phase2Open && phase2Summary(m, true) ? html`<div class="m-sub">${phase2Summary(m, true)}</div>` : ''}
      ${captain && c.phase2Open ? html`<label class="inline-field">棒次
        <select data-change="assignLeg" data-member="${m.id}">${legOptions(m.leg, m.gender)}</select></label>` : ''}
      ${captain && !m.isMe ? html`<div class="m-actions">
        <button class="btn small" data-act="transferCaptain" data-id="${m.id}" data-name="${m.name}">👑 交接隊長</button>
        <button class="btn small danger-outline" data-act="removeMember" data-id="${m.id}" data-name="${m.name}" ${c.teamsLocked ? 'disabled' : ''}>移出隊伍</button>
      </div>` : ''}
    </li>`;
  }

  function legOptions(current, gender) {
    const c = cfg();
    const opts = [html`<option value="" ${!current ? 'selected' : ''}>未分配</option>`];
    c.legs.forEach(function (l) {
      const blocked = l.femaleOnly && gender !== '女';
      opts.push(html`<option value="${l.no}" ${String(l.no) === current ? 'selected' : ''} ${blocked ? 'disabled' : ''}>第${l.no}棒 ${l.km.toFixed(1)}K${l.femaleOnly ? '（限女性）' : ''}</option>`);
    });
    opts.push(html`<option value="${c.legSub}" ${current === c.legSub ? 'selected' : ''}>候補</option>`);
    return opts;
  }

  function legTable(t) {
    const c = cfg();
    const byLeg = {};
    t.members.forEach(function (m) { if (m.leg) (byLeg[m.leg] = byLeg[m.leg] || []).push(m); });
    const subs = byLeg[c.legSub] || [];
    return html`<section class="card">
      <h3>🗺️ 棒次表</h3>
      <ol class="legs">
        ${c.legs.map(function (l) {
          const m = (byLeg[String(l.no)] || [])[0];
          return html`<li class="${m ? 'filled' : 'empty'}">
            <span class="leg-no">${l.no}</span>
            <span class="leg-info"><b>${l.title}・${l.km.toFixed(1)}K</b>${l.femaleOnly ? html` <span class="tag female">限女性</span>` : ''}<small>${l.route}</small></span>
            <span class="leg-who">${m ? html`✅ ${m.name}` : html`<span class="muted">○ 未分配</span>`}</span>
          </li>`;
        })}
        <li class="${subs.length ? 'filled' : 'empty'}">
          <span class="leg-no">補</span>
          <span class="leg-info"><b>候補</b><small>最多 ${t.sub} 人</small></span>
          <span class="leg-who">${subs.length ? subs.map(function (m) { return m.name; }).join('、') : html`<span class="muted">—</span>`}</span>
        </li>
      </ol>
      <p class="small muted">棒次與距離為 2026 年資料，2027 年以官方公告為準。${t.members.length && state.dash.isCaptain ? '隊長可以在下方隊員清單分配棒次。' : ''}</p>
    </section>`;
  }

  function requestItem(r, incoming) {
    let title;
    if (r.type === '加入') {
      title = incoming ? html`<b>${r.fromMember ? r.fromMember.name : '（已刪除）'}</b> 想加入你們隊` : html`申請加入「<b>${r.toTeam ? r.toTeam.name : '已解散的隊伍'}</b>」`;
    } else if (r.type === '併隊') {
      title = incoming
        ? html`「<b>${r.fromTeam ? r.fromTeam.name : '已解散的隊伍'}</b>」${r.fromTeam && r.status === '待回覆' ? '（' + r.fromTeam.size + ' 人）' : ''}想整隊併入你們隊`
        : html`整隊申請併入「<b>${r.toTeam ? r.toTeam.name : '已解散的隊伍'}</b>」`;
    } else {
      title = incoming ? html`「<b>${r.fromTeam ? r.fromTeam.name : '已解散的隊伍'}</b>」邀請你加入` : html`邀請 <b>${r.toMember ? r.toMember.name : '（已刪除）'}</b> 加入`;
    }
    let detail = '';
    if (incoming && r.type === '加入' && r.fromMember) {
      detail = html`<div class="small muted">${genderText(r.fromMember.gender)}${phase2Summary(r.fromMember, false) ? '・' + phase2Summary(r.fromMember, false) : ''}</div>`;
    }
    if (r.type === '併隊' && r.fromTeam && r.status === '待回覆') {
      detail = html`<div class="small muted">成員：${r.fromTeam.members.map(function (m) { return m.name + '（' + m.gender + '）'; }).join('、')}</div>`;
    }
    if (incoming && r.type === '邀請' && r.fromMember) {
      detail = html`<div class="small muted">隊長：${r.fromMember.name}</div>`;
    }
    return html`<li class="req ${r.status === '待回覆' ? 'pending' : 'done'}">
      <div class="req-top"><span>${title}</span>${statusBadge(r.status)}</div>
      ${detail}
      ${r.message ? html`<div class="req-msg">💬 ${r.message}</div>` : ''}
      ${r.note ? html`<div class="small muted">說明：${r.note}</div>` : ''}
      <div class="small muted">${shortTime(r.createdAt)} 送出${r.decidedAt ? '・' + shortTime(r.decidedAt) + ' 處理' : ''}</div>
      ${r.canRespond || r.canCancel ? html`<div class="req-actions">
        ${r.canRespond ? html`<button class="btn small primary" data-act="respond" data-id="${r.id}" data-accept="1" data-type="${r.type}">同意</button>
          <button class="btn small" data-act="respond" data-id="${r.id}" data-accept="0" data-type="${r.type}">婉拒</button>` : ''}
        ${r.canCancel ? html`<button class="btn small" data-act="cancelRequest" data-id="${r.id}">取消${r.type === '邀請' ? '邀請' : '申請'}</button>` : ''}
      </div>` : ''}
    </li>`;
  }

  // ---------- 所有隊伍 ----------
  function tabTeams(d) {
    const c = cfg();
    let list = d.teams.slice();
    if (state.teamsFilter === 'open') {
      list = list.filter(function (t) { return t.isMine || t.inviteRequestId || t.myRequestId || (!t.full && t.recruit !== '暫停招募'); });
    }
    list.sort(function (a, b) {
      const pa = a.isMine ? 0 : (a.inviteRequestId || a.myRequestId ? 1 : (a.canApply || a.canMerge ? 2 : 3));
      const pb = b.isMine ? 0 : (b.inviteRequestId || b.myRequestId ? 1 : (b.canApply || b.canMerge ? 2 : 3));
      if (pa !== pb) return pa - pb;
      return a.createdAt < b.createdAt ? -1 : 1;
    });
    let hint;
    if (!d.myTeam) hint = '你還沒有隊伍：找一隊按「申請加入」，隊長同意後就會入隊。';
    else if (d.isCaptain) hint = '你是隊長：人數不夠的話，可以「整隊申請併入」別隊，你們隊的人會一起移過去。';
    else hint = '你已經有隊伍了，這裡可以看看其他隊伍的情況。';
    return html`
    <section class="card slim">
      <p>${hint}</p>
      <div class="chips" role="group" aria-label="篩選">
        <button class="chip ${state.teamsFilter === 'open' ? 'active' : ''}" data-act="filter" data-filter="open" aria-pressed="${state.teamsFilter === 'open'}">有空位、招募中</button>
        <button class="chip ${state.teamsFilter === 'all' ? 'active' : ''}" data-act="filter" data-filter="all" aria-pressed="${state.teamsFilter === 'all'}">全部 ${d.teams.length} 隊</button>
      </div>
    </section>
    ${list.length ? list.map(function (t) { return teamCard(t, d); }) : html`<section class="card empty">
      <p>${d.teams.length ? '目前沒有招募中、還有空位的隊伍。' : '還沒有人建立隊伍。'}</p>
      ${!d.myTeam && !c.teamsLocked ? html`<button class="btn primary" data-act="tab" data-tab="team">自己建一隊</button>` : ''}
    </section>`}`;
  }

  function teamCard(t, d) {
    const c = cfg();
    let action = '';
    if (t.isMine) {
      action = html`<button class="btn small" data-act="tab" data-tab="team">查看我的隊伍</button>`;
    } else if (t.inviteRequestId) {
      action = html`<span class="small">🎟️ 這隊邀請了你</span>
        <button class="btn small primary" data-act="respond" data-id="${t.inviteRequestId}" data-accept="1" data-type="邀請">接受邀請</button>
        <button class="btn small" data-act="respond" data-id="${t.inviteRequestId}" data-accept="0" data-type="邀請">婉拒</button>`;
    } else if (t.myRequestId) {
      action = html`<span class="small">⏳ 已申請，等待對方隊長回覆</span>
        <button class="btn small" data-act="cancelRequest" data-id="${t.myRequestId}">取消申請</button>`;
    } else if (t.canApply) {
      action = t.recruit === '開放直接加入'
        ? html`<button class="btn small primary" data-act="applyJoin" data-id="${t.id}" data-name="${t.name}" data-open="1">直接加入</button>`
        : html`<button class="btn small primary" data-act="applyJoin" data-id="${t.id}" data-name="${t.name}">申請加入</button>`;
    } else if (t.canMerge) {
      action = html`<button class="btn small primary" data-act="applyMerge" data-id="${t.id}" data-name="${t.name}">整隊申請併入（你們 ${d.myTeam.size} 人）</button>`;
    } else if (t.mergeTooBig) {
      action = html`<span class="small muted">兩隊合計超過 ${t.capacity} 人，無法併隊</span>`;
    } else if (!d.myTeam || d.isCaptain) {
      if (c.teamsLocked) action = html`<span class="small muted">🔒 隊伍已鎖定</span>`;
      else if (t.full) action = html`<span class="small muted">🈵 已額滿</span>`;
      else if (t.recruit === '暫停招募') action = html`<span class="small muted">⏸️ 暫停招募</span>`;
    }
    return html`<article class="card team-card ${t.isMine ? 'mine' : ''}">
      <div class="team-head">
        <h3>${t.name}</h3>
        ${t.isMine ? html`<span class="tag captain">⭐ 我的隊伍</span>` : ''}
      </div>
      ${meter(t)}
      <div class="tags">${recruitBadge(t.recruit)}<span class="tag">♀ 女性 ${t.femaleCount} 人</span>${c.phase2Open ? html`<span class="tag">已分配 ${t.legsAssigned || 0}/${c.legs.length} 棒</span>` : ''}</div>
      ${t.intro ? html`<p class="intro">${t.intro}</p>` : ''}
      <ul class="names">${t.members.map(function (m) {
        return html`<li>${m.role === '隊長' ? '👑 ' : ''}${m.name}${m.isMe ? '（你）' : ''}<span class="muted">・${m.gender}${m.leg && c.phase2Open ? '・' + legText(m.leg) : ''}</span></li>`;
      })}</ul>
      ${action ? html`<div class="card-actions">${action}</div>` : ''}
    </article>`;
  }

  // ---------- 待安排 ----------
  function tabPool(d) {
    const hint = d.isCaptain
      ? (d.myTeam.full ? '你們隊已經額滿了。' : '你是隊長：可以邀請這些人加入你們隊，對方同意就入隊。')
      : (d.myTeam ? '這些人還沒有隊伍。想找誰一起跑，可以請你們隊長邀請他。' : '這些人跟你一樣還沒有隊伍，可以在 LINE 群組約一約，一起建隊！');
    return html`
    <section class="card slim"><p>${hint}</p></section>
    ${d.pool.length ? html`<ul class="pool-list">${d.pool.map(function (p) {
      let action = '';
      if (d.isCaptain && !p.isMe) {
        if (p.appliedRequestId) {
          action = html`<span class="small">📥 申請了你們隊</span>
            <button class="btn small primary" data-act="respond" data-id="${p.appliedRequestId}" data-accept="1" data-type="加入">同意加入</button>`;
        } else if (p.inviteRequestId) {
          action = html`<span class="small">⏳ 已邀請，等對方回覆</span>
            <button class="btn small" data-act="cancelRequest" data-id="${p.inviteRequestId}">取消邀請</button>`;
        } else if (p.canInvite) {
          action = html`<button class="btn small primary" data-act="invite" data-id="${p.id}" data-name="${p.name}">邀請加入</button>`;
        }
      }
      const summary = phase2Summary(p, false);
      return html`<li class="card pool-item ${p.isMe ? 'me' : ''}">
        <div class="m-top"><span class="m-name">${p.name}${p.isMe ? '（你）' : ''}</span><span class="tag">${genderText(p.gender)}</span></div>
        ${p.wish ? html`<div class="m-sub">💭 希望同組：${p.wish}</div>` : ''}
        ${summary ? html`<div class="m-sub">${summary}</div>` : ''}
        <div class="small muted">${p.since} 登記</div>
        ${action ? html`<div class="card-actions">${action}</div>` : ''}
      </li>`;
    })}</ul>` : html`<section class="card empty"><p>目前沒有待安排的人 🎉</p></section>`}`;
  }

  // ---------- 我的資料 ----------
  function tabProfile(d) {
    const c = cfg();
    const me = d.me;
    return html`
    <section class="card">
      <h2>👤 我的資料</h2>
      <form data-form="profile" novalidate>
        ${field('姓名', html`<input name="name" maxlength="20" value="${me.name}" required>`)}
        ${field('手機號碼', html`<input value="${me.phoneMasked}" disabled>`, '手機號碼是查詢用的帳號，不能自己修改。')}
        ${field('LINE ID', html`<input name="lineId" maxlength="30" value="${me.lineId}" autocapitalize="off" spellcheck="false" required>`, '只有同隊隊友看得到。')}
        ${genderField(me.gender)}
        ${field('希望同組的人', html`<textarea name="wish" maxlength="100" rows="2">${me.wish}</textarea>`, '', { optional: true })}
        ${c.phase2Open ? phase2Fields(me.phase2) : ''}
        <p class="form-error" role="alert" hidden></p>
        <button class="btn primary big" type="submit">儲存</button>
      </form>
      <p class="small muted">生日驗證碼不能自己修改，需要修改請：${c.adminContact}</p>
    </section>
    ${lineCard(d.lineGroupUrl)}
    <section class="card">
      <button class="btn" data-act="logout">登出</button>
      <p class="small muted">在別人的手機上查詢完，記得登出。</p>
    </section>`;
  }

  // ============================================================
  //  管理頁
  // ============================================================
  function viewAdmin() {
    if (!state.adminToken || !state.admin) {
      return html`<section class="card narrow">
        <h2>🛠️ 管理頁</h2>
        <form data-form="adminLogin" novalidate>
          ${field('管理密碼', html`<input name="password" type="password" autocomplete="current-password" required>`, '密碼設定在 Apps Script 的「指令碼屬性」ADMIN_PASSWORD。')}
          <p class="form-error" role="alert" hidden></p>
          <button class="btn primary big" type="submit">登入</button>
        </form>
        <p class="small"><button class="link" data-act="leaveAdmin">← 回到報名頁</button></p>
      </section>`;
    }
    const a = state.admin;
    const c = cfg();
    const teamById = {};
    a.teams.forEach(function (t) { teamById[t.id] = t; });
    const pool = a.members.filter(function (m) { return !m.teamId || !teamById[m.teamId]; });
    const inTeams = a.members.length - pool.length;
    const female = a.members.filter(function (m) { return m.gender === '女'; }).length;
    return html`
    <section class="card">
      <div class="team-head"><h2>🛠️ 管理頁</h2><button class="link" data-act="leaveAdmin">← 回到報名頁</button></div>
      <div class="stats">
        <div><b>${a.members.length}</b><span>報名人數</span></div>
        <div><b>${a.teams.length}</b><span>隊伍</span></div>
        <div><b>${inTeams}</b><span>已入隊</span></div>
        <div><b>${pool.length}</b><span>待安排</span></div>
        <div><b>${female}</b><span>女性</span></div>
        <div><b>${a.pendingCount}</b><span>待回覆申請</span></div>
      </div>
      <p class="small muted">開關（開放註冊：${c.registrationOpen ? '✅ 開' : '⛔ 關'}・第二階段：${c.phase2Open ? '✅ 開' : '⛔ 關'}・鎖定隊伍：${c.teamsLocked ? '🔒 已鎖定' : '🔓 未鎖定'}）請到 Google Sheet 的「設定」工作表修改。管理頁的調整不受「鎖定隊伍」限制。</p>
      <div class="stack-row">
        <input class="search" type="search" placeholder="搜尋姓名、電話、隊名…" value="${state.adminQuery}" data-input="adminSearch" aria-label="搜尋">
        <button class="btn small" data-act="adminRefresh">🔄 重新整理</button>
      </div>
    </section>

    <section class="card">
      <h3>⏳ 待安排（${pool.length} 人）</h3>
      <p class="small muted">勾選要放在同一隊的人，<b>第一個勾選的人會是隊長</b>。已經有隊伍的人也可以用下方各隊的「移到」調整。</p>
      <form data-form="adminCreateTeam" class="stack-row" novalidate>
        <input name="teamName" maxlength="16" placeholder="新隊名" aria-label="新隊名">
        <button class="btn primary small" type="submit">用勾選的人建立隊伍</button>
      </form>
      <p class="small" id="pick-list">${pickText()}</p>
      <ul class="admin-list">${pool.map(function (m) { return adminMemberRow(m, a, true); })}</ul>
    </section>

    ${a.teams.map(function (t) {
      const ms = a.members.filter(function (m) { return m.teamId === t.id; });
      ms.sort(function (x, y) { return x.id === t.captainId ? -1 : (y.id === t.captainId ? 1 : 0); });
      return html`<article class="card admin-team" data-search="${t.name + ' ' + ms.map(function (m) { return m.name + ' ' + m.phone; }).join(' ')}">
        <div class="team-head"><h3>${t.name}</h3><span class="tag">${t.size}/${t.capacity}</span>${recruitBadge(t.recruit)}<span class="tag mono">邀請碼 ${t.inviteCode}</span></div>
        ${t.warnings.length ? html`<ul class="warnings">${t.warnings.map(function (w) { return html`<li>⚠️ ${w}</li>`; })}</ul>` : ''}
        <ul class="admin-list">${ms.map(function (m) { return adminMemberRow(m, a, false, t); })}</ul>
        <button class="btn small" data-act="adminCopyTeam" data-id="${t.id}">📋 複製名單（給正式報名用）</button>
      </article>`;
    })}`;
  }

  function adminMemberRow(m, a, inPool, team) {
    const c = cfg();
    const picked = state.adminPick.indexOf(m.id) >= 0;
    const summary = c.phase2Open ? phase2Summary(m, true) : '';
    return html`<li class="admin-row" data-search="${m.name + ' ' + m.phone + ' ' + m.lineId + ' ' + (team ? team.name : '待安排')}">
      <div class="m-top">
        ${inPool ? html`<input type="checkbox" data-change="adminPick" value="${m.id}" ${picked ? 'checked' : ''} aria-label="勾選 ${m.name}">` : ''}
        <span class="m-name">${m.name}</span>
        ${m.role === '隊長' && !inPool ? html`<span class="tag captain">👑 隊長</span>` : ''}
        <span class="tag">${genderText(m.gender)}</span>
        ${c.phase2Open && !inPool ? html`<span class="tag leg">${legText(m.leg)}</span>` : ''}
        ${m.loginLocked ? html`<span class="tag warn">🔒 登入暫停中</span>` : ''}
      </div>
      <div class="small"><span class="mono">${m.phone}</span>・LINE <span class="mono">${m.lineId}</span>・${m.id}・${shortTime(m.createdAt)} 報名</div>
      ${m.wish ? html`<div class="small muted">💭 ${m.wish}</div>` : ''}
      ${summary ? html`<div class="small muted">${summary}</div>` : ''}
      ${m.adminNote ? html`<div class="small muted">📝 ${m.adminNote}</div>` : ''}
      <div class="m-actions">
        <label class="inline-field">移到
          <select data-change="adminMove" data-id="${m.id}" data-name="${m.name}">
            <option value="" ${!m.teamId ? 'selected' : ''}>待安排</option>
            ${a.teams.map(function (t) { return html`<option value="${t.id}" ${m.teamId === t.id ? 'selected' : ''}>${t.name}（${t.size}/${t.capacity}）</option>`; })}
          </select>
        </label>
        ${!inPool && m.role !== '隊長' ? html`<button class="btn small" data-act="adminSetCaptain" data-team="${m.teamId}" data-id="${m.id}" data-name="${m.name}">設為隊長</button>` : ''}
        <button class="btn small" data-act="adminResetCode" data-id="${m.id}" data-name="${m.name}">重設生日碼</button>
        <button class="btn small danger-outline" data-act="adminDelete" data-id="${m.id}" data-name="${m.name}">刪除</button>
      </div>
    </li>`;
  }

  function pickText() {
    if (!state.admin || !state.adminPick.length) return '尚未勾選';
    const names = state.adminPick.map(function (id) {
      const m = state.admin.members.find(function (x) { return x.id === id; });
      return m ? m.name : id;
    });
    return '已勾選 ' + names.length + ' 人：' + names.map(function (n, i) { return i === 0 ? n + '（隊長）' : n; }).join('、');
  }

  function applyAdminFilter() {
    const q = state.adminQuery.trim().toLowerCase();
    document.querySelectorAll('[data-search]').forEach(function (el) {
      el.hidden = !!q && el.getAttribute('data-search').toLowerCase().indexOf(q) < 0;
    });
  }

  function teamRosterText(t) {
    const c = cfg();
    const ms = state.admin.members.filter(function (m) { return m.teamId === t.id; });
    const lines = ['隊名：' + t.name, '人數：' + ms.length + ' 人'];
    const order = function (m) {
      if (m.leg && m.leg !== c.legSub) return Number(m.leg);
      return m.leg === c.legSub ? 50 : 99;
    };
    ms.sort(function (x, y) { return order(x) - order(y); });
    ms.forEach(function (m, i) {
      const leg = c.phase2Open ? legText(m.leg) + '　' : '';
      lines.push((i + 1) + '. ' + leg + m.name + '（' + m.gender + '）' + (m.id === t.captainId ? ' 隊長' : '') + '　' + m.phone + (c.phase2Open && m.shirt ? '　跑衣 ' + m.shirt : ''));
    });
    return lines.join('\n');
  }

  // ============================================================
  //  對話框、提示
  // ============================================================
  let toastTimer = null;
  function toast(msg, kind) {
    clearTimeout(toastTimer);
    $toast.textContent = msg;
    $toast.className = 'toast ' + (kind || '');
    $toast.hidden = false;
    toastTimer = setTimeout(function () { $toast.hidden = true; }, kind === 'error' ? 6000 : 3500);
  }

  /** 確認框。danger = true 時預設焦點在「取消」。回傳 null（取消）或 { value }。 */
  function ask(opts) {
    return new Promise(function (resolve) {
      const input = opts.input;
      $modal.innerHTML = html`<div class="modal-back" data-m="back">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
          <h3 id="modal-title">${opts.title}</h3>
          ${opts.body ? html`<div class="modal-body">${opts.body}</div>` : ''}
          ${input ? html`<label class="field"><span class="label">${input.label}</span>
            ${input.multiline
              ? html`<textarea data-m-input maxlength="${input.max || 100}" rows="3" placeholder="${input.placeholder || ''}"></textarea>`
              : html`<input data-m-input maxlength="${input.max || 100}" placeholder="${input.placeholder || ''}" inputmode="${input.inputmode || 'text'}" autocomplete="off">`}
          </label>` : ''}
          <div class="modal-actions">
            <button class="btn" data-m="cancel">${opts.cancelText || '取消'}</button>
            <button class="btn ${opts.danger ? 'danger' : 'primary'}" data-m="ok">${opts.okText || '確定'}</button>
          </div>
        </div>
      </div>`.s;
      $modal.hidden = false;
      const inputEl = $modal.querySelector('[data-m-input]');
      const focusEl = opts.danger ? $modal.querySelector('[data-m="cancel"]') : (inputEl || $modal.querySelector('[data-m="ok"]'));
      setTimeout(function () { focusEl.focus(); }, 30);
      function close(result) {
        $modal.hidden = true;
        $modal.innerHTML = '';
        document.removeEventListener('keydown', onKey);
        resolve(result);
      }
      function onKey(e) {
        if (e.key === 'Escape') close(null);
        if (e.key === 'Enter' && inputEl && document.activeElement === inputEl && !input.multiline) close({ value: inputEl.value });
      }
      document.addEventListener('keydown', onKey);
      $modal.onclick = function (e) {
        const m = e.target.getAttribute('data-m');
        if (m === 'ok') close({ value: inputEl ? inputEl.value : '' });
        else if (m === 'cancel' || m === 'back') close(null);
      };
    });
  }

  function renderQrs() {
    document.querySelectorAll('[data-qr]').forEach(function (el) {
      if (el.getAttribute('data-done')) return;
      if (typeof window.qrcode !== 'function') {
        el.textContent = 'QR code 載入中…（也可以直接點上面的按鈕）';
        return;
      }
      try {
        const qr = window.qrcode(0, 'M');
        qr.addData(el.getAttribute('data-qr'));
        qr.make();
        el.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true, alt: 'LINE 群組 QR code' });
        el.setAttribute('data-done', '1');
      } catch (e) {
        el.textContent = '無法產生 QR code，請直接點上面的按鈕。';
      }
    });
  }
  window.addEventListener('load', renderQrs);

  // ============================================================
  //  事件
  // ============================================================
  function handleError(e, form) {
    if (e && e.code === 'AUTH') {
      if (state.view === 'admin') {
        state.adminToken = null;
        session.set('adminToken', null);
        state.admin = null;
      } else {
        setToken(null);
        state.dash = null;
        state.view = 'login';
      }
      render();
      toast(e.message, 'error');
      return;
    }
    const msg = (e && e.message) || '發生錯誤，請再試一次';
    if (form) showFormError(form, msg);
    else toast(msg, 'error');
  }

  function goTab(tab) {
    state.view = 'dashboard';
    state.tab = tab;
    store.set('tab', tab);
    render();
  }

  function clearInvite() {
    state.invite = null;
    state.inviteInfo = null;
    state.inviteError = '';
    if (location.search.indexOf('join=') >= 0) history.replaceState(null, '', location.pathname + location.hash);
  }

  const clicks = {
    home: function () {
      if (state.view === 'admin') return;
      if (state.dash) goTab('team');
      else { state.view = 'landing'; render(); }
    },
    reload: function () { location.reload(); },
    go: function (ds) { state.view = ds.view; render(); },
    tab: function (ds) { goTab(ds.tab); },
    filter: function (ds) { state.teamsFilter = ds.filter; render(); },
    refresh: async function () { await refreshDashboard(false); toast('已更新', 'ok'); },
    logout: async function () {
      const r = await ask({ title: '要登出嗎？', body: '登出後要再用手機號碼＋生日查詢。', okText: '登出' });
      if (!r) return;
      setToken(null);
      state.dash = null;
      state.view = 'landing';
      render();
    },
    copy: async function (ds) {
      toast((await copyText(ds.text)) ? '已複製' : '無法自動複製，請長按文字自行複製', 'ok');
    },
    dismissInvite: function () { clearInvite(); render(); },
    joinInvite: async function () {
      const code = state.invite;
      clearInvite();
      await memberAction('joinByCode', { inviteCode: code });
      goTab('team');
    },
    applyJoin: async function (ds) {
      if (ds.open) {
        const r = await ask({ title: '加入「' + ds.name + '」？', body: '這一隊開放直接加入，按確定就會入隊。', okText: '加入' });
        if (r) await memberAction('applyJoin', { teamId: ds.id });
        return;
      }
      const r = await ask({
        title: '申請加入「' + ds.name + '」', body: '隊長同意後就會入隊。同時最多可以申請 ' + cfg().maxPending + ' 隊。',
        input: { label: '想對隊長說的話（選填）', placeholder: '例如：我配速 6 分，可以跑長距離', multiline: true }, okText: '送出申請',
      });
      if (r) await memberAction('applyJoin', { teamId: ds.id, message: r.value });
    },
    applyMerge: async function (ds) {
      const d = state.dash;
      const r = await ask({
        title: '整隊申請併入「' + ds.name + '」',
        body: html`對方隊長同意後，你們隊的 <b>${d.myTeam.size} 人</b>（${d.myTeam.members.map(function (m) { return m.name; }).join('、')}）會<b>一起</b>移到「${ds.name}」，你們原本的隊伍會解散，隊長由對方擔任。`,
        input: { label: '想對對方隊長說的話（選填）', multiline: true }, okText: '送出併隊申請',
      });
      if (r) await memberAction('applyMerge', { teamId: ds.id, message: r.value });
    },
    respond: async function (ds) {
      const accept = ds.accept === '1';
      if (!accept) {
        const r = await ask({ title: '確定要婉拒嗎？', okText: '婉拒', danger: true });
        if (!r) return;
      } else if (ds.type === '併隊') {
        const r = await ask({ title: '同意對方整隊併入？', body: '對方隊伍的所有人會一起加入你們隊。', okText: '同意併入' });
        if (!r) return;
      }
      await memberAction('respond', { requestId: ds.id, accept: accept });
    },
    cancelRequest: async function (ds) {
      await memberAction('cancelRequest', { requestId: ds.id });
    },
    invite: async function (ds) {
      const r = await ask({
        title: '邀請 ' + ds.name + ' 加入', body: '對方登入後會看到邀請，同意就會入隊。',
        input: { label: '想說的話（選填）', placeholder: '例如：我們缺一位可以跑長距離的隊友！', multiline: true }, okText: '送出邀請',
      });
      if (r) await memberAction('invite', { memberId: ds.id, message: r.value });
    },
    leaveTeam: async function () {
      const d = state.dash;
      const r = await ask({
        title: '確定要離開「' + d.myTeam.name + '」嗎？',
        body: d.isCaptain ? (d.myTeam.size > 1 ? '你是隊長，離開後隊長會交給最早入隊的隊員。' : '你是最後一位隊員，離開後隊伍會解散。') : '離開後你會回到待安排區，要回來需要重新申請。',
        okText: '離開隊伍', danger: true,
      });
      if (r) await memberAction('leaveTeam', {});
    },
    regenerateInvite: async function () {
      const r = await ask({ title: '重新產生邀請連結？', body: '舊的連結和邀請碼會立刻失效，已經傳出去的連結都不能再用。', okText: '重新產生', danger: true });
      if (r) await memberAction('regenerateInvite', {});
    },
    transferCaptain: async function (ds) {
      const r = await ask({ title: '把隊長交給 ' + ds.name + '？', body: '交接後你會變成一般隊員，只有新隊長能審核申請、修改隊伍資料。', okText: '交接隊長', danger: true });
      if (r) await memberAction('transferCaptain', { memberId: ds.id });
    },
    removeMember: async function (ds) {
      const r = await ask({ title: '把 ' + ds.name + ' 移出隊伍？', body: '對方會回到待安排區。', okText: '移出', danger: true });
      if (r) await memberAction('removeMember', { memberId: ds.id });
    },
    seedDemo: async function () {
      await window.Api.ensureLocal();
      window.LocalBackend.seed();
      toast('已產生示範資料：電話 0900000001～12，生日 0101', 'ok');
      if (state.token) await refreshDashboard(true);
    },
    resetLocal: async function () {
      const r = await ask({ title: '清除所有模擬資料？', body: '只會清除這台電腦瀏覽器裡的模擬資料。', okText: '清除', danger: true });
      if (!r) return;
      await window.Api.ensureLocal();
      window.LocalBackend.clear();
      setToken(null);
      state.dash = null;
      state.admin = null;
      state.adminToken = null;
      session.set('adminToken', null);
      state.view = location.hash === '#admin' ? 'admin' : 'landing';
      render();
      toast('已清除', 'ok');
    },
    // 管理頁
    leaveAdmin: function () { location.hash = ''; },
    adminLogout: function () {
      state.adminToken = null;
      session.set('adminToken', null);
      state.admin = null;
      render();
    },
    adminRefresh: async function () { await adminAction('adminData', {}); },
    adminSetCaptain: async function (ds) {
      const r = await ask({ title: '把 ' + ds.name + ' 設為隊長？', okText: '設為隊長' });
      if (r) await adminAction('adminSetCaptain', { teamId: ds.team, memberId: ds.id });
    },
    adminResetCode: async function (ds) {
      const r = await ask({
        title: '重設 ' + ds.name + ' 的生日驗證碼', body: '請先在 LINE 上確認是本人。重設後，對方要用新的 4 碼登入。',
        input: { label: '新的生日（月日 4 碼）', placeholder: '0731', max: 4, inputmode: 'numeric' }, okText: '重設',
      });
      if (!r) return;
      const err = birthdayError(r.value.trim());
      if (err) { toast(err, 'error'); return; }
      await adminAction('adminResetCode', { memberId: ds.id, birthday: r.value.trim() });
    },
    adminDelete: async function (ds) {
      const r = await ask({ title: '刪除 ' + ds.name + ' 的資料？', body: '會從名單中永久刪除，無法復原（紀錄工作表仍會留下操作紀錄）。', okText: '永久刪除', danger: true });
      if (r) await adminAction('adminDeleteMember', { memberId: ds.id });
    },
    adminCopyTeam: async function (ds) {
      const t = state.admin.teams.find(function (x) { return x.id === ds.id; });
      if (!t) return;
      toast((await copyText(teamRosterText(t))) ? '已複製「' + t.name + '」的名單' : '無法自動複製', 'ok');
    },
  };

  const forms = {
    register: async function (form) {
      const payload = {
        name: val(form, 'name').trim(), phone: normalizePhone(val(form, 'phone')), birthday: val(form, 'birthday').trim(),
        lineId: val(form, 'lineId').trim(), gender: radio(form, 'gender'), wish: val(form, 'wish'), consent: val(form, 'consent') === true,
      };
      let err = '';
      if (!payload.name) err = '請填寫姓名';
      else if (!/^09\d{8}$/.test(payload.phone)) err = '請輸入 09 開頭的 10 碼手機號碼';
      else if (birthdayError(payload.birthday)) err = birthdayError(payload.birthday);
      else if (!payload.lineId) err = '請填寫 LINE ID';
      else if (!payload.gender) err = '請選擇性別';
      else if (!payload.consent) err = '請先閱讀並勾選同意個資告知事項';
      if (err) return showFormError(form, err);
      if (cfg().phase2Open) payload.phase2 = readPhase2(form);
      if (state.invite) payload.inviteCode = state.invite;
      const res = await api('register', payload, { busyText: '報名中…' });
      setToken(res.token);
      applyDash(res.dashboard);
      state.welcome = res.message;
      clearInvite();
      state.view = 'welcome';
      render();
    },
    login: async function (form) {
      const phone = normalizePhone(val(form, 'phone'));
      const birthday = val(form, 'birthday').trim();
      if (!/^09\d{8}$/.test(phone)) return showFormError(form, '請輸入 09 開頭的 10 碼手機號碼');
      if (!/^\d{4}$/.test(birthday)) return showFormError(form, '生日請輸入 4 位數字，例如 0731');
      const res = await api('login', { phone: phone, birthday: birthday }, { busyText: '查詢中…' });
      setToken(res.token);
      applyDash(res.dashboard);
      goTab('team');
      toast('歡迎回來，' + res.dashboard.me.name, 'ok');
    },
    createTeam: async function (form) {
      const teamName = val(form, 'teamName').trim();
      if (!teamName) return showFormError(form, '請填寫隊名');
      await memberAction('createTeam', { teamName: teamName, recruit: radio(form, 'recruit'), intro: val(form, 'intro') }, { busyText: '建立中…' });
    },
    joinCode: async function (form) {
      const code = val(form, 'code').trim().toUpperCase();
      if (!code) return showFormError(form, '請輸入邀請碼');
      await memberAction('joinByCode', { inviteCode: code });
    },
    updateTeam: async function (form) {
      await memberAction('updateTeam', { teamName: val(form, 'teamName').trim(), recruit: radio(form, 'recruit'), intro: val(form, 'intro') });
    },
    profile: async function (form) {
      const payload = { name: val(form, 'name').trim(), lineId: val(form, 'lineId').trim(), gender: radio(form, 'gender'), wish: val(form, 'wish') };
      if (!payload.name) return showFormError(form, '請填寫姓名');
      if (!payload.lineId) return showFormError(form, '請填寫 LINE ID');
      if (cfg().phase2Open) payload.phase2 = readPhase2(form);
      await memberAction('updateProfile', payload, { busyText: '儲存中…' });
    },
    adminLogin: async function (form) {
      const res = await api('adminLogin', { password: val(form, 'password') });
      state.adminToken = res.adminToken;
      session.set('adminToken', res.adminToken);
      state.admin = res.data;
      state.config = res.data.config;
      render();
    },
    adminCreateTeam: async function (form) {
      const teamName = val(form, 'teamName').trim();
      if (!state.adminPick.length) return toast('請先勾選待安排的人', 'error');
      if (!teamName) return toast('請填寫新隊名', 'error');
      const ids = state.adminPick.slice();
      await adminAction('adminCreateTeam', { teamName: teamName, memberIds: ids });
      state.adminPick = [];
      render();
    },
  };

  const changes = {
    assignLeg: async function (el) {
      try {
        await memberAction('assignLeg', { memberId: el.getAttribute('data-member'), leg: el.value });
      } catch (e) {
        render();
        throw e;
      }
    },
    adminPick: function (el) {
      const id = el.value;
      state.adminPick = state.adminPick.filter(function (x) { return x !== id; });
      if (el.checked) state.adminPick.push(id);
      const p = document.getElementById('pick-list');
      if (p) p.textContent = pickText();
    },
    adminMove: async function (el) {
      const target = el.value ? el.options[el.selectedIndex].text : '待安排';
      const r = await ask({ title: '把 ' + el.getAttribute('data-name') + ' 移到「' + target + '」？', okText: '移動' });
      if (!r) { render(); return; }
      try {
        await adminAction('adminMove', { memberId: el.getAttribute('data-id'), teamId: el.value });
      } catch (e) {
        render();
        throw e;
      }
    },
  };

  document.addEventListener('click', async function (ev) {
    const el = ev.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const fn = clicks[el.getAttribute('data-act')];
    if (!fn) return;
    ev.preventDefault();
    try { await fn(el.dataset, el); } catch (e) { handleError(e); }
  });

  document.addEventListener('submit', async function (ev) {
    const form = ev.target.closest('form[data-form]');
    if (!form) return;
    ev.preventDefault();
    const fn = forms[form.getAttribute('data-form')];
    if (!fn) return;
    const err = form.querySelector('.form-error');
    if (err) err.hidden = true;
    try { await fn(form); } catch (e) { handleError(e, form); }
  });

  document.addEventListener('change', async function (ev) {
    const el = ev.target.closest('[data-change]');
    if (!el) return;
    try { await changes[el.getAttribute('data-change')](el); } catch (e) { handleError(e); }
  });

  document.addEventListener('input', function (ev) {
    state.dirty = true;
    const el = ev.target;
    if (el.getAttribute && el.getAttribute('data-input') === 'adminSearch') {
      state.adminQuery = el.value;
      applyAdminFilter();
    }
  });

  // 從 LINE 切回來時自動更新（正在填表單時不更新，避免打到一半的字不見）
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible' || state.view !== 'dashboard' || state.dirty || !$modal.hidden) return;
    if (Date.now() - state.lastLoad < 30000) return;
    refreshDashboard(true).catch(function (e) { if (e.code === 'AUTH') handleError(e); });
  });

  window.addEventListener('hashchange', function () {
    if (location.hash === '#admin') enterAdmin().catch(function (e) { handleError(e); });
    else if (state.view === 'admin') {
      state.view = state.dash ? 'dashboard' : 'landing';
      render();
    }
  });

  async function enterAdmin() {
    state.view = 'admin';
    if (!state.config) {
      const r = await api('config', {}, { quiet: true });
      state.config = r.config;
    }
    if (state.adminToken && !state.admin) {
      try {
        const res = await api('adminData', {}, { quiet: true });
        state.admin = res.data;
        state.config = res.data.config;
      } catch (e) {
        if (e.code !== 'AUTH') throw e;
        state.adminToken = null;
        session.set('adminToken', null);
      }
    }
    render();
  }

  // ============================================================
  //  啟動
  // ============================================================
  async function start() {
    const join = (new URLSearchParams(location.search).get('join') || '').trim().toUpperCase();
    if (/^[A-Z0-9]{4,10}$/.test(join)) state.invite = join;
    try {
      if (location.hash === '#admin') {
        await enterAdmin();
        return;
      }
      const r = await api('config', state.invite ? { inviteCode: state.invite } : {}, { quiet: true });
      state.config = r.config;
      state.inviteInfo = r.invite || null;
      state.inviteError = r.inviteError || '';
      state.view = 'landing';
      if (state.token) {
        try {
          const res = await api('dashboard', {}, { quiet: true });
          applyDash(res.dashboard);
          state.view = 'dashboard';
          if (state.invite) state.tab = 'team';
        } catch (e) {
          if (e.code !== 'AUTH') throw e;
          setToken(null);
        }
      }
      render();
    } catch (e) {
      state.view = 'fatal';
      state.fatal = e.message;
      render();
    }
  }

  start();
})();
