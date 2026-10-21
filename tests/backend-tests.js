/**
 * 後端自動測試：在瀏覽器裡用模擬的 Google 環境執行 apps-script/Code.gs。
 * 開啟 tests/backend.html 就會執行，結果顯示在頁面上（標題會顯示 PASS 或 FAIL）。
 */
(function () {
  'use strict';

  const tests = [];
  function test(name, fn) { tests.push({ name: name, fn: fn }); }

  // ---------- 輔助工具 ----------
  let clock = new Date('2026-10-21T10:00:00+08:00');
  window.now_ = function () { return new Date(clock.getTime()); };
  function advance(ms) { clock = new Date(clock.getTime() + ms); }

  function eq(actual, expected, msg) {
    if (actual !== expected) throw new Error((msg ? msg + '：' : '') + '預期 ' + JSON.stringify(expected) + '，實際 ' + JSON.stringify(actual));
  }
  function ok(v, msg) { if (!v) throw new Error(msg || '條件不成立'); }

  function call(action, payload) {
    const out = window.doPost({ postData: { contents: JSON.stringify(Object.assign({ action: action }, payload || {})) } });
    return JSON.parse(out.getContent());
  }
  function must(action, payload) {
    const r = call(action, payload);
    if (!r.ok) throw new Error(action + ' 應該成功，卻失敗：' + r.error);
    return r;
  }
  function mustFail(action, payload, includes) {
    const r = call(action, payload);
    if (r.ok) throw new Error(action + ' 應該失敗，卻成功');
    if (includes && r.error.indexOf(includes) < 0) throw new Error(action + ' 錯誤訊息不符，預期包含「' + includes + '」，實際：' + r.error);
    return r;
  }

  let seq = 0;
  function reg(opts) {
    opts = opts || {};
    seq++;
    const phone = opts.phone || ('09' + String(10000000 + seq).slice(-8));
    const r = must('register', {
      name: opts.name || ('跑者' + seq), phone: phone, birthday: opts.birthday || '0101', lineId: opts.lineId || ('line_' + seq),
      gender: opts.gender || '男', consent: true, inviteCode: opts.inviteCode, wish: opts.wish, phase2: opts.phase2,
    });
    return { token: r.token, id: r.dashboard.me.id, phone: phone, res: r };
  }
  function dash(u) { return must('dashboard', { token: u.token }).dashboard; }
  function team(u, name, recruit) {
    const r = must('createTeam', { token: u.token, teamName: name || ('隊' + (++seq)), recruit: recruit || '需隊長同意' });
    return r.dashboard.myTeam;
  }
  function setSetting(key, value) {
    must('config');  // 確保設定表存在
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('設定');
    const vals = sh.getDataRange().getValues();
    for (let i = 1; i < vals.length; i++) {
      if (vals[i][0] === key) { sh.getRange(i + 1, 2).setValue(value); return; }
    }
    throw new Error('找不到設定：' + key);
  }
  function sheetRows(name) {
    return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name).getDataRange().getValues();
  }
  function adminToken() {
    return must('adminLogin', { password: 'test-admin-pw' }).adminToken;
  }
  function pendingIncoming(u) {
    return dash(u).requests.incoming.filter(function (r) { return r.status === '待回覆'; });
  }

  // ---------- 測試 ----------
  test('SHA-256 與 HMAC 模擬正確（標準測試向量）', function () {
    eq(MockGas.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    eq(MockGas.hmacHex('key', 'The quick brown fox jumps over the lazy dog'), 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
  });

  test('setup 會建立所有工作表、預設設定與金鑰', function () {
    window.setup();
    ['設定', '成員', '隊伍', '申請', '紀錄'].forEach(function (n) {
      ok(SpreadsheetApp.getActiveSpreadsheet().getSheetByName(n), '缺少工作表 ' + n);
    });
    eq(sheetRows('成員')[0].length, 26, '成員欄位數');
    ok(PropertiesService.getScriptProperties().getProperty('TOKEN_SECRET'), '缺少 TOKEN_SECRET');
    const r = must('config');
    eq(r.config.registrationOpen, true, '開放註冊');
    eq(r.config.phase2Open, false, '第二階段預設關閉');
    eq(r.config.teamsLocked, false);
    eq(r.config.capacity.total, 9, '7＋2');
    eq(r.config.legs.length, 7);
    ok(r.config.phase2Fields.some(function (f) { return f.key === 'adult' && f.required; }));
  });

  test('報名欄位驗證', function () {
    const base = { name: '小明', phone: '0912345678', birthday: '0731', lineId: 'ming', gender: '男', consent: true };
    mustFail('register', Object.assign({}, base, { phone: '12345' }), '09 開頭');
    mustFail('register', Object.assign({}, base, { birthday: '1332' }), '生日');
    mustFail('register', Object.assign({}, base, { birthday: '0230' }), '生日');
    mustFail('register', Object.assign({}, base, { birthday: '731' }), '生日');
    mustFail('register', Object.assign({}, base, { consent: false }), '個資');
    mustFail('register', Object.assign({}, base, { gender: '' }), '性別');
    mustFail('register', Object.assign({}, base, { name: '  ' }), '姓名');
    mustFail('register', Object.assign({}, base, { lineId: '' }), 'LINE ID');
    must('register', Object.assign({}, base, { birthday: '0229' }));
    mustFail('register', Object.assign({}, base, { phone: '0912-345-678' }), '已經報名過');
  });

  test('電話以純文字保存，開頭的 0 不會不見；+886 會轉成 09', function () {
    const u = reg({ phone: '+886 912 000 111' });
    const rows = sheetRows('成員');
    const col = rows[0].indexOf('電話');
    eq(rows[1][col], '0912000111', 'Sheet 裡的電話');
    eq(typeof rows[1][col], 'string');
    eq(dash(u).me.phoneMasked, '0912***111');
    must('login', { phone: '0912000111', birthday: '0101' });
  });

  test('就算儲存格被改成數字格式，讀回來的電話仍然正確', function () {
    reg({ phone: '0922333444' });
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('成員');
    const col = sheetRows('成員')[0].indexOf('電話') + 1;
    sh.textRects = [];             // 模擬有人把格式改掉
    sh.getRange(2, col).setValue('0922333444');
    eq(sh.getRange(2, col).getValue(), 922333444, '模擬 Sheet 會吃掉 0');
    must('login', { phone: '0922333444', birthday: '0101' });
  });

  test('生日驗證碼不以明文保存', function () {
    reg({ phone: '0933000001', birthday: '0731' });
    const json = JSON.stringify(sheetRows('成員'));
    ok(json.indexOf('0731') < 0, 'Sheet 裡不應出現生日明文');
  });

  test('登入：錯誤 5 次暫停 15 分鐘，時間到可以再登入', function () {
    reg({ phone: '0955000001', birthday: '1225' });
    for (let i = 0; i < 4; i++) mustFail('login', { phone: '0955000001', birthday: '0101' }, '不正確');
    mustFail('login', { phone: '0955000001', birthday: '0101' }, '暫停');
    mustFail('login', { phone: '0955000001', birthday: '1225' }, '分鐘後再試');
    advance(16 * 60000);
    must('login', { phone: '0955000001', birthday: '1225' });
  });

  test('登入：不存在的電話顯示一般錯誤訊息', function () {
    mustFail('login', { phone: '0900111222', birthday: '0101' }, '手機號碼或生日不正確');
  });

  test('登入憑證：竄改或過期都會被拒絕', function () {
    const u = reg();
    const parts = u.token.split('.');
    mustFail('dashboard', { token: parts[0] + '.' + parts[1] + '.' + parts[2].replace(/.$/, parts[2].slice(-1) === 'a' ? 'b' : 'a') }, '重新登入');
    const other = reg();
    mustFail('dashboard', { token: other.id + '.' + parts[1] + '.' + parts[2] }, '重新登入');
    mustFail('dashboard', { token: 'abc' }, '重新登入');
    advance(31 * 86400000);
    const r = mustFail('dashboard', { token: u.token }, '過期');
    eq(r.code, 'AUTH');
  });

  test('管理員重設生日碼後，舊的登入憑證失效', function () {
    const u = reg({ birthday: '0505' });
    const at = adminToken();
    must('adminResetCode', { adminToken: at, memberId: u.id, birthday: '0606' });
    mustFail('dashboard', { token: u.token }, '重新登入');
    mustFail('login', { phone: u.phone, birthday: '0505' }, '不正確');
    must('login', { phone: u.phone, birthday: '0606' });
  });

  test('建立隊伍：建立者是隊長，隊名不可重複，不能同時在兩隊', function () {
    const a = reg({ gender: '女' });
    const t = team(a, '福隆衝衝衝');
    eq(t.name, '福隆衝衝衝');
    eq(t.captainId, a.id);
    eq(t.size, 1);
    ok(/^[A-Z2-9]{6}$/.test(t.inviteCode), '邀請碼格式');
    mustFail('createTeam', { token: a.token, teamName: '另一隊' }, '已經在隊伍裡');
    const b = reg();
    mustFail('createTeam', { token: b.token, teamName: '福隆 衝衝衝' }, '已經有隊伍叫');
    mustFail('createTeam', { token: b.token, teamName: '一二三四五六七八九' }, '中文 8 個字');
    must('createTeam', { token: b.token, teamName: 'ABCDEFGHIJKLMNOP' });
  });

  test('用邀請碼報名會直接入隊；邀請碼錯誤仍完成報名、留在待安排', function () {
    const a = reg();
    const t = team(a);
    const b = reg({ inviteCode: t.inviteCode.toLowerCase() });
    eq(b.res.dashboard.myTeam && b.res.dashboard.myTeam.id, t.id);
    ok(b.res.message.indexOf('已經加入') >= 0, b.res.message);
    const c = reg({ inviteCode: 'ZZZZZZ' });
    eq(c.res.dashboard.myTeam, null);
    ok(c.res.message.indexOf('待安排') >= 0, c.res.message);
  });

  test('隊伍上限 9 人（7 正式＋2 候補），第 10 人加入失敗', function () {
    const a = reg();
    const t = team(a);
    for (let i = 0; i < 8; i++) must('joinByCode', { token: reg().token, inviteCode: t.inviteCode });
    eq(dash(a).myTeam.size, 9);
    eq(dash(a).myTeam.full, true);
    mustFail('joinByCode', { token: reg().token, inviteCode: t.inviteCode }, '額滿');
  });

  test('申請加入 → 隊長同意 → 入隊，申請人的其他申請自動失效', function () {
    const a = reg(); const t1 = team(a);
    const b = reg(); const t2 = team(b);
    const c = reg();
    must('applyJoin', { token: c.token, teamId: t1.id, message: '我跑很慢但很努力' });
    must('applyJoin', { token: c.token, teamId: t2.id });
    mustFail('applyJoin', { token: c.token, teamId: t1.id }, '已經申請過');
    const inc = pendingIncoming(a);
    eq(inc.length, 1);
    eq(inc[0].message, '我跑很慢但很努力');
    eq(inc[0].canRespond, true);
    mustFail('respond', { token: c.token, requestId: inc[0].id, accept: true }, '只有');
    must('respond', { token: a.token, requestId: inc[0].id, accept: true });
    eq(dash(c).myTeam.id, t1.id);
    eq(pendingIncoming(b).length, 0, 'B 隊的申請應失效');
    const out = dash(c).requests.outgoing;
    ok(out.some(function (r) { return r.toTeam.id === t2.id && r.status === '已失效'; }), '對 B 隊的申請狀態應為已失效');
  });

  test('同時待回覆的申請最多 3 個', function () {
    const c = reg();
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push(team(reg()).id);
    for (let i = 0; i < 3; i++) must('applyJoin', { token: c.token, teamId: ids[i] });
    mustFail('applyJoin', { token: c.token, teamId: ids[3] }, '最多只能有 3 個');
  });

  test('「開放直接加入」的隊伍申請後立即入隊；「暫停招募」不能申請也不能用邀請碼', function () {
    const a = reg(); const t = team(a, '開放隊', '開放直接加入');
    const b = reg();
    const r = must('applyJoin', { token: b.token, teamId: t.id });
    eq(r.dashboard.myTeam.id, t.id);
    const c = reg(); const t2 = team(c, '暫停隊', '暫停招募');
    const d = reg();
    mustFail('applyJoin', { token: d.token, teamId: t2.id }, '暫停招募');
    mustFail('joinByCode', { token: d.token, inviteCode: t2.inviteCode }, '暫停招募');
  });

  test('隊長邀請待安排的人 → 對方接受入隊；婉拒也可以', function () {
    const a = reg(); const t = team(a);
    const b = reg(); const c = reg();
    must('invite', { token: a.token, memberId: b.id, message: '一起跑！' });
    mustFail('invite', { token: a.token, memberId: b.id }, '已經邀請過');
    must('invite', { token: a.token, memberId: c.id });
    const invB = pendingIncoming(b)[0];
    eq(invB.type, '邀請');
    eq(invB.fromTeam.name, t.name);
    must('respond', { token: b.token, requestId: invB.id, accept: true });
    eq(dash(b).myTeam.id, t.id);
    const invC = pendingIncoming(c)[0];
    must('respond', { token: c.token, requestId: invC.id, accept: false });
    eq(dash(c).myTeam, null);
    const nonCaptain = b;
    mustFail('invite', { token: nonCaptain.token, memberId: c.id }, '只有隊長');
  });

  test('已被邀請的人按「申請加入」＝直接接受邀請；已申請的人被邀請＝直接入隊', function () {
    const a = reg(); const t = team(a);
    const b = reg();
    must('invite', { token: a.token, memberId: b.id });
    const r = must('applyJoin', { token: b.token, teamId: t.id });
    eq(r.dashboard.myTeam.id, t.id);
    const c = reg();
    must('applyJoin', { token: c.token, teamId: t.id });
    const r2 = must('invite', { token: a.token, memberId: c.id });
    ok(r2.message.indexOf('直接加入') >= 0, r2.message);
    eq(dash(c).myTeam.id, t.id);
  });

  test('整隊併入：3 人隊併入 4 人隊，朋友不會被拆散；原隊伍解散', function () {
    const a = reg({ name: '甲隊長' }); const ta = team(a, '甲隊');
    const a2 = reg({ inviteCode: ta.inviteCode }); const a3 = reg({ inviteCode: ta.inviteCode });
    const b = reg({ name: '乙隊長' }); const tb = team(b, '乙隊');
    for (let i = 0; i < 3; i++) reg({ inviteCode: tb.inviteCode });
    const pool = reg();
    must('invite', { token: a.token, memberId: pool.id });
    mustFail('applyMerge', { token: a2.token, teamId: tb.id }, '只有隊長');
    must('applyMerge', { token: a.token, teamId: tb.id, message: '我們 3 個一起' });
    const inc = pendingIncoming(b);
    eq(inc.length, 1);
    eq(inc[0].type, '併隊');
    eq(inc[0].fromTeam.size, 3);
    eq(inc[0].fromTeam.members.length, 3);
    must('respond', { token: b.token, requestId: inc[0].id, accept: true });
    const d = dash(b).myTeam;
    eq(d.size, 7);
    eq(d.captainId, b.id, '隊長仍是乙隊長');
    [a, a2, a3].forEach(function (u) { eq(dash(u).myTeam.id, tb.id); });
    eq(dash(a).myTeam.members.find(function (m) { return m.id === a.id; }).role, '隊員');
    ok(!dash(b).teams.some(function (t) { return t.id === ta.id; }), '甲隊應已解散');
    eq(pendingIncoming(pool).length, 0, '甲隊發出的邀請應失效');
  });

  test('整隊併入：合計超過 9 人不能申請；申請後人數變多，同意時會失效', function () {
    const a = reg(); const ta = team(a);
    for (let i = 0; i < 4; i++) reg({ inviteCode: ta.inviteCode });
    const b = reg(); const tb = team(b);
    for (let i = 0; i < 4; i++) reg({ inviteCode: tb.inviteCode });
    mustFail('applyMerge', { token: a.token, teamId: tb.id }, '超過每隊上限');
    eq(dash(a).teams.find(function (t) { return t.id === tb.id; }).mergeTooBig, true);

    const c = reg(); const tc = team(c);
    reg({ inviteCode: tc.inviteCode }); // c 隊 2 人
    const e = reg(); const te = team(e);
    for (let i = 0; i < 5; i++) reg({ inviteCode: te.inviteCode }); // e 隊 6 人
    must('applyMerge', { token: c.token, teamId: te.id });
    reg({ inviteCode: tc.inviteCode }); // c 隊變 3 人 → 合計 9，仍可
    reg({ inviteCode: te.inviteCode }); // e 隊變 7 人 → 合計 10，超過
    const inc = pendingIncoming(e)[0];
    const r = must('respond', { token: e.token, requestId: inc.id, accept: true });
    ok(r.message.indexOf('失效') >= 0, r.message);
    eq(dash(c).myTeam.id, tc.id, 'c 隊沒有被併入');
  });

  test('隊伍額滿時，其他待回覆的申請自動失效', function () {
    const a = reg(); const t = team(a);
    for (let i = 0; i < 7; i++) reg({ inviteCode: t.inviteCode });
    const waiting = reg();
    must('applyJoin', { token: waiting.token, teamId: t.id });
    reg({ inviteCode: t.inviteCode }); // 第 9 人
    eq(pendingIncoming(a).length, 0);
    ok(dash(waiting).requests.outgoing[0].note.indexOf('額滿') >= 0);
  });

  test('離開隊伍：隊長離開交給最早入隊的人，最後一人離開就解散', function () {
    const a = reg({ name: '隊長A' }); const t = team(a);
    advance(1000);
    const b = reg({ name: '先來B', inviteCode: t.inviteCode });
    advance(1000);
    const c = reg({ name: '後到C', inviteCode: t.inviteCode });
    must('leaveTeam', { token: a.token });
    eq(dash(b).myTeam.captainId, b.id, '隊長交給 B');
    eq(dash(a).myTeam, null);
    ok(dash(a).pool.some(function (p) { return p.id === a.id; }), 'A 回到待安排');
    must('leaveTeam', { token: b.token });
    must('leaveTeam', { token: c.token });
    ok(!dash(c).teams.some(function (x) { return x.id === t.id; }), '隊伍應解散');
    mustFail('joinByCode', { token: a.token, inviteCode: t.inviteCode }, '無效');
  });

  test('隊長可以轉移隊長、移出隊員、重新產生邀請碼', function () {
    const a = reg(); const t = team(a);
    const b = reg({ inviteCode: t.inviteCode });
    const c = reg({ inviteCode: t.inviteCode });
    mustFail('removeMember', { token: b.token, memberId: c.id }, '只有隊長');
    must('removeMember', { token: a.token, memberId: c.id });
    eq(dash(c).myTeam, null);
    must('transferCaptain', { token: a.token, memberId: b.id });
    eq(dash(a).myTeam.captainId, b.id);
    const r = must('regenerateInvite', { token: b.token });
    ok(r.dashboard.myTeam.inviteCode !== t.inviteCode);
    mustFail('joinByCode', { token: c.token, inviteCode: t.inviteCode }, '無效');
  });

  test('鎖定隊伍後，一般使用者不能異動；管理員仍可以搬人', function () {
    const a = reg(); const t = team(a);
    const b = reg();
    must('applyJoin', { token: b.token, teamId: t.id });
    setSetting('鎖定隊伍', true);
    mustFail('createTeam', { token: b.token, teamName: '新隊' }, '鎖定');
    mustFail('joinByCode', { token: b.token, inviteCode: t.inviteCode }, '鎖定');
    mustFail('leaveTeam', { token: a.token }, '鎖定');
    const inc = pendingIncoming(a)[0];
    mustFail('respond', { token: a.token, requestId: inc.id, accept: true }, '鎖定');
    must('respond', { token: a.token, requestId: inc.id, accept: false });
    const at = adminToken();
    must('adminMove', { adminToken: at, memberId: b.id, teamId: t.id });
    eq(dash(b).myTeam.id, t.id);
    eq(dash(a).teams[0].canApply, false);
  });

  test('暫停註冊時不能報名，已報名的人仍可登入', function () {
    const u = reg({ phone: '0966000001' });
    setSetting('開放註冊', false);
    mustFail('register', { name: 'x', phone: '0966000002', birthday: '0101', lineId: 'x', gender: '女', consent: true }, '暫停');
    must('login', { phone: '0966000001', birthday: '0101' });
    ok(u.id);
  });

  test('第二階段：關閉時忽略欄位；開啟後必填、會驗證選項', function () {
    const u = reg({ phase2: { adult: '是', shirt: 'M' } });
    eq(dash(u).me.phase2.adult, '', '關閉時不保存');
    mustFail('assignLeg', { token: u.token, memberId: u.id, leg: '1' }, '還沒開放');
    setSetting('開放第二階段', true);
    mustFail('register', { name: 'p', phone: '0977000001', birthday: '0101', lineId: 'p', gender: '女', consent: true, phase2: {} }, '比賽當天是否已滿 18 歲');
    mustFail('register', { name: 'p', phone: '0977000001', birthday: '0101', lineId: 'p', gender: '女', consent: true, phase2: { adult: '是', shirt: 'XXXL' } }, '選項不正確');
    const v = reg({ phase2: { adult: '否', legPrefs: ['4', '2', '2'], distance: '10–15K' } });
    eq(dash(v).me.phase2.legPrefs, '2,4', '依選項順序、去除重複');
    must('updateProfile', { token: u.token, name: '改名', lineId: 'new_line', gender: '男', wish: '', phase2: { adult: '是', pace: '6–7 分' } });
    const me = dash(u).me;
    eq(me.name, '改名');
    eq(me.phase2.pace, '6–7 分');
  });

  test('棒次分配：第 1 棒限女性；同一棒換人時原本的人改為未分配；候補最多 2 人', function () {
    setSetting('開放第二階段', true);
    const p2 = { adult: '是' };
    const a = reg({ gender: '男', phase2: p2 }); const t = team(a);
    const f = reg({ gender: '女', phase2: p2, inviteCode: t.inviteCode });
    const g = reg({ gender: '女', phase2: p2, inviteCode: t.inviteCode });
    mustFail('assignLeg', { token: a.token, memberId: a.id, leg: '1' }, '女性');
    must('assignLeg', { token: a.token, memberId: f.id, leg: '1' });
    const r = must('assignLeg', { token: a.token, memberId: g.id, leg: '1' });
    ok(r.message.indexOf('未分配') >= 0, r.message);
    const ms = dash(a).myTeam.members;
    eq(ms.find(function (m) { return m.id === f.id; }).leg, '');
    eq(ms.find(function (m) { return m.id === g.id; }).leg, '1');
    must('assignLeg', { token: a.token, memberId: a.id, leg: '候補' });
    must('assignLeg', { token: a.token, memberId: f.id, leg: '候補' });
    const h = reg({ phase2: p2, inviteCode: t.inviteCode });
    mustFail('assignLeg', { token: a.token, memberId: h.id, leg: '候補' }, '候補最多 2 人');
    mustFail('assignLeg', { token: f.token, memberId: f.id, leg: '2' }, '只有隊長');
    ok(dash(a).myTeam.warnings.some(function (w) { return w.indexOf('還沒分配') >= 0; }));
  });

  test('隱私：其他隊伍看不到 LINE ID 與電話；回應中沒有雜湊與鹽值', function () {
    const a = reg({ lineId: 'secret_line_a', phone: '0988000001' }); team(a, '甲');
    const b = reg({ lineId: 'secret_line_b', phone: '0988000002' });
    const c = reg({ lineId: 'secret_line_c', phone: '0988000003', inviteCode: dash(a).myTeam.inviteCode });
    const viewB = JSON.stringify(dash(b));
    ok(viewB.indexOf('secret_line_a') < 0, '待安排的人不應看到隊伍成員的 LINE ID');
    ok(viewB.indexOf('0988000001') < 0 && viewB.indexOf('0988000003') < 0, '不應看到別人的電話');
    ok(viewB.indexOf('codeHash') < 0 && viewB.indexOf('salt') < 0, '不應出現雜湊欄位');
    const viewA = JSON.stringify(dash(a));
    ok(viewA.indexOf('secret_line_c') >= 0, '隊友看得到 LINE ID');
    ok(viewA.indexOf('secret_line_b') < 0, '待安排的人的 LINE ID 不公開');
    ok(viewA.indexOf('甲') >= 0);
    ok(c.id);
  });

  test('文字開頭的 = + - @ 會被去掉，避免變成 Sheet 公式', function () {
    const u = reg({ name: '=SUM(A1)小明', wish: '+1 小明', lineId: '@ming' });
    const me = dash(u).me;
    eq(me.name, 'SUM(A1)小明');
    eq(me.lineId, 'ming');
    eq(me.wish, '1 小明');
  });

  test('管理員：密碼錯誤 5 次暫停；可以建隊、設定隊長、搬人、刪除成員', function () {
    reg();
    for (let i = 0; i < 4; i++) mustFail('adminLogin', { password: 'wrong' }, '不正確');
    mustFail('adminLogin', { password: 'wrong' }, '不正確');
    mustFail('adminLogin', { password: 'test-admin-pw' }, '分鐘後再試');
    advance(16 * 60000);
    const at = adminToken();
    mustFail('adminData', { adminToken: 'A.1.x' }, '重新登入');
    const u1 = reg({ name: '甲' }); const u2 = reg({ name: '乙' }); const u3 = reg({ name: '丙' });
    must('applyJoin', { token: u3.token, teamId: team(reg()).id });
    const r = must('adminCreateTeam', { adminToken: at, teamName: '管理員分的隊', memberIds: [u2.id, u1.id, u3.id] });
    const t = r.data.teams.find(function (x) { return x.name === '管理員分的隊'; });
    eq(t.size, 3);
    eq(t.captainId, u2.id, '第一個勾選的人是隊長');
    eq(dash(u3).requests.outgoing[0].status, '已失效', '原本的申請失效');
    must('adminSetCaptain', { adminToken: at, teamId: t.id, memberId: u1.id });
    eq(dash(u1).myTeam.captainId, u1.id);
    must('adminMove', { adminToken: at, memberId: u1.id, teamId: '' });
    eq(dash(u2).myTeam.captainId, u2.id, '隊長離開後交給最早入隊的人');
    must('adminDeleteMember', { adminToken: at, memberId: u3.id });
    mustFail('dashboard', { token: u3.token }, '找不到');
    const data = must('adminData', { adminToken: at }).data;
    ok(data.members.every(function (m) { return m.id !== u3.id; }));
    ok(JSON.stringify(data).indexOf('codeHash') < 0);
  });

  test('使用者在工作表右邊自行加的欄位，更新資料時不會被清掉', function () {
    const u = reg();
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('成員');
    const lastCol = sh.getLastColumn();
    sh.insertColumnsAfter(sh.getMaxColumns(), 1);
    sh.getRange(1, lastCol + 1).setValue('自訂備註');
    sh.getRange(2, lastCol + 1).setValue('請記得繳費');
    must('updateProfile', { token: u.token, name: '新名字', lineId: 'x', gender: '女', wish: '' });
    eq(sh.getRange(2, lastCol + 1).getValue(), '請記得繳費');
  });

  test('紀錄工作表會記下異動', function () {
    const a = reg({ name: '記錄者' });
    team(a, '紀錄隊');
    const log = JSON.stringify(sheetRows('紀錄'));
    ok(log.indexOf('建立隊伍') >= 0 && log.indexOf('紀錄隊') >= 0);
  });

  // ---------- 執行 ----------
  const out = document.getElementById('out');
  let pass = 0;
  const fails = [];
  tests.forEach(function (t) {
    MockGas.reset();
    PropertiesService.getScriptProperties().setProperty('ADMIN_PASSWORD', 'test-admin-pw');
    clock = new Date('2026-10-21T10:00:00+08:00');
    seq = 0;
    try {
      t.fn();
      pass++;
      out.insertAdjacentHTML('beforeend', '<li class="pass">✅ ' + t.name + '</li>');
    } catch (e) {
      fails.push(t.name);
      const li = document.createElement('li');
      li.className = 'fail';
      li.textContent = '❌ ' + t.name + ' — ' + e.message;
      out.appendChild(li);
      console.error(t.name, e);
    }
  });
  const summary = (fails.length ? 'FAIL' : 'PASS') + '：通過 ' + pass + ' / ' + tests.length;
  document.title = summary;
  document.getElementById('summary').textContent = summary;
  document.getElementById('summary').className = fails.length ? 'fail' : 'pass';
})();
