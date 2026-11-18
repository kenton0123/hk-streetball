// post.js —— 搵人打波（四頁向導）。呢度只做提示與預覽；最終規則一律由 server 驗證（04／05）
const $ = (id) => document.getElementById(id);
const TARGET = { "3v3": 6, "4v4": 8 };   // 只用於即時預覽，提交時唔會寄出去
let COURTS = [], DISTRICTS = [], dirty = false;
// C06／05 第 32 行：同一份内容重试（包括撳多一次送出）用同一把 key，服务器就不多建活动；
// 改过任何一个栏位就换新 key，令新内容当真提交
let submitKey = null;
const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : "k" + Date.now() + Math.random().toString(16).slice(2));
function markDirty() { dirty = true; submitKey = null; }

const esc = (s) => String(s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));

function court() { return COURTS.find((c) => c.id === $("fCourt").value) || null; }
const currentIntent = () => {
  const r = document.querySelector('input[name=intent]:checked');
  return r ? r.value : null;
};
const presence = () => {
  const r = document.querySelector('input[name=presence]:checked');
  return r ? r.value : null;
};

// ---- 向導：一頁一步，揀完自動去下一頁（B.1）----
let page = 1, advT = null;

function goto(n) {
  clearTimeout(advT);
  page = Math.max(1, Math.min(4, n));
  for (let i = 1; i <= 4; i++) $("p" + i).hidden = i !== page;
  $("btnPrev").hidden = page === 1;                 // B.1：上一步只喺第 2–4 頁
  $("btnSubmit").hidden = page !== 4;
  $("wStep").textContent = `${page} / 4`;
  if (page === 3) applyIntent();
  if (page === 4) showVenue();
  const head = $("p" + page).querySelector(".wtitle");
  head.setAttribute("tabindex", "-1");
  head.focus();                                      // U02：轉頁要將焦點帶去新頁，鍵盤用戶先唔會迷路
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// 自動翻頁：每次改動都重新計時，俾用戶繼續填埋呢頁其他欄位（第 3 頁留空＝未知，唔可以逼填）
function armAdvance(ms) {
  clearTimeout(advT);
  advT = setTimeout(() => { if (page < 4 && pageValid(page)) goto(page + 1); }, ms);
}

function plannedValid() {
  const d = $("fDate").value, s = $("fStart").value, e = $("fEnd").value;
  return Boolean(d && s && e && e > s);              // 同日、結束晚於開始（C02）
}

function pageValid(n) {
  if (n === 1) { const sel = $("fCourt"); return Boolean(sel.value) && !sel.disabled; }
  if (n === 2) { const i = currentIntent(); return i === "now" || (i === "planned" && plannedValid()); }
  if (n === 3) {
    if (currentIntent() !== "planned") return Boolean(presence());
    const T = TARGET[$("fFormat").value], g = Number($("fGroup").value);
    return Number.isInteger(g) && g >= 1 && g < T;
  }
  return true;
}

// ---- 第 1 頁 ----
function fillCourts() {
  const sel = $("fCourt");
  sel.textContent = "";
  const list = COURTS.filter((c) => c.code === $("fCode").value);
  const ok = list.filter((c) => c.lng !== null);
  for (const c of ok) {
    const o = document.createElement("option");
    o.value = c.id;
    o.textContent = `${c.zh}（${c.n_raw ?? "球場數未知"}）`;
    sel.appendChild(o);
  }
  sel.disabled = ok.length === 0;
  // V01／D02：無座標嘅紀錄唔畫、唔可發布，但要講清楚（B 只要求删「可發布 X 個」呢句）
  const bad = list.filter((c) => c.lng === null);
  $("courtNote").textContent = ok.length === 0
    ? "呢個區暫時冇可發布嘅場地（全部紀錄都缺有效座標）。"
    : (bad.length ? `另有 ${bad.length} 筆無有效座標，唔列喺度亦唔准發布（D02）。` : "");
  showVenue();
  preview();
}

// ---- 第 4 頁：場地資料只留地址 ----
function showVenue() {
  const c = court();
  $("venueAddr").textContent = c ? `地址：${c.addr || "（來源冇地址）"}` : "先喺第 1 頁揀場地。";
  // 三行誠實字之一（D08）：保留一行細字講明未核實，唔列明每項、唔再強制剔確認
  $("venueCaveat").textContent = c
    ? "呢個場地嘅照明、有蓋、適合半場與營運狀態等資料未經人工核實，到場前請自行確認。"
    : "";
}

// ---- 第 2／3 頁：intent 決定顯示邊啲欄位 ----
function applyIntent() {
  const now = currentIntent() === "now";
  $("plannedOnly").hidden = currentIntent() !== "planned";
  $("nowNote").hidden = !now;
  document.querySelectorAll(".whenCard").forEach((c) =>
    c.classList.toggle("on", c.querySelector("input").checked));
  if (currentIntent() === "planned") {
    const t = new Date(Date.now() + 8 * 3600e3).toISOString();   // 香港日時，先至啱 min 屬性
    if (!$("fDate").value) $("fDate").value = t.slice(0, 10);
    $("fDate").min = t.slice(0, 10);
  }
  // B.3：即刻開波＝到場狀態＋玩法＋已經到咗幾個；預先約波＝玩法＋有幾多人會黎
  $("presenceBox").hidden = !now;
  $("arrivedBox").hidden = !now;
  $("joiningBox").hidden = now;
  $("fArrived").min = presence() === "at_court" ? "1" : "0";     // server：發起人已在場，到場人數唔可以係 0
  preview();
}

// ---- 人數：目標由玩法計，原有小組人數由 server 覆核（C03／C04）----
// Round 1 第 3 頁喺「即刻開波」唔再問有幾多人會黎，所以原有小組人數由已到人數推算：
//   我已經喺場 → 你本人已計入已到人數；我仲未到 → 你額外計一個
function groupNumbers() {
  const T = TARGET[$("fFormat").value];
  if (currentIntent() === "planned") {
    const raw = Number($("fGroup").value);
    return { T, G: raw, A: null, presence: "not_yet" };   // 約波未到期：發布嗰刻你一定仲未到
  }
  const p = presence();
  const rawA = $("fArrived").value;
  const A = rawA === "" ? null : Number(rawA);
  const G = p === "at_court" ? Math.max(A === null ? 1 : A, 1) : (A === null ? 0 : A) + 1;
  return { T, G, A, presence: p };
}

function preview() {
  const { T, G, A } = groupNumbers();
  const g = Math.max(1, Math.min(Number.isFinite(G) ? G : 1, T - 1));
  $("pvTarget").textContent = T;
  $("pvGroup").textContent = g;
  $("pvNeed").textContent = Math.max(T - g, 0);
  $("fGroup").max = T - 1;
  $("fArrived").max = T - 1;
  const c = court();
  const when = currentIntent() === "now"
    ? "即刻（伺服器決定開始時間）"
    : currentIntent() === "planned"
      ? `${$("fDate").value || "未填"} ${$("fStart").value || "?"}–${$("fEnd").value || "?"}（香港時間）`
      : "未揀";
  $("preview").textContent = c
    ? `預覽：${c.zh}｜${when}｜${$("fFormat").value}｜缺 ${Math.max(T - g, 0)} 人`
    : "預覽：先揀場地";
}

async function boot() {
  let d, c;
  try {
    d = await (await fetch("/api/districts")).json();
    c = await (await fetch("/api/courts")).json();
  } catch (e) {
    $("msg").textContent = "撱唔到場地資料：請經 `node server.js` 嘅 http://localhost:3000 入頁。";
    return;
  }
  DISTRICTS = d.data; COURTS = c.data;
  const sel = $("fCode");
  for (const x of DISTRICTS) {
    const o = document.createElement("option");
    o.value = x.code;
    o.textContent = `${x.zh} ${x.en}`;
    sel.appendChild(o);
  }
  const params = new URLSearchParams(location.search);
  const fromMap = params.get("code");
  if (fromMap && DISTRICTS.some((x) => x.code === fromMap)) sel.value = fromMap;
  // 由球場面板嘅兩個大卡入嚟：?court=ID&intent=now|planned —— 區同場地都預填好（WF05、D 嘅快速開始）
  const fromCourt = params.get("court");
  const deep = fromCourt ? COURTS.find((x) => x.id === fromCourt) : null;
  if (deep) sel.value = deep.code;
  const intent = params.get("intent");
  if (intent === "now" || intent === "planned") {
    document.querySelector(`input[name="intent"][value="${intent}"]`).checked = true;
  }
  sel.addEventListener("change", () => { markDirty(); fillCourts(); });
  fillCourts();
  if (deep) {
    $("fCourt").value = deep.id;
    if ($("fCourt").value !== deep.id) {
      $("courtNote").textContent = "呢個場地無有效座標，唔准發布（D02）；請由地圖面板另揀場地。";
      $("fCourt").disabled = true;
    } else { showVenue(); preview(); }
  }
  applyIntent();
  // 深連結帶 intent 入嚟：第 1 頁已預填場地，直接送去第 2 頁（有 intent 就送去第 3 頁）
  goto(intent && pageValid(1) ? 3 : 1);
}

// ---- 事件 ----
$("btnPrev").addEventListener("click", () => goto(page - 1));
$("fCourt").addEventListener("change", () => { markDirty(); showVenue(); preview(); armAdvance(450); });
document.querySelectorAll('input[name=intent]').forEach((r) => r.addEventListener("change", () => {
  markDirty(); applyIntent();
  armAdvance(r.value === "now" ? 400 : 700);   // 即刻開波冇嘢再填；約波要等日期時間填齊
}));
["fDate", "fStart", "fEnd"].forEach((id) => $(id).addEventListener("input", () => {
  markDirty(); applyIntent(); armAdvance(700);
}));
document.querySelectorAll('input[name=presence]').forEach((r) => r.addEventListener("change", () => {
  markDirty(); applyIntent(); armAdvance(1200);
}));
["fFormat", "fGroup", "fArrived"].forEach((id) => $(id).addEventListener("input", () => {
  markDirty(); preview(); armAdvance(id === "fFormat" ? 1200 : 900);
}));
["fNick", "fSkill", "fNotes", "fBeginner"].forEach((id) => $(id).addEventListener("input", () => { markDirty(); }));

// B.Page 2 嘅 bug fix：桌面版撳時間欄要真係彈出選擇器。桌面 Chrome 嘅 <input type=time> 淨係俾你逐格改，
// 所以主動叫 showPicker()；手機版本來就會彈，唔支援或者冇用戶手勢就會 throw，catch 住當冇事
["fStart", "fEnd"].forEach((id) => {
  const el = $(id);
  el.addEventListener("click", () => { try { el.showPicker(); } catch (e) { /* NotAllowedError／唔支援：照舊用原生行為 */ } });
});

window.addEventListener("beforeunload", (e) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("msg");
  const btn = $("btnSubmit");
  const { T, G, A, presence: pres } = groupNumbers();
  if (!Number.isInteger(G) || G < 1) { msg.textContent = "人數要係整數，最少 1 人。"; return; }
  if (G >= T) { msg.textContent = `你哋已經有 ${G} 人（${$("fFormat").value} 目標 ${T} 人），唔使再搵人；請改玩法或者人數（C04）。`; return; }
  if (A !== null && (!Number.isInteger(A) || A < 0 || A > G)) { msg.textContent = "已經到咗幾個要係 0 至你哋人數之間，或者留空＝未知。"; return; }
  const nick = $("fNick").value.trim();
  if (!nick) { msg.textContent = "要填暱稱（1–30 字）。"; return; }
  if (currentIntent() === "planned" && !plannedValid()) { msg.textContent = "預先約波要揀日期，同埋結束時間要晚過開始時間。"; goto(2); return; }

  const body = {
    court_id: $("fCourt").value,
    creation_intent: currentIntent(),
    format: $("fFormat").value,
    organizer_nickname: nick,
    organizer_presence: pres,
    original_group_size: G,
    original_group_arrived: A,
    skill_level: $("fSkill").value,
    beginner_friendly: $("fBeginner").checked,
    notes: $("fNotes").value.trim() || null,
  };
  if (currentIntent() === "planned") {
    const day = $("fDate").value;
    body.starts_at = new Date(`${day}T${$("fStart").value}:00+08:00`).toISOString();
    body.ends_at = new Date(`${day}T${$("fEnd").value}:00+08:00`).toISOString();
  }

  btn.disabled = true;                       // C06：提交中防重按
  msg.textContent = "送出中…";
  if (!submitKey) submitKey = newKey();      // 內容未變就沿用同一把 key，重試唔會多建活動
  const r = await fetch("/api/games", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": submitKey },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => null);
  btn.disabled = false;
  if (r.status !== 201) {
    const f = j && j.error && j.error.fields ? Object.entries(j.error.fields).map(([k, v]) => `${k}：${v}`).join("；") : "";
    msg.textContent = "失敗（" + (j && j.error ? j.error.code : "network") + "）：" + ((j && j.error && j.error.message) || "網絡問題") + (f ? "｜" + f : "") + "。你輸入嘅內容保留喺度。";
    return;
  }
  // 管理憑證只係暫時存喺呢部機：換機或清除瀏覽器資料就改唔到（A04）
  const store = JSON.parse(localStorage.getItem("hk_organizer_tokens") || "{}");
  store[j.data.game_id] = j.private.manage_token;
  localStorage.setItem("hk_organizer_tokens", JSON.stringify(store));
  dirty = false;
  msg.textContent = `已發布：${j.data.court_zh}｜${j.data.format}｜尚缺 ${j.data.remaining} 人。1 秒後回地圖…`;
  setTimeout(() => { location.href = "index.html?game=" + j.data.game_id; }, 1000);
});

boot();
