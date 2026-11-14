// post.js —— 發起活動。呢度只做提示與預覽；最終規則一律由 server 驗證（04／05）
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
  // V01：無座標嘅紀錄唔畫、唔可發布，但要喺摘要講清楚
  const bad = list.filter((c) => c.lng === null);
  $("courtNote").textContent = ok.length === 0
    ? "呢個區暫時冇可發布嘅場地（全部紀錄都缺有效座標）。"
    : `可發布 ${ok.length} 個` + (bad.length ? `；另有 ${bad.length} 筆無有效座標，唔列喺度亦唔准發布` : "");
  showAck();
  preview();
}

// D08：待核實資料要提醒，而且唔可以變成「已核實」
function showAck() {
  const c = court();
  const box = $("ackBox");
  if (!c) { box.hidden = true; return; }
  const items = [];
  if (c.lighting === "unknown") items.push("照明資料未知（唔係「冇燈」）");
  if (c.cover === "unknown") items.push("有蓋與否未知");
  if (c.suit === "unverified") items.push("適合半場與否未經人工核實");
  if (c.oper === "unverified") items.push("營運狀態未經人工核實");
  if ((c.flags || []).includes("complex_court_count")) items.push(`球場數原文係「${c.n_raw}」，未能換算成可用半場數`);
  if ((c.flags || []).includes("possible_no_lighting")) items.push("來源備註似乎寫明無射燈，請到場確認");
  if ((c.flags || []).includes("possible_operational_notice")) items.push("來源有一則可能影響使用嘅通知，日期要自行核實");
  if ((c.flags || []).includes("duplicate_source_id")) items.push("來源編號重複，呢個可能係另一個獨立場地");
  box.hidden = items.length === 0;
  $("ackText").innerHTML = "呢個場地嘅資料有以下未核實之處：<br>· " + items.map(esc).join("<br>· ") +
    `<br>地址：${esc(c.addr || "無")}｜原文時間：${esc(c.hours || "無")}｜查詢電話：${esc(c.tel || "無")}`;
  if (!items.length) $("fAck").checked = true;
}

function preview() {
  const T = TARGET[$("fFormat").value];
  const g = Math.max(1, Math.min(Number($("fGroup").value) || 1, T - 1));
  $("pvTarget").textContent = T;
  $("pvGroup").textContent = g;
  $("pvNeed").textContent = Math.max(T - g, 0);
  $("fGroup").max = T - 1;
  $("fArrived").max = g;
  const c = court();
  const when = document.querySelector('input[name=intent]:checked').value === "now"
    ? "即刻（伺服器決定開始時間）"
    : `${$("fDate").value || "未填"} ${$("fStart").value || "?"}–${$("fEnd").value || "?"}（香港時間）`;
  $("preview").textContent = c
    ? `預覽：${c.zh}｜${when}｜${$("fFormat").value}｜缺 ${Math.max(T - g, 0)} 人`
    : "預覽：先揀場地";
}

function setIntent() {
  const now = document.querySelector('input[name=intent]:checked').value === "now";
  $("plannedOnly").hidden = now;
  $("nowNote").hidden = !now;
  if (!now) {
    const t = new Date(Date.now() + 8 * 3600e3).toISOString();   // 香港日時，先至啱 min 屬性
    if (!$("fDate").value) $("fDate").value = t.slice(0, 10);
    $("fDate").min = t.slice(0, 10);
  }
  preview();
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
  // 由球場面板嘅兩個按鈕入嚟：?court=ID&intent=now|planned —— 區同場地都預填好，唔使用戶再答一次「喺邊」（WF05 一頁分段）
  const fromCourt = params.get("court");
  const deep = fromCourt ? COURTS.find((x) => x.id === fromCourt) : null;
  if (deep) sel.value = deep.code;
  const intent = params.get("intent");
  if (intent === "now" || intent === "planned") {
    document.querySelector('input[name="intent"][value="' + intent + '"]').checked = true;
  }
  sel.addEventListener("change", () => { markDirty(); fillCourts(); });
  fillCourts();
  if (deep) {
    $("fCourt").value = deep.id;
    if ($("fCourt").value !== deep.id) {
      $("courtNote").textContent = "呢個場地無有效座標，唔准發布（D02）；請由地圖面板另揀場地。";
      $("fCourt").disabled = true;
    } else { showAck(); preview(); }
  }
  setIntent();
}

["fFormat", "fGroup", "fArrived", "fDate", "fStart", "fEnd"].forEach((id) =>
  $(id).addEventListener("input", () => { markDirty(); preview(); }));
document.querySelectorAll('input[name=intent]').forEach((r) => r.addEventListener("change", () => { markDirty(); setIntent(); }));
document.querySelectorAll('input[name=presence]').forEach((r) => r.addEventListener("change", () => { markDirty(); preview(); }));
["fNick", "fSkill", "fNotes", "fBeginner", "fAck"].forEach((id) => $(id).addEventListener("input", () => { markDirty(); }));
$("fCourt").addEventListener("change", showAck);
window.addEventListener("beforeunload", (e) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("msg");
  const btn = e.target.querySelector("button[type=submit]");
  const T = TARGET[$("fFormat").value];
  const g = Number($("fGroup").value);
  const arrivalRaw = $("fArrived").value;
  const body = {
    court_id: $("fCourt").value,
    creation_intent: document.querySelector('input[name=intent]:checked').value,
    format: $("fFormat").value,
    organizer_nickname: $("fNick").value.trim(),
    organizer_presence: document.querySelector('input[name=presence]:checked').value,
    original_group_size: g,
    original_group_arrived: arrivalRaw === "" ? null : Number(arrivalRaw),
    skill_level: $("fSkill").value,
    beginner_friendly: $("fBeginner").checked,
    notes: $("fNotes").value.trim() || null,
    acknowledged_unverified_court: $("fAck").checked,
  };
  if (body.creation_intent === "planned") {
    const day = $("fDate").value;
    body.starts_at = new Date(`${day}T${$("fStart").value || "19:30"}:00+08:00`).toISOString();
    body.ends_at = new Date(`${day}T${$("fEnd").value || "21:30"}:00+08:00`).toISOString();
    if (!day) { msg.textContent = "預先約波要揀日期。"; return; }
  }
  if (!body.organizer_nickname) { msg.textContent = "要填暱稱（1–30 字）。"; return; }
  if (!Number.isInteger(g) || g < 1 || g >= T) { msg.textContent = `原有小組要係 1 至 ${T - 1} 人：發布時最少要缺 1 人。`; return; }

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
