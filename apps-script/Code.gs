/**
 * ============================================================
 *  追火車組隊媒合系統 — 後端程式（Google Apps Script）
 * ============================================================
 *
 * 安裝方式（詳見 README.md）：
 *  1. 在 Google Sheet 選「擴充功能 → Apps Script」，把這個檔案的內容全部貼上並儲存。
 *  2. 上方選擇函式「setup」，按「執行」一次（第一次會要求授權）。
 *  3. 「專案設定（齒輪）→ 指令碼屬性」新增 ADMIN_PASSWORD（管理頁密碼，至少 8 碼）。
 *  4. 「部署 → 新增部署作業 → 網頁應用程式」：執行身分「我」、存取權「所有人」。
 *
 * 網頁的開關（開放註冊、第二階段、鎖定隊伍、LINE 群組連結…）都在 Sheet 的「設定」工作表，
 * 改設定不需要修改程式，也不需要重新部署。
 *
 * 請用網頁的「管理頁」調整隊伍，不要直接修改「成員」工作表的隊伍編號／角色欄位，
 * 否則隊長、人數等資料可能對不起來。
 */

const APP_VERSION = '1.0.0';
const TZ = 'Asia/Taipei';
const TOKEN_DAYS = 30;          // 登入有效天數
const ADMIN_TOKEN_HOURS = 12;   // 管理頁登入有效小時
const MAX_LOGIN_FAILS = 5;      // 生日輸入錯誤幾次後暫停
const LOCK_MINUTES = 15;        // 暫停幾分鐘
const RECENT_DAYS = 7;          // 已處理的申請顯示幾天

const GENDERS = ['女', '男', '不透露'];
const RECRUIT_ASK = '需隊長同意';
const RECRUIT_OPEN = '開放直接加入';
const RECRUIT_CLOSED = '暫停招募';
const RECRUIT_MODES = [RECRUIT_ASK, RECRUIT_OPEN, RECRUIT_CLOSED];
const ROLE_CAPTAIN = '隊長';
const ROLE_MEMBER = '隊員';
const LEG_SUB = '候補';
const TEAM_ACTIVE = '有效';
const TEAM_DISSOLVED = '已解散';
const REQ_JOIN = '加入';    // 個人申請加入隊伍
const REQ_MERGE = '併隊';   // 整隊申請併入另一隊
const REQ_INVITE = '邀請';  // 隊長邀請待安排的人
const ST_PENDING = '待回覆';
const ST_ACCEPTED = '已同意';
const ST_DECLINED = '已婉拒';
const ST_CANCELLED = '已取消';
const ST_EXPIRED = '已失效';

/**
 * 棒次資料：2026 年（第 11 屆）新北市鐵道馬拉松接力賽。
 * 2027 年官方簡章公布後，請依官方資料修改這裡。
 */
const LEGS = [
  { no: 1, title: '女神棒', km: 5.1, route: '福容大飯店福隆 → 舊草嶺隧道（南口）', femaleOnly: true },
  { no: 2, title: '海神棒', km: 15.1, route: '舊草嶺隧道（南口）→ 福隆遊客中心', femaleOnly: false },
  { no: 3, title: '安神棒', km: 5.9, route: '福隆遊客中心 → 貢寮國小', femaleOnly: false },
  { no: 4, title: '山神棒', km: 9.7, route: '貢寮國小 → 牡丹車站', femaleOnly: false },
  { no: 5, title: '風神棒', km: 4.0, route: '牡丹車站 → 雙溪高中', femaleOnly: false },
  { no: 6, title: '恍神棒', km: 5.8, route: '雙溪高中 → 貢寮國中', femaleOnly: false },
  { no: 7, title: '迎神棒', km: 5.4, route: '貢寮國中 → 福容大飯店福隆', femaleOnly: false },
];

/**
 * 第二階段欄位（「設定」工作表勾選「開放第二階段」後才會出現在網頁上）。
 * share：true = 所有已報名的人看得到（方便找隊友）；false = 只有同隊隊友看得到。
 * 2027 年規定公布後，可以在這裡增減選項。key 必須對應下方 SCHEMA.members 的欄位。
 */
const PHASE2_FIELDS = [
  {
    key: 'adult', label: '比賽當天是否已滿 18 歲', type: 'select', required: true, share: false,
    options: [{ value: '是', label: '是' }, { value: '否', label: '否（12–17 歲，正式報名需要家長同意書）' }],
    help: '2026 年規定：須年滿 12 歲；未滿 18 歲要繳交家長同意切結書。',
  },
  {
    key: 'legPrefs', label: '想跑的棒次（可複選）', type: 'multi', required: false, share: true,
    options: LEGS.map(function (l) {
      return { value: String(l.no), label: '第' + l.no + '棒 ' + l.km.toFixed(1) + 'K' + (l.femaleOnly ? '（限女性）' : '') };
    }).concat([{ value: '都可以', label: '都可以' }]),
  },
  { key: 'distance', label: '可以舒服跑完的距離', type: 'select', required: false, share: true, options: ['5K 以內', '5–10K', '10–15K', '15K 以上'] },
  { key: 'pace', label: '大約配速（每公里）', type: 'select', required: false, share: true, options: ['5 分以內', '5–6 分', '6–7 分', '7–8 分', '8 分以上', '不確定'] },
  { key: 'division', label: '偏好組別', type: 'select', required: false, share: true, options: ['競賽組', '企業團體競賽組', '變裝組', '都可以'] },
  { key: 'substitute', label: '願意當候補嗎', type: 'select', required: false, share: true, options: ['願意', '不願意'] },
  { key: 'volunteerCaptain', label: '願意代表全隊報名、繳費嗎', type: 'select', required: false, share: false, options: ['願意', '不願意'] },
  {
    key: 'shirt', label: '跑衣尺寸', type: 'select', required: false, share: false,
    options: ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '未定'],
    help: '官方尺寸表尚未公布，可以先填大概的尺寸，之後再修改。',
  },
];

const SETTINGS_SHEET = '設定';
const DEFAULT_SETTINGS = [
  // [設定項目, 預設值, 說明]
  ['活動名稱', '2027 追火車組隊媒合', '顯示在網頁最上方的標題'],
  ['公告', '2027 年官方資訊尚未公布，目前先登記基本資料與組隊。', '顯示在網頁上方的公告（可以留白）'],
  ['開放註冊', true, '取消勾選後，新的人不能報名（已報名的人仍可登入查詢）'],
  ['開放第二階段', false, '勾選後，網頁會出現第二階段欄位（棒次、配速…）與棒次分配'],
  ['鎖定隊伍', false, '勾選後，一般使用者不能建隊、加入、離開或換隊；只有管理頁可以調整'],
  ['每隊正式人數', 7, '2026 年規定為 7 人'],
  ['每隊候補人數', 2, '2026 年規定為 2 人'],
  ['最多同時申請數', 3, '一個人（或一隊）同時最多能有幾個「待回覆」的申請'],
  ['LINE群組連結', '', 'LINE 群組邀請連結（https://line.me/ti/g/...），只有已報名的人看得到'],
  ['管理員聯絡方式', '請在 LINE 群組聯絡管理員', '忘記生日驗證碼、需要協助時的聯絡方式'],
  ['資料保存期限', '活動結束後 3 個月內刪除', '顯示在個資告知事項'],
];

/** 工作表欄位：[程式用名稱, 工作表標題]。可以在最右邊自行加欄位，程式不會動到。 */
const SCHEMA = {
  members: {
    sheet: '成員',
    cols: [
      ['id', '成員編號'], ['name', '姓名'], ['phone', '電話'], ['lineId', 'LINE ID'], ['gender', '性別'],
      ['teamId', '隊伍編號'], ['role', '角色'], ['leg', '棒次'], ['wish', '希望同組'],
      ['adult', '已滿18歲'], ['legPrefs', '想跑棒次'], ['distance', '可跑距離'], ['pace', '配速'],
      ['division', '偏好組別'], ['substitute', '願意當候補'], ['volunteerCaptain', '願意代表報名'], ['shirt', '跑衣尺寸'],
      ['joinedAt', '入隊時間'], ['createdAt', '報名時間'], ['updatedAt', '更新時間'], ['consentAt', '同意個資時間'],
      ['adminNote', '管理備註'], ['codeHash', '驗證碼雜湊'], ['salt', '鹽值'], ['failCount', '登入失敗次數'], ['lockUntil', '暫停登入到'],
    ],
  },
  teams: {
    sheet: '隊伍',
    cols: [
      ['id', '隊伍編號'], ['name', '隊名'], ['captainId', '隊長編號'], ['inviteCode', '邀請碼'], ['recruit', '招募方式'],
      ['intro', '隊伍介紹'], ['status', '狀態'], ['createdAt', '建立時間'], ['updatedAt', '更新時間'],
    ],
  },
  requests: {
    sheet: '申請',
    cols: [
      ['id', '申請編號'], ['type', '類型'], ['fromMemberId', '申請人編號'], ['fromTeamId', '來源隊伍'], ['toTeamId', '目標隊伍'],
      ['toMemberId', '受邀成員'], ['message', '留言'], ['status', '狀態'], ['createdAt', '建立時間'], ['decidedAt', '處理時間'],
      ['decidedBy', '處理人'], ['note', '備註'],
    ],
  },
  log: {
    sheet: '紀錄',
    cols: [['time', '時間'], ['action', '動作'], ['actor', '執行者'], ['detail', '內容']],
  },
};

/** 對外提供的操作。lock = 會寫入資料，需要排隊執行；auth = 需要登入。 */
const ACTIONS = {
  config: { fn: actConfig_ },
  register: { lock: true, fn: actRegister_ },
  login: { lock: true, fn: actLogin_ },
  dashboard: { auth: 'member', fn: actDashboard_ },
  updateProfile: { auth: 'member', lock: true, fn: actUpdateProfile_ },
  createTeam: { auth: 'member', lock: true, fn: actCreateTeam_ },
  joinByCode: { auth: 'member', lock: true, fn: actJoinByCode_ },
  applyJoin: { auth: 'member', lock: true, fn: actApplyJoin_ },
  applyMerge: { auth: 'member', lock: true, fn: actApplyMerge_ },
  invite: { auth: 'member', lock: true, fn: actInvite_ },
  respond: { auth: 'member', lock: true, fn: actRespond_ },
  cancelRequest: { auth: 'member', lock: true, fn: actCancelRequest_ },
  leaveTeam: { auth: 'member', lock: true, fn: actLeaveTeam_ },
  updateTeam: { auth: 'member', lock: true, fn: actUpdateTeam_ },
  regenerateInvite: { auth: 'member', lock: true, fn: actRegenerateInvite_ },
  transferCaptain: { auth: 'member', lock: true, fn: actTransferCaptain_ },
  removeMember: { auth: 'member', lock: true, fn: actRemoveMember_ },
  assignLeg: { auth: 'member', lock: true, fn: actAssignLeg_ },
  adminLogin: { lock: true, fn: actAdminLogin_ },
  adminData: { auth: 'admin', fn: actAdminData_ },
  adminMove: { auth: 'admin', lock: true, fn: actAdminMove_ },
  adminCreateTeam: { auth: 'admin', lock: true, fn: actAdminCreateTeam_ },
  adminSetCaptain: { auth: 'admin', lock: true, fn: actAdminSetCaptain_ },
  adminResetCode: { auth: 'admin', lock: true, fn: actAdminResetCode_ },
  adminDeleteMember: { auth: 'admin', lock: true, fn: actAdminDeleteMember_ },
};

// ============================================================
//  入口
// ============================================================

/** 第一次安裝時手動執行一次：建立工作表、設定與金鑰。 */
function setup() {
  resetRequest_();
  Object.keys(SCHEMA).forEach(function (kind) { table_(kind); });
  settings_();
  secret_();
  SpreadsheetApp.flush();
  const pw = PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD');
  const msg = '初始化完成。' + (pw ? '' : '提醒：還沒設定 ADMIN_PASSWORD（管理頁密碼），請到「專案設定 → 指令碼屬性」新增。');
  console.log(msg);
  return msg;
}

function doGet() {
  return json_({ ok: true, message: '追火車組隊媒合 API 運作中', version: APP_VERSION });
}

function doPost(e) {
  resetRequest_();
  let body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: '資料格式錯誤' });
  }
  return json_(handle_(body || {}));
}

function handle_(body) {
  const def = ACTIONS[String(body.action || '')];
  if (!def) return { ok: false, error: '不支援的操作' };
  let lock = null;
  try {
    if (def.lock) {
      lock = LockService.getScriptLock();
      try {
        lock.waitLock(20000);
      } catch (err) {
        lock = null;
        return { ok: false, error: '目前使用的人比較多，請稍後再試一次' };
      }
    }
    let actor = null;
    if (def.auth === 'member') actor = authMember_(body.token);
    if (def.auth === 'admin') authAdmin_(body.adminToken);
    const result = def.fn(body, actor) || {};
    result.ok = true;
    return result;
  } catch (err) {
    if (err && err.isUserError) return { ok: false, error: err.message, code: err.code || '' };
    console.error(err && err.stack ? err.stack : err);
    return { ok: false, error: '系統發生錯誤，請稍後再試。（' + (err && err.message ? err.message : err) + '）' };
  } finally {
    if (lock) {
      SpreadsheetApp.flush();
      lock.releaseLock();
    }
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
//  公開操作
// ============================================================

function actConfig_(body) {
  const out = { config: publicConfig_() };
  if (body.inviteCode) {
    const team = teamByCode_(body.inviteCode);
    if (team) {
      const st = teamStats_(teamMembers_(team.id), capacity_());
      out.invite = { teamName: team.name, size: st.size, capacity: st.capacity, full: st.full, recruit: team.recruit };
    } else {
      out.inviteError = '邀請碼無效，或隊伍已經解散';
    }
  }
  return out;
}

function actRegister_(body) {
  const s = settings_();
  if (!s.registrationOpen) fail_('目前暫停新報名');
  const members = table_('members');
  const name = text_(body.name, '姓名', 20, true);
  const phone = phone_(body.phone);
  const code = birthday_(body.birthday);
  const lineId = text_(body.lineId, 'LINE ID', 30, true);
  const gender = choice_(body.gender, GENDERS, '性別');
  const wish = text_(body.wish, '希望同組的人', 100, false);
  if (body.consent !== true) fail_('請先閱讀並勾選同意個資告知事項');
  if (members.rows.some(function (m) { return m.phone === phone; })) {
    fail_('這支手機號碼已經報名過了，請回首頁按「我已報名」查詢', 'DUPLICATE');
  }
  const t = nowStr_();
  const salt = newSalt_();
  const m = {
    id: nextId_(members.rows, 'M', 4), name: name, phone: phone, lineId: lineId, gender: gender, wish: wish,
    teamId: '', role: '', leg: '', joinedAt: '', createdAt: t, updatedAt: t, consentAt: t, adminNote: '',
    codeHash: hashCode_(salt, code), salt: salt, failCount: '0', lockUntil: '',
  };
  PHASE2_FIELDS.forEach(function (f) { m[f.key] = ''; });
  if (s.phase2Open) readPhase2_(body.phase2 || {}, m);
  appendRow_('members', m);
  log_('報名', m, '');

  let message = '報名完成！';
  if (body.inviteCode) {
    try {
      const team = joinByCodeCore_(m, body.inviteCode);
      message = '報名完成，已經加入「' + team.name + '」！';
    } catch (err) {
      if (!err.isUserError) throw err;
      message = '報名完成，但沒辦法加入隊伍：' + err.message + '。你目前在待安排區。';
    }
  }
  return { token: makeToken_(m), message: message, dashboard: dashboard_(m) };
}

function actLogin_(body) {
  const s = settings_();
  const phone = phone_(body.phone);
  const code = String(body.birthday == null ? '' : body.birthday).trim();
  const generic = '手機號碼或生日不正確。如果忘記當初填的生日，' + s.adminContact;
  const m = table_('members').rows.find(function (x) { return x.phone === phone; });
  if (!m) fail_(generic);
  const now = now_();
  const lockUntil = parseTime_(m.lockUntil);
  if (lockUntil && lockUntil > now) {
    fail_('錯誤次數太多，請 ' + Math.ceil((lockUntil - now) / 60000) + ' 分鐘後再試');
  }
  if (!/^\d{4}$/.test(code) || hashCode_(m.salt, code) !== m.codeHash) {
    const fails = (Number(m.failCount) || 0) + 1;
    if (fails >= MAX_LOGIN_FAILS) {
      m.failCount = '0';
      m.lockUntil = fmtTime_(new Date(now.getTime() + LOCK_MINUTES * 60000));
      saveRow_('members', m);
      log_('登入暫停', m, '生日連續輸入錯誤 ' + MAX_LOGIN_FAILS + ' 次');
      fail_('錯誤次數太多，已暫停登入 ' + LOCK_MINUTES + ' 分鐘');
    }
    m.failCount = String(fails);
    saveRow_('members', m);
    fail_(generic + '（還可以再試 ' + (MAX_LOGIN_FAILS - fails) + ' 次）');
  }
  if (m.failCount !== '0' || m.lockUntil) {
    m.failCount = '0';
    m.lockUntil = '';
    saveRow_('members', m);
  }
  return { token: makeToken_(m), dashboard: dashboard_(m) };
}

// ============================================================
//  已登入成員的操作
// ============================================================

function actDashboard_(body, me) {
  return { dashboard: dashboard_(me) };
}

function actUpdateProfile_(body, me) {
  const s = settings_();
  me.name = text_(body.name, '姓名', 20, true);
  me.lineId = text_(body.lineId, 'LINE ID', 30, true);
  me.gender = choice_(body.gender, GENDERS, '性別');
  me.wish = text_(body.wish, '希望同組的人', 100, false);
  if (s.phase2Open && body.phase2) readPhase2_(body.phase2, me);
  me.updatedAt = nowStr_();
  saveRow_('members', me);
  log_('修改資料', me, '');
  return { message: '已儲存你的資料', dashboard: dashboard_(me) };
}

function actCreateTeam_(body, me) {
  ensureUnlocked_();
  if (teamOf_(me)) fail_('你已經在隊伍裡了，要先離開目前的隊伍才能建立新隊伍');
  const name = teamName_(body.teamName, '');
  const recruit = choice_(body.recruit || RECRUIT_ASK, RECRUIT_MODES, '招募方式');
  const intro = text_(body.intro, '隊伍介紹', 100, false);
  const team = createTeamRow_(name, me.id, recruit, intro);
  setMembership_(me, team, ROLE_CAPTAIN);
  expireMemberRequests_(me, '已自行建立隊伍');
  log_('建立隊伍', me, name);
  return { message: '已建立「' + name + '」！把邀請連結傳給朋友吧', dashboard: dashboard_(me) };
}

function actJoinByCode_(body, me) {
  const team = joinByCodeCore_(me, body.inviteCode);
  return { message: '已加入「' + team.name + '」！', dashboard: dashboard_(me) };
}

function joinByCodeCore_(me, code) {
  ensureUnlocked_();
  if (teamOf_(me)) fail_('你已經在隊伍裡了，要先離開目前的隊伍才能加入別隊');
  const team = teamByCode_(code);
  if (!team) fail_('邀請碼無效，或隊伍已經解散');
  if (team.recruit === RECRUIT_CLOSED) fail_('「' + team.name + '」目前暫停招募');
  joinTeam_(me, team, '邀請連結');
  return team;
}

function actApplyJoin_(body, me) {
  ensureUnlocked_();
  const s = settings_();
  if (teamOf_(me)) fail_('你已經在隊伍裡了，要先離開目前的隊伍才能申請別隊');
  const team = activeTeam_(body.teamId);
  if (team.recruit === RECRUIT_CLOSED) fail_('「' + team.name + '」目前暫停招募');
  if (teamStats_(teamMembers_(team.id), capacity_()).full) fail_('「' + team.name + '」已經額滿');
  const pending = pendingRequests_();
  const invite = pending.find(function (r) { return r.type === REQ_INVITE && r.toMemberId === me.id && r.fromTeamId === team.id; });
  if (invite) {
    decide_(invite, ST_ACCEPTED, me, '');
    joinTeam_(me, team, '接受邀請');
    return { message: '「' + team.name + '」本來就邀請過你，已直接加入！', dashboard: dashboard_(me) };
  }
  if (team.recruit === RECRUIT_OPEN) {
    joinTeam_(me, team, '直接加入');
    return { message: '已加入「' + team.name + '」！', dashboard: dashboard_(me) };
  }
  if (pending.some(function (r) { return r.type === REQ_JOIN && r.fromMemberId === me.id && r.toTeamId === team.id; })) {
    fail_('你已經申請過這個隊伍了，請等隊長回覆');
  }
  const count = pending.filter(function (r) { return r.type === REQ_JOIN && r.fromMemberId === me.id; }).length;
  if (count >= s.maxPending) fail_('同時最多只能有 ' + s.maxPending + ' 個等待回覆的申請，請先取消其中一個');
  const message = text_(body.message, '留言', 100, false);
  createRequest_({ type: REQ_JOIN, fromMemberId: me.id, toTeamId: team.id, message: message });
  log_('申請加入', me, team.name);
  return { message: '已送出申請，等「' + team.name + '」的隊長同意', dashboard: dashboard_(me) };
}

function actApplyMerge_(body, me) {
  ensureUnlocked_();
  const s = settings_();
  const cap = capacity_();
  const myTeam = captainTeam_(me);
  const target = activeTeam_(body.teamId);
  if (target.id === myTeam.id) fail_('不能併入自己的隊伍');
  if (target.recruit === RECRUIT_CLOSED) fail_('「' + target.name + '」目前暫停招募');
  const a = teamMembers_(myTeam.id).length;
  const b = teamMembers_(target.id).length;
  if (a + b > cap.total) fail_('兩隊合計 ' + (a + b) + ' 人，超過每隊上限 ' + cap.total + ' 人');
  const pending = pendingRequests_();
  if (pending.some(function (r) { return r.type === REQ_MERGE && r.fromTeamId === myTeam.id && r.toTeamId === target.id; })) {
    fail_('已經申請過併入這一隊了，請等對方隊長回覆');
  }
  const count = pending.filter(function (r) { return r.type === REQ_MERGE && r.fromTeamId === myTeam.id; }).length;
  if (count >= s.maxPending) fail_('同時最多只能有 ' + s.maxPending + ' 個等待回覆的併隊申請，請先取消其中一個');
  const message = text_(body.message, '留言', 100, false);
  createRequest_({ type: REQ_MERGE, fromMemberId: me.id, fromTeamId: myTeam.id, toTeamId: target.id, message: message });
  log_('申請併隊', me, myTeam.name + ' → ' + target.name);
  return { message: '已送出併隊申請，等「' + target.name + '」的隊長同意', dashboard: dashboard_(me) };
}

function actInvite_(body, me) {
  ensureUnlocked_();
  const myTeam = captainTeam_(me);
  const target = memberById_(body.memberId);
  if (!target) fail_('找不到這位成員');
  if (target.id === me.id) fail_('不能邀請自己');
  if (teamOf_(target)) fail_(target.name + ' 已經有隊伍了');
  if (teamStats_(teamMembers_(myTeam.id), capacity_()).full) fail_('你的隊伍已經額滿');
  const pending = pendingRequests_();
  const applied = pending.find(function (r) { return r.type === REQ_JOIN && r.fromMemberId === target.id && r.toTeamId === myTeam.id; });
  if (applied) {
    decide_(applied, ST_ACCEPTED, me, '');
    joinTeam_(target, myTeam, '隊長同意');
    return { message: target.name + ' 本來就申請過你們隊，已直接加入！', dashboard: dashboard_(me) };
  }
  if (pending.some(function (r) { return r.type === REQ_INVITE && r.fromTeamId === myTeam.id && r.toMemberId === target.id; })) {
    fail_('已經邀請過 ' + target.name + ' 了，請等對方回覆');
  }
  const message = text_(body.message, '留言', 100, false);
  createRequest_({ type: REQ_INVITE, fromMemberId: me.id, fromTeamId: myTeam.id, toMemberId: target.id, message: message });
  log_('邀請成員', me, myTeam.name + ' → ' + target.name);
  return { message: '已邀請 ' + target.name + '，對方登入後就會看到', dashboard: dashboard_(me) };
}

function actRespond_(body, me) {
  const r = requestById_(body.requestId);
  if (!r || r.status !== ST_PENDING) fail_('這個申請已經處理過了，請重新整理');
  const myTeam = teamOf_(me);
  if (!canRespond_(r, me, myTeam)) fail_('只有被邀請的人或隊長可以回覆這個申請');
  if (body.accept !== true) {
    decide_(r, ST_DECLINED, me, '');
    log_('婉拒' + r.type, me, r.id);
    return { message: '已婉拒', dashboard: dashboard_(me) };
  }
  ensureUnlocked_();
  const cap = capacity_();
  let reason = '';
  let message = '';
  if (r.type === REQ_JOIN) {
    const applicant = memberById_(r.fromMemberId);
    if (!applicant) reason = '申請人已經不在名單上';
    else if (teamOf_(applicant)) reason = applicant.name + ' 已經加入其他隊伍';
    else if (teamMembers_(myTeam.id).length >= cap.total) reason = '你的隊伍已經額滿';
    if (!reason) {
      decide_(r, ST_ACCEPTED, me, '');
      joinTeam_(applicant, myTeam, '隊長同意');
      message = '已同意，' + applicant.name + ' 加入了隊伍';
    }
  } else if (r.type === REQ_MERGE) {
    const src = teamById_(r.fromTeamId);
    if (!src || src.status !== TEAM_ACTIVE) reason = '對方隊伍已經解散';
    else if (teamMembers_(src.id).length + teamMembers_(myTeam.id).length > cap.total) reason = '兩隊合計超過每隊上限 ' + cap.total + ' 人';
    if (!reason) {
      decide_(r, ST_ACCEPTED, me, '');
      const moved = teamMembers_(src.id).length;
      mergeTeams_(src, myTeam, me);
      message = '已同意，「' + src.name + '」的 ' + moved + ' 人併入你們隊';
    }
  } else if (r.type === REQ_INVITE) {
    const team = teamById_(r.fromTeamId);
    if (teamOf_(me)) reason = '你已經在隊伍裡了';
    else if (!team || team.status !== TEAM_ACTIVE) reason = '對方隊伍已經解散';
    else if (teamMembers_(team.id).length >= cap.total) reason = '對方隊伍已經額滿';
    if (!reason) {
      decide_(r, ST_ACCEPTED, me, '');
      joinTeam_(me, team, '接受邀請');
      message = '已加入「' + team.name + '」！';
    }
  }
  if (reason) {
    decide_(r, ST_EXPIRED, me, reason);
    return { message: '這個申請已失效：' + reason, dashboard: dashboard_(me) };
  }
  return { message: message, dashboard: dashboard_(me) };
}

function actCancelRequest_(body, me) {
  const r = requestById_(body.requestId);
  if (!r || r.status !== ST_PENDING) fail_('這個申請已經處理過了，請重新整理');
  if (!canCancel_(r, me, teamOf_(me))) fail_('只有送出申請的人可以取消');
  decide_(r, ST_CANCELLED, me, '');
  log_('取消' + r.type, me, r.id);
  return { message: '已取消', dashboard: dashboard_(me) };
}

function actLeaveTeam_(body, me) {
  ensureUnlocked_();
  const team = teamOf_(me);
  if (!team) fail_('你目前沒有隊伍');
  leaveTeam_(me, me, '自行離開');
  return { message: '已離開「' + team.name + '」，你目前在待安排區', dashboard: dashboard_(me) };
}

function actUpdateTeam_(body, me) {
  const team = captainTeam_(me);
  team.name = teamName_(body.teamName, team.id);
  team.recruit = choice_(body.recruit, RECRUIT_MODES, '招募方式');
  team.intro = text_(body.intro, '隊伍介紹', 100, false);
  team.updatedAt = nowStr_();
  saveRow_('teams', team);
  log_('修改隊伍', me, team.name + '／' + team.recruit);
  return { message: '已更新隊伍資料', dashboard: dashboard_(me) };
}

function actRegenerateInvite_(body, me) {
  const team = captainTeam_(me);
  team.inviteCode = newInviteCode_();
  team.updatedAt = nowStr_();
  saveRow_('teams', team);
  log_('重新產生邀請碼', me, team.name);
  return { message: '已產生新的邀請連結，舊的連結不能再用了', dashboard: dashboard_(me) };
}

function actTransferCaptain_(body, me) {
  const team = captainTeam_(me);
  const target = memberById_(body.memberId);
  if (!target || target.teamId !== team.id) fail_('對方不是你們隊的隊員');
  if (target.id === me.id) fail_('你已經是隊長了');
  setCaptain_(team, target);
  log_('轉移隊長', me, team.name + ' → ' + target.name);
  return { message: '已把隊長交給 ' + target.name, dashboard: dashboard_(me) };
}

function actRemoveMember_(body, me) {
  ensureUnlocked_();
  const team = captainTeam_(me);
  const target = memberById_(body.memberId);
  if (!target || target.teamId !== team.id) fail_('對方不是你們隊的隊員');
  if (target.id === me.id) fail_('要離開隊伍請按「離開隊伍」');
  leaveTeam_(target, me, '被隊長移出');
  return { message: '已把 ' + target.name + ' 移出隊伍', dashboard: dashboard_(me) };
}

function actAssignLeg_(body, me) {
  if (!settings_().phase2Open) fail_('第二階段還沒開放');
  const cap = capacity_();
  const team = captainTeam_(me);
  const target = memberById_(body.memberId);
  if (!target || target.teamId !== team.id) fail_('對方不是你們隊的隊員');
  const leg = String(body.leg == null ? '' : body.leg).trim();
  const legDef = LEGS.find(function (l) { return String(l.no) === leg; });
  if (leg && leg !== LEG_SUB && !legDef) fail_('棒次不正確');
  if (legDef && legDef.femaleOnly && target.gender !== '女') fail_('第' + legDef.no + '棒必須由女性跑');
  const mates = teamMembers_(team.id);
  if (leg === LEG_SUB) {
    const subs = mates.filter(function (m) { return m.id !== target.id && m.leg === LEG_SUB; }).length;
    if (subs >= cap.sub) fail_('候補最多 ' + cap.sub + ' 人');
  }
  let note = '';
  if (legDef) {
    mates.forEach(function (m) {
      if (m.id !== target.id && m.leg === leg) {
        m.leg = '';
        m.updatedAt = nowStr_();
        saveRow_('members', m);
        note = '（原本的 ' + m.name + ' 改為未分配）';
      }
    });
  }
  target.leg = leg;
  target.updatedAt = nowStr_();
  saveRow_('members', target);
  log_('分配棒次', me, target.name + '：' + (leg || '未分配'));
  return { message: target.name + '：' + legText_(leg) + note, dashboard: dashboard_(me) };
}

// ============================================================
//  管理頁操作
// ============================================================

function actAdminLogin_(body) {
  const props = PropertiesService.getScriptProperties();
  const pw = props.getProperty('ADMIN_PASSWORD');
  if (!pw || pw.length < 8) {
    fail_('還沒設定管理密碼：請在 Apps Script「專案設定 → 指令碼屬性」新增 ADMIN_PASSWORD（至少 8 碼）');
  }
  const now = now_().getTime();
  let st = {};
  try { st = JSON.parse(props.getProperty('ADMIN_LOGIN_STATE') || '{}'); } catch (err) { st = {}; }
  if (st.lockUntil && st.lockUntil > now) {
    fail_('錯誤次數太多，請 ' + Math.ceil((st.lockUntil - now) / 60000) + ' 分鐘後再試');
  }
  if (String(body.password || '') !== pw) {
    st.fails = (st.fails || 0) + 1;
    if (st.fails >= MAX_LOGIN_FAILS) {
      st.fails = 0;
      st.lockUntil = now + LOCK_MINUTES * 60000;
    }
    props.setProperty('ADMIN_LOGIN_STATE', JSON.stringify(st));
    log_('管理員登入失敗', '管理員', '');
    fail_('管理密碼不正確');
  }
  props.deleteProperty('ADMIN_LOGIN_STATE');
  log_('管理員登入', '管理員', '');
  const exp = now + ADMIN_TOKEN_HOURS * 3600000;
  return { adminToken: 'A.' + exp + '.' + sign_('admin.' + exp + '.' + sha256Hex_(pw)), data: adminData_() };
}

function actAdminData_() {
  return { data: adminData_() };
}

function actAdminMove_(body) {
  const m = memberById_(body.memberId);
  if (!m) fail_('找不到這位成員');
  const teamId = String(body.teamId || '');
  const current = teamOf_(m);
  if ((current ? current.id : '') === teamId) fail_('沒有變更');
  let target = null;
  if (teamId) {
    target = activeTeam_(teamId);
    if (teamMembers_(target.id).length >= capacity_().total) fail_('「' + target.name + '」已經額滿');
  }
  if (current) leaveTeam_(m, '管理員', '管理員調整');
  if (target) joinTeam_(m, target, '管理員調整');
  return { message: m.name + ' → ' + (target ? target.name : '待安排'), data: adminData_() };
}

function actAdminCreateTeam_(body) {
  const cap = capacity_();
  const ids = Array.isArray(body.memberIds) ? body.memberIds.map(String) : [];
  const unique = ids.filter(function (id, i) { return ids.indexOf(id) === i; });
  if (!unique.length) fail_('請至少勾選 1 位成員');
  if (unique.length > cap.total) fail_('每隊最多 ' + cap.total + ' 人');
  const list = unique.map(function (id) {
    const m = memberById_(id);
    if (!m) fail_('找不到成員 ' + id);
    return m;
  });
  const name = teamName_(body.teamName, '');
  const team = createTeamRow_(name, list[0].id, RECRUIT_ASK, '');
  list.forEach(function (m) {
    if (teamOf_(m)) leaveTeam_(m, '管理員', '管理員重新分隊');
    joinTeam_(m, team, '管理員分隊');
  });
  setCaptain_(team, list[0]);
  log_('管理員建立隊伍', '管理員', name + '：' + list.map(function (m) { return m.name; }).join('、'));
  return { message: '已建立「' + name + '」（' + list.length + ' 人）', data: adminData_() };
}

function actAdminSetCaptain_(body) {
  const team = activeTeam_(body.teamId);
  const m = memberById_(body.memberId);
  if (!m || m.teamId !== team.id) fail_('對方不是這一隊的隊員');
  setCaptain_(team, m);
  log_('管理員設定隊長', '管理員', team.name + '：' + m.name);
  return { message: '「' + team.name + '」的隊長改為 ' + m.name, data: adminData_() };
}

function actAdminResetCode_(body) {
  const m = memberById_(body.memberId);
  if (!m) fail_('找不到這位成員');
  const code = birthday_(body.birthday);
  m.salt = newSalt_();
  m.codeHash = hashCode_(m.salt, code);
  m.failCount = '0';
  m.lockUntil = '';
  m.updatedAt = nowStr_();
  saveRow_('members', m);
  log_('管理員重設生日驗證碼', '管理員', m.id + ' ' + m.name);
  return { message: '已重設 ' + m.name + ' 的生日驗證碼', data: adminData_() };
}

function actAdminDeleteMember_(body) {
  const m = memberById_(body.memberId);
  if (!m) fail_('找不到這位成員');
  if (teamOf_(m)) leaveTeam_(m, '管理員', '資料刪除');
  expireMemberRequests_(m, '成員資料已刪除');
  deleteRow_('members', m);
  log_('管理員刪除成員', '管理員', m.id + ' ' + m.name + ' ' + maskPhone_(m.phone));
  return { message: '已刪除 ' + m.name + ' 的資料', data: adminData_() };
}

function adminData_() {
  const cap = capacity_();
  const ctx = context_(null);
  const now = now_();
  const members = ctx.members.map(function (m) {
    const team = ctx.teamById[m.teamId];
    const lock = parseTime_(m.lockUntil);
    const v = {
      id: m.id, name: m.name, phone: m.phone, lineId: m.lineId, gender: m.gender, wish: m.wish,
      teamId: team && team.status === TEAM_ACTIVE ? team.id : '', role: m.role, leg: m.leg,
      createdAt: m.createdAt, updatedAt: m.updatedAt, adminNote: m.adminNote, loginLocked: !!(lock && lock > now),
    };
    PHASE2_FIELDS.forEach(function (f) { v[f.key] = m[f.key]; });
    return v;
  });
  const teams = ctx.activeTeams.map(function (t) {
    const list = ctx.byTeam[t.id] || [];
    const v = { id: t.id, name: t.name, captainId: t.captainId, inviteCode: t.inviteCode, recruit: t.recruit, intro: t.intro, createdAt: t.createdAt };
    Object.assign(v, teamStats_(list, cap));
    v.warnings = teamWarnings_(list, cap);
    return v;
  });
  const pendingCount = ctx.requests.filter(function (r) { return r.status === ST_PENDING; }).length;
  return { config: publicConfig_(), members: members, teams: teams, pendingCount: pendingCount, serverTime: nowStr_() };
}

// ============================================================
//  隊伍異動（只在已取得鎖定時呼叫）
// ============================================================

function createTeamRow_(name, captainId, recruit, intro) {
  const t = nowStr_();
  const team = {
    id: nextId_(table_('teams').rows, 'T', 3), name: name, captainId: captainId, inviteCode: newInviteCode_(),
    recruit: recruit, intro: intro, status: TEAM_ACTIVE, createdAt: t, updatedAt: t,
  };
  appendRow_('teams', team);
  return team;
}

function setMembership_(m, team, role) {
  const t = nowStr_();
  m.teamId = team ? team.id : '';
  m.role = team ? role : '';
  m.leg = '';
  m.joinedAt = team ? t : '';
  m.updatedAt = t;
  saveRow_('members', m);
}

/** 加入隊伍：檢查人數 → 寫入 → 讓這個人的其他申請失效 → 額滿時讓其他人的申請失效。 */
function joinTeam_(m, team, how) {
  const cap = capacity_();
  if (teamOf_(m)) fail_(m.name + ' 已經在其他隊伍了');
  const size = teamMembers_(team.id).length;
  if (size >= cap.total) fail_('「' + team.name + '」已經額滿（' + cap.total + ' 人）');
  setMembership_(m, team, ROLE_MEMBER);
  expireMemberRequests_(m, '已加入「' + team.name + '」');
  if (size + 1 >= cap.total) expireTeamRequests_(team, '隊伍已額滿');
  log_('加入隊伍', m, team.name + '（' + how + '）');
}

/** 離開隊伍：隊長離開時交給最早入隊的人；最後一人離開時解散。 */
function leaveTeam_(m, actor, reason) {
  const team = teamOf_(m);
  const wasCaptain = !!team && team.captainId === m.id;
  setMembership_(m, null, '');
  if (!team) return;
  const rest = teamMembers_(team.id).sort(byJoined_);
  if (!rest.length) {
    dissolveTeam_(team, '最後一位隊員離開');
  } else if (wasCaptain) {
    setCaptain_(team, rest[0]);
  }
  log_('離開隊伍', actor, m.name + ' 離開「' + team.name + '」（' + reason + '）');
}

function mergeTeams_(src, dst, actor) {
  teamMembers_(src.id).forEach(function (m) { setMembership_(m, dst, ROLE_MEMBER); });
  dissolveTeam_(src, '已併入「' + dst.name + '」');
  if (teamMembers_(dst.id).length >= capacity_().total) expireTeamRequests_(dst, '隊伍已額滿');
  log_('併隊', actor, src.name + ' → ' + dst.name);
}

function dissolveTeam_(team, reason) {
  team.status = TEAM_DISSOLVED;
  team.updatedAt = nowStr_();
  saveRow_('teams', team);
  pendingRequests_().forEach(function (r) {
    if (r.toTeamId === team.id || r.fromTeamId === team.id) decide_(r, ST_EXPIRED, '系統', '隊伍已解散（' + reason + '）');
  });
  log_('解散隊伍', '系統', team.name + '（' + reason + '）');
}

function setCaptain_(team, m) {
  teamMembers_(team.id).forEach(function (x) {
    const role = x.id === m.id ? ROLE_CAPTAIN : ROLE_MEMBER;
    if (x.role !== role) {
      x.role = role;
      x.updatedAt = nowStr_();
      saveRow_('members', x);
    }
  });
  team.captainId = m.id;
  team.updatedAt = nowStr_();
  saveRow_('teams', team);
}

/** 這個人送出的加入申請、收到的邀請 → 失效。 */
function expireMemberRequests_(m, note) {
  pendingRequests_().forEach(function (r) {
    if ((r.type === REQ_JOIN && r.fromMemberId === m.id) || (r.type === REQ_INVITE && r.toMemberId === m.id)) {
      decide_(r, ST_EXPIRED, '系統', note);
    }
  });
}

/** 隊伍額滿：別人申請加入／併入、這隊發出的邀請與併隊申請 → 失效。 */
function expireTeamRequests_(team, note) {
  pendingRequests_().forEach(function (r) {
    if (r.toTeamId === team.id || r.fromTeamId === team.id) decide_(r, ST_EXPIRED, '系統', note);
  });
}

function createRequest_(fields) {
  const r = {
    id: nextId_(table_('requests').rows, 'R', 5), type: '', fromMemberId: '', fromTeamId: '', toTeamId: '',
    toMemberId: '', message: '', status: ST_PENDING, createdAt: nowStr_(), decidedAt: '', decidedBy: '', note: '',
  };
  Object.keys(fields).forEach(function (k) { r[k] = fields[k]; });
  appendRow_('requests', r);
  return r;
}

function decide_(r, status, actor, note) {
  r.status = status;
  r.decidedAt = nowStr_();
  r.decidedBy = actorLabel_(actor);
  r.note = note || '';
  saveRow_('requests', r);
}

function ensureUnlocked_() {
  if (settings_().teamsLocked) fail_('隊伍已鎖定（準備正式報名中），需要調整請聯絡管理員');
}

function captainTeam_(me) {
  const team = teamOf_(me);
  if (!team) fail_('你目前沒有隊伍');
  if (team.captainId !== me.id) fail_('只有隊長可以做這個操作');
  return team;
}

function canRespond_(r, me, myTeam) {
  if (r.type === REQ_INVITE) return r.toMemberId === me.id;
  return !!myTeam && r.toTeamId === myTeam.id && myTeam.captainId === me.id;
}

function canCancel_(r, me, myTeam) {
  if (r.type === REQ_JOIN) return r.fromMemberId === me.id;
  return !!myTeam && r.fromTeamId === myTeam.id && myTeam.captainId === me.id;
}

// ============================================================
//  畫面資料
// ============================================================

function publicConfig_() {
  const s = settings_();
  return {
    version: APP_VERSION, eventName: s.eventName, announcement: s.announcement,
    registrationOpen: s.registrationOpen, phase2Open: s.phase2Open, teamsLocked: s.teamsLocked,
    capacity: capacity_(), maxPending: s.maxPending, adminContact: s.adminContact, retention: s.retention,
    genders: GENDERS, recruitModes: RECRUIT_MODES, legs: LEGS, legSub: LEG_SUB, phase2Fields: phase2Defs_(),
  };
}

function phase2Defs_() {
  return PHASE2_FIELDS.map(function (f) {
    return {
      key: f.key, label: f.label, type: f.type, required: !!f.required, share: !!f.share, help: f.help || '',
      options: f.options.map(function (o) { return typeof o === 'string' ? { value: o, label: o } : o; }),
    };
  });
}

function context_(me) {
  const members = table_('members').rows;
  const teamsAll = table_('teams').rows;
  const teamById = {};
  teamsAll.forEach(function (t) { teamById[t.id] = t; });
  const activeTeams = teamsAll.filter(function (t) { return t.status === TEAM_ACTIVE; });
  const byTeam = {};
  members.forEach(function (m) {
    const t = teamById[m.teamId];
    if (t && t.status === TEAM_ACTIVE) (byTeam[t.id] = byTeam[t.id] || []).push(m);
  });
  const memberById = {};
  members.forEach(function (m) { memberById[m.id] = m; });
  return {
    me: me, members: members, memberById: memberById, teamById: teamById, activeTeams: activeTeams,
    byTeam: byTeam, requests: table_('requests').rows, myTeam: me ? teamOf_(me) : null,
  };
}

function dashboard_(me) {
  const s = settings_();
  const cap = capacity_();
  const ctx = context_(me);
  const myTeam = ctx.myTeam;
  const isCaptain = !!myTeam && myTeam.captainId === me.id;
  const mySize = myTeam ? (ctx.byTeam[myTeam.id] || []).length : 0;
  const pending = ctx.requests.filter(function (r) { return r.status === ST_PENDING; });

  const teams = ctx.activeTeams.map(function (t) {
    const list = ctx.byTeam[t.id] || [];
    const st = teamStats_(list, cap);
    const v = { id: t.id, name: t.name, recruit: t.recruit, intro: t.intro, captainId: t.captainId, createdAt: t.createdAt, isMine: !!myTeam && myTeam.id === t.id };
    Object.assign(v, st);
    v.members = sortMembers_(list, t).map(function (m) { return memberPublic_(m, me, s); });
    if (s.phase2Open) v.legsAssigned = list.filter(function (m) { return m.leg && m.leg !== LEG_SUB; }).length;
    const mine = pending.find(function (r) {
      return r.toTeamId === t.id && ((r.type === REQ_JOIN && r.fromMemberId === me.id) || (r.type === REQ_MERGE && !!myTeam && r.fromTeamId === myTeam.id));
    });
    const inv = pending.find(function (r) { return r.type === REQ_INVITE && r.fromTeamId === t.id && r.toMemberId === me.id; });
    v.myRequestId = mine ? mine.id : '';
    v.inviteRequestId = inv ? inv.id : '';
    const open = !s.teamsLocked && t.recruit !== RECRUIT_CLOSED;
    v.canApply = !myTeam && open && !st.full && !v.myRequestId;
    v.canMerge = isCaptain && !v.isMine && open && !v.myRequestId && mySize + st.size <= cap.total;
    v.mergeTooBig = isCaptain && !v.isMine && mySize + st.size > cap.total;
    return v;
  });

  const pool = ctx.members.filter(function (m) { return !teamOf_(m); }).map(function (m) {
    const v = memberPublic_(m, me, s);
    v.wish = m.wish;
    v.since = String(m.createdAt).slice(0, 10);
    if (isCaptain) {
      const inv = pending.find(function (r) { return r.type === REQ_INVITE && r.fromTeamId === myTeam.id && r.toMemberId === m.id; });
      const app = pending.find(function (r) { return r.type === REQ_JOIN && r.fromMemberId === m.id && r.toTeamId === myTeam.id; });
      v.inviteRequestId = inv ? inv.id : '';
      v.appliedRequestId = app ? app.id : '';
      v.canInvite = !s.teamsLocked && mySize < cap.total && !inv && !app && m.id !== me.id;
    }
    return v;
  });

  const since = now_().getTime() - RECENT_DAYS * 86400000;
  const incoming = [];
  const outgoing = [];
  ctx.requests.forEach(function (r) {
    if (r.status !== ST_PENDING) {
      const d = parseTime_(r.decidedAt);
      if (!d || d.getTime() < since) return;
    }
    const isIn = (r.type === REQ_INVITE && r.toMemberId === me.id) || (r.type !== REQ_INVITE && !!myTeam && r.toTeamId === myTeam.id);
    const isOut = (r.type === REQ_JOIN && r.fromMemberId === me.id) || (r.type !== REQ_JOIN && !!myTeam && r.fromTeamId === myTeam.id);
    if (isIn) incoming.push(requestView_(r, ctx));
    else if (isOut) outgoing.push(requestView_(r, ctx));
  });
  const order = function (a, b) {
    if ((a.status === ST_PENDING) !== (b.status === ST_PENDING)) return a.status === ST_PENDING ? -1 : 1;
    return a.createdAt < b.createdAt ? 1 : -1;
  };
  incoming.sort(order);
  outgoing.sort(order);

  let myTeamView = null;
  if (myTeam) {
    const list = ctx.byTeam[myTeam.id] || [];
    myTeamView = {
      id: myTeam.id, name: myTeam.name, recruit: myTeam.recruit, intro: myTeam.intro, captainId: myTeam.captainId,
      inviteCode: myTeam.inviteCode, warnings: teamWarnings_(list, cap),
      members: sortMembers_(list, myTeam).map(function (m) { return memberTeammate_(m, me, s); }),
    };
    Object.assign(myTeamView, teamStats_(list, cap));
  }

  return {
    config: publicConfig_(), me: selfView_(me), myTeam: myTeamView, isCaptain: isCaptain, teams: teams, pool: pool,
    requests: { incoming: incoming.slice(0, 30), outgoing: outgoing.slice(0, 30) },
    lineGroupUrl: s.lineGroupUrl, serverTime: nowStr_(),
  };
}

function requestView_(r, ctx) {
  const v = { id: r.id, type: r.type, status: r.status, message: r.message, note: r.note, createdAt: r.createdAt, decidedAt: r.decidedAt };
  const s = settings_();
  const fromMember = ctx.memberById[r.fromMemberId];
  const fromTeam = ctx.teamById[r.fromTeamId];
  const toTeam = ctx.teamById[r.toTeamId];
  const toMember = ctx.memberById[r.toMemberId];
  if (fromMember) v.fromMember = memberPublic_(fromMember, ctx.me, s);
  if (fromTeam) {
    const list = ctx.byTeam[fromTeam.id] || [];
    v.fromTeam = { id: fromTeam.id, name: fromTeam.name, size: list.length, members: list.map(function (m) { return memberPublic_(m, ctx.me, s); }) };
  }
  if (toTeam) v.toTeam = { id: toTeam.id, name: toTeam.name, size: (ctx.byTeam[toTeam.id] || []).length };
  if (toMember) v.toMember = { id: toMember.id, name: toMember.name, gender: toMember.gender };
  const pending = r.status === ST_PENDING;
  v.canRespond = pending && canRespond_(r, ctx.me, ctx.myTeam);
  v.canCancel = pending && canCancel_(r, ctx.me, ctx.myTeam);
  return v;
}

/** 所有已報名的人都看得到：姓名、性別、角色，以及標示 share 的第二階段欄位。 */
function memberPublic_(m, me, s) {
  const v = { id: m.id, name: m.name, gender: m.gender, role: m.role, isMe: !!me && m.id === me.id, leg: s.phase2Open ? m.leg : '' };
  if (s.phase2Open) PHASE2_FIELDS.forEach(function (f) { if (f.share) v[f.key] = m[f.key]; });
  return v;
}

/** 同隊隊友才看得到：再加上 LINE ID 與全部第二階段欄位。 */
function memberTeammate_(m, me, s) {
  const v = memberPublic_(m, me, s);
  v.lineId = m.lineId;
  if (s.phase2Open) PHASE2_FIELDS.forEach(function (f) { v[f.key] = m[f.key]; });
  return v;
}

function selfView_(me) {
  const v = {
    id: me.id, name: me.name, phoneMasked: maskPhone_(me.phone), lineId: me.lineId, gender: me.gender, wish: me.wish,
    teamId: teamOf_(me) ? me.teamId : '', role: me.role, leg: me.leg, createdAt: me.createdAt, phase2: {},
  };
  PHASE2_FIELDS.forEach(function (f) { v.phase2[f.key] = me[f.key]; });
  return v;
}

function teamStats_(list, cap) {
  const size = list.length;
  return {
    size: size, capacity: cap.total, official: cap.official, sub: cap.sub, spots: Math.max(cap.total - size, 0),
    full: size >= cap.total, femaleCount: list.filter(function (m) { return m.gender === '女'; }).length,
  };
}

function teamWarnings_(list, cap) {
  const s = settings_();
  const w = [];
  if (list.length < cap.official) w.push('還差 ' + (cap.official - list.length) + ' 人才湊滿 ' + cap.official + ' 位正式隊員');
  if (!list.some(function (m) { return m.gender === '女'; })) w.push('隊上還沒有女性隊員（第一棒必須是女性）');
  if (s.phase2Open) {
    const byLeg = {};
    list.forEach(function (m) { if (m.leg && m.leg !== LEG_SUB) byLeg[m.leg] = m; });
    const missing = LEGS.filter(function (l) { return !byLeg[String(l.no)]; }).map(function (l) { return l.no; });
    if (missing.length) w.push('還沒分配：第 ' + missing.join('、') + ' 棒');
    LEGS.forEach(function (l) {
      const m = byLeg[String(l.no)];
      if (l.femaleOnly && m && m.gender !== '女') w.push('第' + l.no + '棒必須由女性跑');
    });
    const minors = list.filter(function (m) { return m.adult === '否'; }).length;
    if (minors) w.push(minors + ' 位隊員未滿 18 歲，正式報名時需要家長同意書');
    const unfilled = list.filter(function (m) { return !m.adult; }).length;
    if (unfilled) w.push(unfilled + ' 位隊員還沒填第二階段資料');
  }
  return w;
}

function sortMembers_(list, team) {
  return list.slice().sort(function (a, b) {
    if (a.id === team.captainId) return -1;
    if (b.id === team.captainId) return 1;
    return byJoined_(a, b);
  });
}

function byJoined_(a, b) {
  if (a.joinedAt !== b.joinedAt) return a.joinedAt < b.joinedAt ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}

function legText_(leg) {
  if (!leg) return '未分配';
  if (leg === LEG_SUB) return '候補';
  return '第' + leg + '棒';
}

// ============================================================
//  查詢
// ============================================================

function memberById_(id) {
  return table_('members').rows.find(function (m) { return m.id === String(id || ''); }) || null;
}

function teamById_(id) {
  return table_('teams').rows.find(function (t) { return t.id === String(id || ''); }) || null;
}

function activeTeam_(id) {
  const t = teamById_(id);
  if (!t || t.status !== TEAM_ACTIVE) fail_('找不到這個隊伍，可能已經解散，請重新整理');
  return t;
}

/** 成員目前所在的有效隊伍（隊伍已解散或不存在時視為沒有隊伍）。 */
function teamOf_(m) {
  if (!m || !m.teamId) return null;
  const t = teamById_(m.teamId);
  return t && t.status === TEAM_ACTIVE ? t : null;
}

function teamMembers_(teamId) {
  return table_('members').rows.filter(function (m) { return m.teamId === teamId; });
}

function teamByCode_(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return null;
  return table_('teams').rows.find(function (t) { return t.status === TEAM_ACTIVE && t.inviteCode === c; }) || null;
}

function requestById_(id) {
  return table_('requests').rows.find(function (r) { return r.id === String(id || ''); }) || null;
}

function pendingRequests_() {
  return table_('requests').rows.filter(function (r) { return r.status === ST_PENDING; });
}

// ============================================================
//  驗證與格式
// ============================================================

function fail_(message, code) {
  const err = new Error(message);
  err.isUserError = true;
  err.code = code || '';
  throw err;
}

/** 文字欄位：去掉控制字元與開頭的 = + - @（避免被 Google Sheet 當成公式）。 */
function text_(v, label, max, required) {
  let s = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  s = s.replace(/^[=+\-@\s]+/, '');
  if (required && !s) fail_('請填寫' + label);
  if (s.length > max) fail_(label + '最多 ' + max + ' 個字');
  return s;
}

function choice_(v, list, label) {
  const s = String(v == null ? '' : v).trim();
  if (list.indexOf(s) < 0) fail_('請選擇' + label);
  return s;
}

function phone_(v) {
  let s = String(v == null ? '' : v).replace(/[\s\-()]/g, '');
  if (s.indexOf('+886') === 0) s = '0' + s.slice(4);
  else if (/^886\d{9}$/.test(s)) s = '0' + s.slice(3);
  if (!/^09\d{8}$/.test(s)) fail_('請輸入 09 開頭的 10 碼手機號碼');
  return s;
}

function birthday_(v) {
  const s = String(v == null ? '' : v).trim();
  const days = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const mm = Number(s.slice(0, 2));
  const dd = Number(s.slice(2, 4));
  if (!/^\d{4}$/.test(s) || mm < 1 || mm > 12 || dd < 1 || dd > days[mm - 1]) {
    fail_('生日請輸入 4 位數字（月月日日），例如 7 月 31 日請輸入 0731');
  }
  return s;
}

/** 隊名：依 2026 官方規定，中文 8 字或英文 16 字母以內（中文算 2、英數算 1，合計 16）。 */
function teamName_(v, exceptId) {
  const name = text_(v, '隊名', 16, true);
  let width = 0;
  for (let i = 0; i < name.length; i++) width += name.charCodeAt(i) > 0xff ? 2 : 1;
  if (width > 16) fail_('隊名最多中文 8 個字或英文 16 個字母（依 2026 官方規定）');
  const key = name.replace(/\s+/g, '').toLowerCase();
  const dup = table_('teams').rows.some(function (t) {
    return t.status === TEAM_ACTIVE && t.id !== exceptId && t.name.replace(/\s+/g, '').toLowerCase() === key;
  });
  if (dup) fail_('已經有隊伍叫「' + name + '」了，請換一個隊名');
  return name;
}

function readPhase2_(input, m) {
  phase2Defs_().forEach(function (f) {
    const allowed = f.options.map(function (o) { return o.value; });
    const raw = input[f.key];
    let value;
    if (f.type === 'multi') {
      const arr = (Array.isArray(raw) ? raw : String(raw || '').split(',')).map(function (x) { return String(x).trim(); }).filter(Boolean);
      arr.forEach(function (x) { if (allowed.indexOf(x) < 0) fail_('「' + f.label + '」的選項不正確'); });
      value = allowed.filter(function (x) { return arr.indexOf(x) >= 0; }).join(',');
    } else {
      value = String(raw == null ? '' : raw).trim();
      if (value && allowed.indexOf(value) < 0) fail_('「' + f.label + '」的選項不正確');
    }
    if (f.required && !value) fail_('請填寫「' + f.label + '」');
    m[f.key] = value;
  });
}

function maskPhone_(p) {
  const s = String(p || '');
  return s.length === 10 ? s.slice(0, 4) + '***' + s.slice(7) : '***';
}

function actorLabel_(actor) {
  if (!actor) return '';
  if (typeof actor === 'string') return actor;
  return actor.id + ' ' + actor.name;
}

function now_() {
  return new Date();
}

function nowStr_() {
  return fmtTime_(now_());
}

function fmtTime_(d) {
  return Utilities.formatDate(d, TZ, 'yyyy-MM-dd HH:mm:ss');
}

function parseTime_(s) {
  if (!s) return null;
  const d = new Date(String(s).replace(' ', 'T') + '+08:00');
  return isNaN(d.getTime()) ? null : d;
}

function nextId_(rows, prefix, width) {
  let max = 0;
  rows.forEach(function (r) {
    const m = /^[A-Z](\d+)$/.exec(r.id);
    if (m) max = Math.max(max, Number(m[1]));
  });
  return prefix + String(max + 1).padStart(width, '0');
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newInviteCode_() {
  const used = {};
  table_('teams').rows.forEach(function (t) { used[t.inviteCode] = true; });
  for (let i = 0; i < 100; i++) {
    let c = '';
    for (let j = 0; j < 6; j++) c += CODE_CHARS.charAt(Math.floor(Math.random() * CODE_CHARS.length));
    if (!used[c]) return c;
  }
  return fail_('無法產生邀請碼，請再試一次');
}

// ============================================================
//  安全：雜湊與登入憑證
// ============================================================

function newSalt_() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 16);
}

function hashCode_(salt, code) {
  return sha256Hex_(salt + ':' + code);
}

function sha256Hex_(value) {
  return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8));
}

function sign_(value) {
  return hex_(Utilities.computeHmacSha256Signature(value, secret_()));
}

function hex_(bytes) {
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function secret_() {
  if (REQ_.secret) return REQ_.secret;
  const props = PropertiesService.getScriptProperties();
  let s = props.getProperty('TOKEN_SECRET');
  if (!s) {
    s = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('TOKEN_SECRET', s);
  }
  REQ_.secret = s;
  return s;
}

/** 登入憑證：成員編號.到期時間.簽章（簽章包含驗證碼雜湊，重設生日碼後舊憑證自動失效）。 */
function makeToken_(m) {
  const exp = now_().getTime() + TOKEN_DAYS * 86400000;
  return m.id + '.' + exp + '.' + sign_('m.' + m.id + '.' + exp + '.' + m.codeHash);
}

function authMember_(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || !/^\d+$/.test(parts[1])) fail_('請重新登入', 'AUTH');
  if (Number(parts[1]) < now_().getTime()) fail_('登入已過期，請重新查詢登入', 'AUTH');
  const m = memberById_(parts[0]);
  if (!m) fail_('找不到你的報名資料，請重新登入', 'AUTH');
  if (!safeEqual_(sign_('m.' + m.id + '.' + parts[1] + '.' + m.codeHash), parts[2])) fail_('請重新登入', 'AUTH');
  return m;
}

function authAdmin_(token) {
  const parts = String(token || '').split('.');
  const pw = PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD');
  if (!pw || parts.length !== 3 || parts[0] !== 'A' || !/^\d+$/.test(parts[1])) fail_('請重新登入管理頁', 'AUTH');
  if (Number(parts[1]) < now_().getTime()) fail_('管理頁登入已過期，請重新登入', 'AUTH');
  if (!safeEqual_(sign_('admin.' + parts[1] + '.' + sha256Hex_(pw)), parts[2])) fail_('請重新登入管理頁', 'AUTH');
}

function safeEqual_(a, b) {
  a = String(a);
  b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ============================================================
//  設定工作表
// ============================================================

function settings_() {
  if (REQ_.settings) return REQ_.settings;
  const ss = ss_();
  let sheet = ss.getSheetByName(SETTINGS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(SETTINGS_SHEET);
    sheet.getRange(1, 1, 1, 3).setValues([['設定項目', '值', '說明']]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  const last = sheet.getLastRow();
  const values = last > 0 ? sheet.getRange(1, 1, last, 3).getValues() : [];
  if (!values.length) sheet.getRange(1, 1, 1, 3).setValues([['設定項目', '值', '說明']]).setFontWeight('bold');
  const map = {};
  values.slice(1).forEach(function (r) {
    const k = String(r[0]).trim();
    if (k) map[k] = r[1];
  });
  const missing = DEFAULT_SETTINGS.filter(function (d) { return !(d[0] in map); });
  if (missing.length) {
    const start = Math.max(last, 1) + 1;
    sheet.getRange(start, 1, missing.length, 3).setValues(missing.map(function (d) { return [d[0], d[1], d[2]]; }));
    missing.forEach(function (d, i) {
      if (typeof d[1] === 'boolean') {
        const cell = sheet.getRange(start + i, 2);
        cell.insertCheckboxes();
        cell.setValue(d[1]);
      }
      map[d[0]] = d[1];
    });
  }
  REQ_.settings = {
    eventName: cellText_(map['活動名稱']) || '追火車組隊媒合',
    announcement: cellText_(map['公告']),
    registrationOpen: bool_(map['開放註冊']),
    phase2Open: bool_(map['開放第二階段']),
    teamsLocked: bool_(map['鎖定隊伍']),
    official: int_(map['每隊正式人數'], 7, 1, 20),
    sub: int_(map['每隊候補人數'], 2, 0, 10),
    maxPending: int_(map['最多同時申請數'], 3, 1, 10),
    lineGroupUrl: /^https:\/\/\S+$/.test(cellText_(map['LINE群組連結'])) ? cellText_(map['LINE群組連結']) : '',
    adminContact: cellText_(map['管理員聯絡方式']) || '請在 LINE 群組聯絡管理員',
    retention: cellText_(map['資料保存期限']) || '活動結束後 3 個月內刪除',
  };
  return REQ_.settings;
}

function capacity_() {
  const s = settings_();
  return { official: s.official, sub: s.sub, total: s.official + s.sub };
}

function bool_(v) {
  if (v === true) return true;
  const s = String(v == null ? '' : v).trim().toUpperCase();
  return s === 'TRUE' || s === '是' || s === '1' || s === 'Y' || s === 'V';
}

function int_(v, def, min, max) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return def;
  return Math.min(Math.max(n, min), max);
}

// ============================================================
//  資料表讀寫（每次請求讀一次，寫入時只改動那一列）
// ============================================================

let REQ_ = { tables: {}, settings: null, ss: null, secret: null };

function resetRequest_() {
  REQ_ = { tables: {}, settings: null, ss: null, secret: null };
}

function ss_() {
  if (!REQ_.ss) REQ_.ss = SpreadsheetApp.getActiveSpreadsheet();
  return REQ_.ss;
}

function table_(kind) {
  if (REQ_.tables[kind]) return REQ_.tables[kind];
  const def = SCHEMA[kind];
  const ss = ss_();
  let sheet = ss.getSheetByName(def.sheet);
  if (!sheet) {
    sheet = ss.insertSheet(def.sheet);
    // 全部設為純文字，避免 0912… 被當成數字吃掉開頭的 0
    sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).setNumberFormat('@');
    sheet.setFrozenRows(1);
  }
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  const values = lastRow > 0 && lastCol > 0 ? sheet.getRange(1, 1, lastRow, lastCol).getValues() : [];
  const headers = values.length ? values[0].map(function (h) { return String(h).trim(); }) : [];
  const missing = def.cols.map(function (c) { return c[1]; }).filter(function (h) { return headers.indexOf(h) < 0; });
  if (missing.length) {
    const start = headers.length + 1;
    const need = headers.length + missing.length;
    if (need > sheet.getMaxColumns()) sheet.insertColumnsAfter(sheet.getMaxColumns(), need - sheet.getMaxColumns());
    sheet.getRange(1, start, sheet.getMaxRows(), missing.length).setNumberFormat('@');
    sheet.getRange(1, start, 1, missing.length).setValues([missing]).setFontWeight('bold');
    missing.forEach(function (h) { headers.push(h); });
  }
  const index = {};
  headers.forEach(function (h, i) { if (h && !(h in index)) index[h] = i; });
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const raw = values[i];
    if (!raw.some(function (v) { return v !== '' && v !== null; })) continue;
    const obj = { __row: i + 1, __raw: raw.slice() };
    def.cols.forEach(function (c) {
      const idx = index[c[1]];
      obj[c[0]] = idx === undefined ? '' : cellText_(raw[idx]);
    });
    rows.push(obj);
  }
  if (kind === 'members') rows.forEach(function (m) { m.phone = storedPhone_(m.phone); });
  const t = { kind: kind, sheet: sheet, headers: headers, index: index, rows: rows };
  REQ_.tables[kind] = t;
  return t;
}

function buildRow_(t, obj) {
  const row = [];
  for (let i = 0; i < t.headers.length; i++) row.push(obj.__raw && i < obj.__raw.length ? obj.__raw[i] : '');
  SCHEMA[t.kind].cols.forEach(function (c) {
    row[t.index[c[1]]] = obj[c[0]] == null ? '' : String(obj[c[0]]);
  });
  return row;
}

function saveRow_(kind, obj) {
  const t = table_(kind);
  const row = buildRow_(t, obj);
  t.sheet.getRange(obj.__row, 1, 1, row.length).setValues([row]);
  obj.__raw = row;
}

function appendRow_(kind, obj) {
  const t = table_(kind);
  const rowNo = t.sheet.getLastRow() + 1;
  if (rowNo > t.sheet.getMaxRows()) t.sheet.insertRowsAfter(t.sheet.getMaxRows(), 200);
  const row = buildRow_(t, obj);
  const range = t.sheet.getRange(rowNo, 1, 1, row.length);
  range.setNumberFormat('@');
  range.setValues([row]);
  obj.__row = rowNo;
  obj.__raw = row;
  t.rows.push(obj);
}

function deleteRow_(kind, obj) {
  const t = table_(kind);
  t.sheet.deleteRow(obj.__row);
  t.rows = t.rows.filter(function (r) { return r !== obj; });
  t.rows.forEach(function (r) { if (r.__row > obj.__row) r.__row -= 1; });
}

function cellText_(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return fmtTime_(v);
  if (v === true) return 'TRUE';
  if (v === false) return 'FALSE';
  return String(v).trim();
}

function storedPhone_(v) {
  const s = String(v || '').replace(/\D/g, '');
  return /^9\d{8}$/.test(s) ? '0' + s : s;
}

function log_(action, actor, detail) {
  appendRow_('log', { time: nowStr_(), action: action, actor: actorLabel_(actor), detail: detail || '' });
}
