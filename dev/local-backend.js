/**
 * 本機模擬模式的後端：在瀏覽器裡直接執行 apps-script/Code.gs，資料存在這台電腦的 localStorage。
 * 只有在 localhost 開啟、而且 js/config.js 沒有填 API_URL（或網址加上 ?local=1）時才會使用。
 */
(function () {
  'use strict';

  const KEY = 'trainRelay.localDb.v1';
  const LOCAL_ADMIN_PASSWORD = 'admin1234';

  function load() {
    let state = null;
    try {
      const s = localStorage.getItem(KEY);
      if (s) state = JSON.parse(s);
    } catch (e) {
      state = null;
    }
    if (state) window.MockGas.importState(state);
    else window.MockGas.reset();
    const props = PropertiesService.getScriptProperties();
    if (!props.getProperty('ADMIN_PASSWORD')) props.setProperty('ADMIN_PASSWORD', LOCAL_ADMIN_PASSWORD);
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(window.MockGas.exportState()));
    } catch (e) {
      console.warn('模擬資料無法儲存（瀏覽器可能封鎖了儲存空間）', e);
    }
  }

  function callSync(body) {
    load();
    const out = window.doPost({ postData: { contents: JSON.stringify(body) } });
    save();
    return JSON.parse(out.getContent());
  }

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  const DEMO = [
    ['林小美', '女'], ['陳大文', '男'], ['王雅婷', '女'], ['張志明', '男'], ['李佳穎', '女'], ['黃俊傑', '男'],
    ['吳怡君', '女'], ['劉建宏', '男'], ['蔡宜蓁', '女'], ['楊家豪', '男'], ['許淑芬', '女'], ['鄭宇翔', '男'],
  ];

  function demoPhone(i) {
    return '09000000' + String(i + 1).padStart(2, '0');
  }

  /** 產生示範資料：12 位成員、3 個隊伍、1 個申請、1 個邀請。電話 0900000001～12，生日都是 0101。 */
  function seed() {
    const tokens = [];
    DEMO.forEach(function (d, i) {
      let r = callSync({ action: 'register', name: d[0], phone: demoPhone(i), birthday: '0101', lineId: 'demo_line_' + (i + 1), gender: d[1], consent: true, wish: i === 8 ? '想跟福隆衝衝衝一起跑' : '' });
      if (!r.ok) r = callSync({ action: 'login', phone: demoPhone(i), birthday: '0101' });
      tokens.push(r.ok ? r.token : '');
    });
    const t1 = callSync({ action: 'createTeam', token: tokens[0], teamName: '福隆衝衝衝', recruit: '需隊長同意', intro: '輕鬆跑、享受山海線，歡迎新手！' });
    if (t1.ok) {
      const code = t1.dashboard.myTeam.inviteCode;
      callSync({ action: 'joinByCode', token: tokens[1], inviteCode: code });
      callSync({ action: 'joinByCode', token: tokens[2], inviteCode: code });
    }
    const t2 = callSync({ action: 'createTeam', token: tokens[3], teamName: '草嶺隧道小隊', recruit: '開放直接加入', intro: '目標 5 小時內完賽' });
    if (t2.ok) callSync({ action: 'joinByCode', token: tokens[4], inviteCode: t2.dashboard.myTeam.inviteCode });
    callSync({ action: 'createTeam', token: tokens[5], teamName: '變裝火車頭', recruit: '需隊長同意', intro: '報變裝組，一起扮成火車！' });
    if (t1.ok) callSync({ action: 'applyJoin', token: tokens[8], teamId: t1.dashboard.myTeam.id, message: '我配速大概 6 分，可以跑長距離' });
    const pool = callSync({ action: 'dashboard', token: tokens[5] });
    if (pool.ok) {
      const target = pool.dashboard.pool.find(function (p) { return p.name === DEMO[9][0]; });
      if (target) callSync({ action: 'invite', token: tokens[5], memberId: target.id, message: '一起來變裝吧！' });
    }
  }

  window.LocalBackend = {
    adminPassword: LOCAL_ADMIN_PASSWORD,
    demoPhone: demoPhone,
    call: function (body) {
      return delay(120).then(function () { return callSync(body); });
    },
    seed: function () {
      seed();
    },
    clear: function () {
      try { localStorage.removeItem(KEY); } catch (e) { /* 忽略 */ }
    },
  };
})();
