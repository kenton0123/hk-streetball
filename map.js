// map.js —— 第一頁：地圖互動 + 開波活動列表（資料全部由 server 嘅 API 攞）
// 投影常數讀自 SVG 根元素嘅 data-*，所以換地圖檔唔使改呢度。
const svg = document.getElementById("hkmap");
const VP = svg.querySelector("#viewport");
const G_COURTS = svg.querySelector("#courts");
const G_LABELS = svg.querySelector("#labels");
const VW = 1000, VH = 740;
const P = {
  lon0: Number(svg.dataset.lon0),
  top: Number(svg.dataset.lattop),
  s: Number(svg.dataset.scale),
  cos: Number(svg.dataset.coslat),
};

let currentCode = null;      // 而家選咗邊個區（null = 全港）
let currentCourt = null;     // 而家過濾咗邊個場地
let timeFilter = "now";
let k = 1;

let DISTRICTS = [], COURTS = [], GAMES = [], META = {};
const courtById = new Map();
const districtByCode = new Map();

// 呢部裝置嘅權證：換機／清除即失去管理權限（06 WF06、A04 要講明）
const creds = {
  read(key) { try { return JSON.parse(localStorage.getItem(key) || "{}"); } catch (e) { return {}; } },
  write(key, obj) { localStorage.setItem(key, JSON.stringify(obj)); },
};
const myGames = () => creds.read("hk_organizer_tokens");
const mySignups = () => creds.read("hk_signup_tokens");

const esc = (s) => String(s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));

const fTime = document.getElementById("fTime");
const fDate = document.getElementById("fDate");
const fStarted = document.getElementById("fStarted");
const fMine = document.getElementById("fMine");

function project(lon, lat) { return [(lon - P.lon0) * P.cos * P.s, (P.top - lat) * P.s]; }

async function api(path, opts = {}) {
  const r = await fetch(path, {
    headers: {
      "content-type": "application/json",
      ...(opts.token ? { authorization: "Bearer " + opts.token } : {}),
      ...(opts.idem ? { "idempotency-key": opts.idem } : {}),
    },
    method: opts.method || "GET",
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const j = await r.json().catch(() => null);
  return { status: r.status, j };
}

async function boot() {
  const [d, c, m] = await Promise.all([
    api("/api/districts"), api("/api/courts"), api("/api/meta"),
  ]);
  if (!d.j || !c.j) { setStatus("撱唔到資料：請用 `node server.js` 開嘅 http://localhost:3000 入頁，唔好用 file:// 直接開。"); return; }
  DISTRICTS = d.j.data; COURTS = c.j.data; META = (m.j && m.j.data) || {};
  courtById.clear(); districtByCode.clear();
  for (const x of COURTS) courtById.set(x.id, x);
  for (const x of DISTRICTS) districtByCode.set(x.code, x);
  await refreshGames();
  await loadChart();
  renderWhere();
  focusFromUrl();
  openCourtFromUrl();
  askLocation();
}

function setStatus(msg) {
  const el = document.getElementById("where");
  if (el) el.textContent = msg;
}

// ---- 地圖：只畫有效座標（D02、V01），無效座標留喺清單同摘要入面 ----
function drawCourts(code) {
  G_COURTS.textContent = "";
  const list = COURTS.filter((c) => c.lng !== null && c.lat !== null && (!code || c.code === code));
  for (const c of list) {
    const [x, y] = project(c.lng, c.lat);
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("class", "court");
    g.dataset.x = x.toFixed(1);
    g.dataset.y = y.toFixed(1);
    g.dataset.court = c.id;
    g.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${1 / k})`);
    const active = GAMES.some((gm) => gm.court_id === c.id && (gm.status === "recruiting" || gm.status === "full"));
    if (active) g.classList.add("hasGame");
    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("r", code ? "6" : "3.4");
    const t = document.createElementNS("http://www.w3.org/2000/svg", "title");
    t.textContent = `${c.zh} ${c.en || ""} — ${c.addr || "無地址"}｜球場數原文：${c.n_raw ?? "未知"}｜${c.hours ?? "無時間資料"}`;
    // WF02：地圖有清單替代之外，圓點本身都要用键盘到（撳入就開球場面板）
    g.setAttribute("tabindex", "0");
    g.setAttribute("role", "button");
    g.setAttribute("aria-label", `${c.zh} ${c.en || ""}，${districtName(c.code)}，撳入睇球場面板`);
    if (c.id === currentCourt) g.classList.add("sel");
    g.append(dot, t);
    G_COURTS.appendChild(g);
  }
}

// V01 摘要：X 筆 = 可定位 Y + 待核實 Z，兩者唔可以混計
function summary(code) {
  if (!code) return `全港 ${COURTS.length} 筆紀錄｜可定位 ${COURTS.filter((c) => c.lng !== null).length}｜待核實 ${COURTS.filter((c) => c.lng === null).length}`;
  const list = COURTS.filter((c) => c.code === code);
  const d = districtByCode.get(code);
  return `${d.zh}：${list.length} 筆紀錄 = 可定位 ${list.filter((c) => c.lng !== null).length} + 待核實 ${list.filter((c) => c.lng === null).length}`;
}

function renderWhere() {
  document.getElementById("where").textContent = currentCode
    ? districtName(currentCode) + "｜" + summary(currentCode)
    : summary(null);
}

function applyScale() {

  G_COURTS.querySelectorAll(".court").forEach((g) => {
    g.setAttribute("transform", `translate(${g.dataset.x} ${g.dataset.y}) scale(${1 / k})`);
  });
  G_LABELS.querySelectorAll("text").forEach((t) => t.setAttribute("font-size", (13 / k).toFixed(2)));
}

function zoomTo(code) {
  const path = document.getElementById("d-" + code);
  if (!path) return;
  const [x, y, w, h] = path.dataset.zoom.split(" ").map(Number);
  k = Math.min((VW * 0.9) / w, (VH * 0.9) / h);
  if (!Number.isFinite(k) || k <= 0) return;
  VP.style.transform =
    `translate(${(VW / 2 - (x + w / 2) * k).toFixed(2)}px, ${(VH / 2 - (y + h / 2) * k).toFixed(2)}px) scale(${k.toFixed(4)})`;
  applyScale();
}

function resetZoom() {
  k = 1;
  VP.style.transform = "translate(0px, 0px) scale(1)";
  applyScale();
}

function districtName(code) {
  const d = districtByCode.get(code);
  return d ? d.zh + " " + d.en : code;
}

// ---- V03：十八區長條圖 ----
// 10 號文件：圖表係「全收錄資料概覽」，只喺開頁撱一次，唔随時間／地區／場地篩選重算；
// 數值永遠用文字直接俾出（唔靠長度估），另備數值表格替代版。
let STATS = [];

async function loadChart() {
  const box = document.getElementById("chartBox");
  const r = await api("/api/stats/districts");
  if (!r.j || !r.j.data) { box.hidden = true; return; }   // 攞唔到就唔画假圖
  STATS = r.j.data;
  renderChart();
}

function renderChart() {
  const max = Math.max(1, ...STATS.map((d) => d.records));
  document.getElementById("chartBars").innerHTML = STATS.map((d) => `
    <li><button type="button" class="chartRow" data-code="${d.code}" aria-pressed="false">
      <span class="chartName">${esc(d.zh)}</span>
      <span class="barTrack" aria-hidden="true"><span class="barFill" style="width:${(d.records / max * 100).toFixed(1)}%"></span></span>
      <span class="chartNum">${d.records} 筆</span>
      <span class="chartSub">可定位 ${d.locatable}｜待核實 ${d.needs_review}</span>
      <span class="chartMark"></span>
    </button></li>`).join("");
  document.querySelector("#chartTable tbody").innerHTML = STATS.map((d) =>
    `<tr data-code="${d.code}"><th scope="row">${esc(d.zh)} ${esc(d.en)}</th><td>${d.records}</td><td>${d.locatable}</td><td>${d.needs_review}</td></tr>`).join("");
  document.getElementById("chartPick").innerHTML =
    '<option value="">（全港）</option>' + DISTRICTS.map((d) => `<option value="${d.code}">${esc(d.zh)} ${esc(d.en)}</option>`).join("");
  const zero = STATS.filter((d) => d.records === 0).map((d) => d.zh);
  const missing = STATS.filter((d) => d.needs_review > 0).map((d) => `${d.zh} ${d.needs_review}`);
  document.getElementById("chartSource").textContent =
    `資料來源：${META.source_dataset || "康文署籃球場資料"}｜共 ${STATS.length} 個區、${META.courts_total} 筆紀錄（可定位 ${META.courts_locatable}、待核實 ${META.courts_without_coords}）。` +
    "「筆數」按原始資料紀錄計算，同一場地可能有重複，本版未做人手去重，所以唔等同場地數。";
  document.getElementById("chartUnassigned").textContent =
    (zero.length ? "無收錄紀錄嘅區：" + zero.join("、") + "。" : "十八區全部都有收錄紀錄。") +
    (missing.length ? " 含待核實紀錄（無有效座標、唔喺地圖上）：" + missing.join("、") + "。" : "");
  syncChart();
}

// 選區由地圖、定位對話框或圖表邊度改都一樣：條圖高亮、下拉、表格三處同步
function syncChart() {
  if (!STATS.length) return;
  document.querySelectorAll("#chartBars .chartRow").forEach((b) => {
    const on = b.dataset.code === currentCode;
    b.setAttribute("aria-pressed", on ? "true" : "false");
    b.querySelector(".chartMark").textContent = on ? "（已選）" : "";
  });
  document.querySelectorAll("#chartTable tbody tr").forEach((tr) =>
    tr.classList.toggle("sel", tr.dataset.code === currentCode));
  const pick = document.getElementById("chartPick");
  if (pick.querySelector("option")) pick.value = currentCode || "";
  document.getElementById("chartClear").disabled = !currentCode;
}

document.getElementById("chartBars").addEventListener("click", (e) => {
  const btn = e.target.closest(".chartRow");
  if (btn) select(btn.dataset.code);
});
document.getElementById("chartPick").addEventListener("change", (e) => {
  const v = e.target.value;
  // （全港）= 清除；揀返同一區則唔好當「再撳一次」而取消選區
  if (v === "") select(null); else if (v !== currentCode) select(v); else syncChart();
});
document.getElementById("chartClear").addEventListener("click", () => select(null));
document.getElementById("chartMode").addEventListener("click", (e) => {
  const useTable = document.getElementById("chartTable").hidden;
  document.getElementById("chartTable").hidden = !useTable;
  document.getElementById("chartBars").hidden = useTable;
  e.currentTarget.setAttribute("aria-pressed", useTable ? "true" : "false");
  e.currentTarget.textContent = useTable ? "改回長條圖" : "改用數值表格";
});

// ---- WF03：球場面板（06 號文件）----
// 面板係地圖圓點嘅替代視圖：三個分頁 = 球場資料｜開波活動｜街場指南（通用內容，唔寫成該場專屬規矩）
let panelCourt = null;
let PANEL_GAMES = [], panelFetchFailed = false;
const CP_TABS = ["info", "games", "guide"];
const FLAG_ZH = {
  possible_no_lighting: "來源備註似乎寫明無射燈，請到場確認",
  complex_court_count: (c) => `球場數原文係「${c.n_raw}」，未能換算成可用半場數`,
  possible_operational_notice: "來源有一則可能影響使用嘅通知；舊通知唔代表而家關閉，日期要自行核實",
  duplicate_source_id: "來源編號重複，呢個可能係另一個獨立場地",
  missing_source_id: "來源缺編號，只能以本站記錄 ID 追溯",
  invalid_coordinates: "座標格式或範圍唔合，唔畫喺地圖、亦唔可發布",
};
const flagText = (f, c) => esc(typeof FLAG_ZH[f] === "function" ? FLAG_ZH[f](c) : (FLAG_ZH[f] || f));

// 未知唔等於 0、唔等於「冇」（D05、V06）
function courtUnknowns(c) {
  const items = [];
  if (c.lighting === "unknown") items.push("照明資料未知（唔係「冇燈」）");
  if (c.cover === "unknown") items.push("有蓋與否未知");
  if (c.suit === "unverified") items.push("適合打半場與否未經人工核實");
  if (c.oper === "unverified") items.push("營運狀態未經人工核實");
  for (const f of c.flags || []) items.push(typeof FLAG_ZH[f] === "function" ? FLAG_ZH[f](c) : (FLAG_ZH[f] || f));
  return items;
}

// 發布資格（04）：無效座標／已核實關閉或不適用 → 阻擋；其餘待核實 → 提醒
function panelEligibility(c) {
  if (c.lng === null || c.lat === null) return { blocked: "呢個場地無有效座標，唔可以喺度發布活動（D02）；「開波活動」分頁仍然可以睇紀錄。" };
  if (c.oper === "closed" || c.suit === "not_suitable") return { blocked: "呢個場地已核實為關閉或不適用，唔准發布（D07）。" };
  const unknown = courtUnknowns(c);
  return unknown.length ? { warn: "場地資料有未核實之處：" + unknown.join("；") + "。發布時會要求你確認已閱讀提醒（D08）。" } : {};
}

function courtFactsHtml(c) {
  const row = (k, v) => `<tr><th scope="row">${k}</th><td>${v}</td></tr>`;
  const calc = c.n_num === null || c.n_num === undefined ? "未能換算" : `可換算 ${c.n_num} 個半場`;
  return `<table class="courtFacts"><tbody>
    ${row("英文名", esc(c.en || "無"))}
    ${row("地址", esc(c.addr || "無"))}
    ${row("原文時間", esc(c.hours || "無"))}
    ${row("球場數（原文）", esc(c.n_raw ?? "未知") + `（${calc}）`)}
    ${row("照明", c.lighting === "unknown" ? "未知（唔等於冇燈）" : esc(c.lighting))}
    ${row("有蓋", c.cover === "unknown" ? "未知（唔等於有蓋或無蓋）" : esc(c.cover))}
    ${row("適合打半場", c.suit === "unverified" ? "未經人工核實" : esc(c.suit))}
    ${row("營運狀態", c.oper === "unverified" ? "未經人工核實" : esc(c.oper))}
    ${row("座標", c.lng === null ? "待核實（無有效座標，唔喺地圖上）" : "格式及範圍通過（仍未經人工核實）")}
    ${row("來源", `<a href="${esc(c.src)}" target="_blank" rel="noopener noreferrer">康文署設施資料</a>（${esc(c.proc || "未知")} 處理；來源行 ${esc(String(c.row ?? "無"))}）`)}
  </tbody></table>
  <p class="fine">以上全部係官方設施紀錄，唔係現場即時情況；設施欄位空值一律顯示「未知」，唔假填 0 或「有」。</p>`;
}

function renderPanelGames() {
  const box = document.getElementById("cpp-games");
  if (panelFetchFailed) { box.innerHTML = `<p class="empty">撱唔到呢個場地嘅活動：server 可能未行，稍後自動重試。</p>`; return; }
  if (!PANEL_GAMES.length) {
    box.innerHTML = `<p class="empty">呢個場地暫無活動回報（唔代表現場冇人）。</p>`;
    return;
  }
  box.innerHTML = `<p class="meta">呢個場地目前有 ${PANEL_GAMES.length} 個活動仍喺招募／已滿／進行中（睇全部時間，跟主頁嘅篩選無關）：</p>
    <ul class="panelGames">` + PANEL_GAMES.map((g) => `<li>
      <span class="badge s-${g.status}">${STATUS_ZH[g.status] || g.status}</span>
      ${esc(g.hk_date)} ${esc(g.hk_time)}–${esc(g.hk_end)}｜${esc(g.format)}｜尚缺 <b>${g.remaining}</b> 人
      ${g.is_demo ? '<span class="badge demo">示範資料</span>' : ""}
    </li>`).join("") + `</ul>
    <p class="fine">加入同管理按鈕喺下面嘅活動卡片（列表已過濾做呢個場地）。</p>`;
}

async function fetchPanelGames(id) {
  const q = new URLSearchParams({ court_id: id, time_filter: "all", status: "recruiting,full,started" });
  const r = await api("/api/games?" + q);
  panelFetchFailed = !r.j || Boolean(r.j.error);
  PANEL_GAMES = panelFetchFailed ? [] : r.j.data;
  renderPanelGames();
}

function renderCpActions(c) {
  const el = document.getElementById("cpActions");
  const warn = document.getElementById("cpWarn");
  const intent = document.querySelector('input[name="cpIntent"]:checked').value;
  const e = panelEligibility(c);
  const href = (i) => "post.html?court=" + encodeURIComponent(c.id) + "&intent=" + i;
  if (e.blocked) {
    el.innerHTML = `<span class="meta">呢個場地唔可發布活動</span>`;
    warn.textContent = e.blocked + "　" + GUIDE.phrases.notReservation;
  } else {
    // 06 WF03：揗「預先約波」時兩個按鈕交換主次，唔轉走用戶原本睌住嘅主按鈕
    const primary = intent === "now" ? "now" : "planned";
    el.innerHTML =
      `<a class="btn${primary === "now" ? " primary" : ""}" href="${href("now")}">喺呢度搵人開波</a>` +
      `<a class="btn${primary === "planned" ? " primary" : ""}" href="${href("planned")}">預先約波</a>`;
    warn.textContent = (e.warn ? e.warn + "　" : "") + GUIDE.phrases.notReservation;
  }
}

function selectCpTab(id, moveFocus) {
  if (!CP_TABS.includes(id)) id = "info";
  for (const key of CP_TABS) {
    const btn = document.getElementById("cpt-" + key);
    btn.setAttribute("aria-selected", key === id ? "true" : "false");
    btn.tabIndex = key === id ? 0 : -1;
    document.getElementById("cpp-" + key).hidden = key !== id;
  }
  if (moveFocus) document.getElementById("cpt-" + id).focus();
}

function openCourtPanel(id) {
  const c = courtById.get(id);
  if (!c) return;
  panelCourt = id;
  document.getElementById("cpTitle").textContent = c.zh + "｜" + districtName(c.code);
  document.getElementById("cpAddr").textContent = summary(c.code) + "｜呢個場地：" + (c.addr || "無地址");
  document.getElementById("cpBadges").innerHTML =
    (c.lng === null ? '<span class="badge warn">位置待核實</span>' : "") +
    (courtUnknowns(c).length ? '<span class="badge warn">資料未核實</span>' : "") +
    '<span class="badge">官方設施資料</span>';
  document.getElementById("cpp-info").innerHTML = courtFactsHtml(c);
  document.getElementById("cpp-guide").innerHTML =
    `<p class="meta">以下係全港通用嘅街場參考（唔係呢個場地專屬規矩；現場安排要先問）：</p>` +
    guideSectionHtml(GUIDE.tabs[0]) + guideSectionHtml(GUIDE.tabs[2]) +
    `<p class="act"><a class="btn" href="guide.html?court=${encodeURIComponent(c.id)}">閱讀完整指南</a></p>`;
  renderCpActions(c);
  document.getElementById("courtPanel").hidden = false;
  selectCpTab("info", false);
  fetchPanelGames(id);
}

function closeCourtPanel() {
  panelCourt = null;
  document.getElementById("courtPanel").hidden = true;
}

function onCourtPick(id) {
  if (currentCourt === id) { currentCourt = null; closeCourtPanel(); explain(""); }
  else {
    currentCourt = id;
    openCourtPanel(id);
    explain(`球場面板：${(courtById.get(id) || {}).zh || id}（再撳同一個圓點或「返回地圖」收埋）。`);
  }
  refreshGames();
}

document.getElementById("cpClose").addEventListener("click", () => {
  currentCourt = null;
  closeCourtPanel();
  explain("");
  refreshGames();
});
document.querySelectorAll('input[name="cpIntent"]').forEach((r) =>
  r.addEventListener("change", () => { if (panelCourt) renderCpActions(courtById.get(panelCourt)); }));
document.getElementById("cpTabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab");
  if (btn) selectCpTab(btn.id.slice(4), true);
});
// 分頁用键盘行到（同指南頁一套 WAI-ARIA tab pattern）
document.getElementById("cpTabs").addEventListener("keydown", (e) => {
  const cur = CP_TABS.indexOf(CP_TABS.find((k) => document.getElementById("cpt-" + k).getAttribute("aria-selected") === "true"));
  const next = { ArrowRight: (cur + 1) % CP_TABS.length, ArrowLeft: (cur + CP_TABS.length - 1) % CP_TABS.length, Home: 0, End: CP_TABS.length - 1 }[e.key];
  if (next === undefined) return;
  e.preventDefault();
  selectCpTab(CP_TABS[next], true);
});

// ---- 活動列表 ----
const STATUS_ZH = {
  recruiting: "招募中", full: "已滿", started: "進行中",
  ended: "已完結", cancelled: "已取消", expired: "已過期",
};

function gameQuery() {
  const q = new URLSearchParams();
  if (currentCode) q.set("code", currentCode);
  if (currentCourt) q.set("court_id", currentCourt);
  if (timeFilter !== "all") q.set("time_filter", timeFilter);
  if (timeFilter === "date") q.set("date", fDate.value);
  const st = ["recruiting", "full"];
  if (fStarted.checked) st.push("started");
  q.set("status", st.join(","));
  return q.toString();
}

let lastFetch = null, lastFetchFailed = false;

async function refreshGames() {
  const r = await api("/api/games?" + gameQuery());
  if (!r.j) { lastFetchFailed = true; renderGames(null); setStatus("撱唔到活動：server 可能未行（保留上次成功嘅畫面）"); return; }
  lastFetchFailed = false;
  if (r.j.error) { setStatus(r.j.error.message); return; }
  lastFetch = new Date();
  GAMES = r.j.data;
  if (fMine.checked) {
    const mg = myGames(), ms = mySignups();
    GAMES = GAMES.filter((g) => mg[g.game_id] || Object.values(ms).some((x) => x.game_id === g.game_id));
  }
  drawCourts(currentCode);
  renderGames(r.j.meta);
}

// 公開 API 唔會返參加者名單（A03），所以自己呢部機嘅狀態要喺本地記住
function mySignupFor(gameId) {
  const ms = mySignups();
  for (const [sid, v] of Object.entries(ms)) if (v.game_id === gameId) return { sid, token: v.token, state: v.state || "going" };
  return null;
}
function saveSignup(sid, gameId, token, state) {
  const ms = mySignups(); ms[sid] = { game_id: gameId, token, state };
  creds.write("hk_signup_tokens", ms);
}
function setSignupState(sid, state) {
  const ms = mySignups();
  if (ms[sid]) { ms[sid].state = state; creds.write("hk_signup_tokens", ms); }
}

function countsLine(g) {
  const site = g.on_site === null ? "現場人數未確認" : `現場約 ${g.on_site} 人已到`;
  return `原有小組 ${g.original_group_size}／${g.target_players}｜網站表示會到 ${g.web_joined}（已到 ${g.web_arrived}）｜${site}｜尚缺 <b>${g.remaining}</b> 人`;
}

function renderGames(meta) {
  const box = document.getElementById("posts");
  box.textContent = "";
  const tip = document.getElementById("fetchNote");
  if (tip) {
    tip.textContent = lastFetchFailed
      ? "上次成功擷取：" + (lastFetch ? lastFetch.toLocaleTimeString("zh-HK", { timeZone: "Asia/Hong_Kong" }) : "未成功過") + "（而家撱唔到，以下係舊畫面）"
      : "擷取時間：" + (lastFetch ? lastFetch.toLocaleTimeString("zh-HK", { timeZone: "Asia/Hong_Kong" }) : "—") +
        `｜模式：${META.mode === "mongo" ? "MongoDB 共享" : "記憶體示範（重啟即冇）"}` +
        (meta && meta.hk_today ? `｜香港今日 ${meta.hk_today}` : "");
  }
  if (!GAMES.length) {
    // V05／07：冇活動回報唔等於現場無人
    box.innerHTML = `<p class="empty">呢個篩選下暫無活動回報（唔代表現場冇人）。<br>
      ${currentCode ? "不如你喺呢個區首個開波？<a href=\"post.html?code=" + currentCode + "\">去發布</a>" : "<a href=\"post.html\">去發布</a>"}</p>`;
    return;
  }
  for (const g of GAMES) {
    const c = courtById.get(g.court_id) || {};
    const mine = mySignupFor(g.game_id);
    const isOrganizer = Boolean(myGames()[g.game_id]);
    const card = document.createElement("article");
    card.className = "card" + (g.is_demo ? " demo" : "") + (g.status === "recruiting" ? "" : " closed");
    card.dataset.game = g.game_id;
    card.innerHTML = `
      <h3>${esc(c.zh || g.court_zh || "未知場地")}</h3>
      <p class="meta">${esc(districtName(g.code))} · ${esc(g.addr || c.addr || "")}</p>
      <p class="tags">
        <span class="badge s-${g.status}">${STATUS_ZH[g.status] || g.status}</span>
        <span class="badge f">${esc(g.format)}（${g.target_players} 人）</span>
        <span class="badge i">${g.creation_intent === "now" ? "即刻開波" : "預先約波"}</span>
        ${g.is_demo ? '<span class="badge demo">示範資料</span>' : ""}
        ${g.beginner_friendly ? '<span class="badge ok">新手歡迎</span>' : ""}
      </p>
      <p class="meta">香港時間 ${esc(g.hk_date)} ${esc(g.hk_time)}–${esc(g.hk_end)}
        ${g.expires_in_min !== null ? "｜名額有效約 " + g.expires_in_min + " 分鐘" : ""}</p>
      <p class="count">${countsLine(g)}</p>
      <progress value="${Math.min(g.committed, g.target_players)}" max="${g.target_players}"></progress>
      ${g.notes ? '<p class="note">' + esc(g.notes) + "</p>" : ""}
      <p class="meta">發起人 ${esc(g.organizer_nickname)}（${g.organizer_presence === "at_court" ? "已在場" : g.organizer_presence === "on_the_way" ? "路上" : "未到"}）
        · 強度 ${esc(g.skill_level)}</p>
      <p class="act">${buttonsFor(g, mine, isOrganizer)}</p>
      <p class="fine">發布活動不等於預留球場，仍需現場跟隊。資料來源：康文署（${esc(g.court_source && g.court_source.processing_date || "")} 處理）</p>`;
    box.appendChild(card);
  }
}

function buttonsFor(g, mine, isOrganizer) {
  const b = [];
  if (g.joinable && !mine) b.push(`<button data-act="join" data-game="${g.game_id}">我會去</button>`);
  if (mine) {
    if (g.status === "recruiting" || g.status === "full" || g.status === "started") {
      b.push(`<button data-act="arrive" data-game="${g.game_id}" data-signup="${mine.sid}" ${mine.state === "arrived" ? "disabled" : ""}>${mine.state === "arrived" ? "已報到" : "我已到場"}</button>`);
      if (mine.state !== "withdrawn") b.push(`<button data-act="withdraw" data-game="${g.game_id}" data-signup="${mine.sid}">退出</button>`);
    }
    if (mine.state === "withdrawn" && g.joinable) b.push(`<button data-act="rejoin" data-game="${g.game_id}" data-signup="${mine.sid}">重新加入</button>`);
  }
  if (isOrganizer) {
    if (g.status === "recruiting" || g.status === "full") b.push(`<button data-act="confirm" data-game="${g.game_id}">仍喺度招募</button>`);
    if (g.status === "recruiting" || g.status === "full") b.push(`<button data-act="start" data-game="${g.game_id}">開始</button>`);
    if (g.status === "started") b.push(`<button data-act="end" data-game="${g.game_id}">完結</button>`);
    if (g.status === "recruiting" || g.status === "full") b.push(`<button data-act="cancel" data-game="${g.game_id}">取消</button>`);
  }
  return b.join("") || '<span class="meta">呢個活動已結束，詳情可讀</span>';
}

// ---- 動作：全部去 server 做，本機只記自己嘅憑證 ----
async function doAction(act, gameId, signupId) {
  const g = GAMES.find((x) => x.game_id === gameId);
  const mine = signupId ? mySignups()[signupId] : null;
  let r;
  if (act === "join") {
    const nick = document.getElementById("jNick").value.trim();
    if (!nick) { joinHint.textContent = "要填暱稱（1–30 字）。"; return false; }
    // datetime-local 嘅值冇時區，瀏覽器會按自己嘅時區解釋；活動顯示嘅係香港時間，
    // 所以要同 post.js 一樣補 +08:00，否則喺非 HK 時區嘅機上會存入另一日（05：日期用含時區嘅 ISO8601）
    const etaRaw = document.getElementById("jEta").value;
    const eta = etaRaw
      ? new Date(etaRaw + (etaRaw.length === 16 ? ":00" : "") + "+08:00").toISOString() : undefined;
    r = await api(`/api/games/${gameId}/signups`, { method: "POST", body: { participant_nickname: nick, estimated_arrival_at: eta }, idem: joinKey });
    if (r.status === 201) { saveSignup(r.j.private.signup_id, gameId, r.j.private.manage_token, "going"); joinKey = null; joinKeyGame = null; }
  } else if (act === "arrive") {
    r = await api(`/api/games/${gameId}/signups/${signupId}`, { method: "PATCH", token: mine.token, body: { attendance_status: "arrived" } });
    if (r.status === 200) setSignupState(signupId, "arrived");
  } else if (act === "withdraw") {
    r = await api(`/api/games/${gameId}/signups/${signupId}/withdraw`, { method: "POST", token: mine.token });
    if (r.status === 200) setSignupState(signupId, "withdrawn");
  } else if (act === "rejoin") {
    r = await api(`/api/games/${gameId}/signups/${signupId}/rejoin`, { method: "POST", token: mine.token });
    if (r.status === 200) setSignupState(signupId, "going");
  } else {                                     // 發起人動作
    const token = myGames()[gameId];
    if (!token) { explain("呢部機冇Save到活動嘅管理憑證（換咗裝置或清除過瀏覽器資料），所以改唔到；可以重新發布一個。"); return false; }
    r = await api(`/api/games/${gameId}/${act}`, { method: "POST", token });
  }

  if (r.status >= 400) {
    const code = r.j && r.j.error ? r.j.error.code : "network";
    const why = {
      game_full: "名額啱啱被人搶咗，已經幫你刷新列表。",
      not_joinable: (r.j.error && r.j.error.message) || "呢個活動而家唔接受加入。",
      not_yet_due: (r.j.error && r.j.error.message) || "未到你填嘅開始時間。",
      bad_phase: (r.j.error && r.j.error.message) || "活動狀態唔支援呢個操作。",
      unauthorized: "憑證唔正確：隱藏按鈕唔等於權限，伺服器會再拒一次（A01）。",
      not_open: (r.j.error && r.j.error.message) || "活動已終止，紀錄唔再改動。",
      withdrawn: "你已經退出咗，用「重新加入」會重驗名額。",
      idempotency_conflict: "同一把 Idempotency-Key 用咗唔同嘅內容（05 第 32 行），已拒絕，冇多佔名額。",
      idempotency_in_progress: "啱啱那次送出仲喺度處理，等佢完成再試。",
      idempotency_stale: "原 key 对应嘅紀錄已唔喺資料庫，請重新填寫送出。",
    };
    explain(why[code] || ("錯誤 " + code + "：" + ((r.j.error && r.j.error.message) || "網絡失敗，你輸入嘅內容保留喺度")));
    if (code === "game_full" || code === "not_joinable") await refreshGames();
    return false;
  }
  explain("");
  if (act === "start" && !document.getElementById("fStarted").checked) {
    document.getElementById("fStarted").checked = true;   // 否則張卡即刻从清單消失
  }
  await refreshGames();
  if (act === "start") explain(`活動已開始（${gameId}），列表已自動包括進行中嘅活動。`, true);
  if (act === "end" || act === "cancel") explain(`活動已結算（${gameId}）：終止後嘅紀錄唔喺預設清單顯示，因為列表只列招募中／已滿／進行中。`, true);
  return true;
}

function explain(msg, good) {
  const el = document.getElementById("msgline");
  el.textContent = msg;
  el.style.color = msg ? (good ? "#7ee2a8" : "#ff9a9a") : "";
}

// 由 post.html 跳返嚟會帶 ?game=ID：指出啱啱嗰個活動喺邊
async function focusFromUrl() {
  const id = new URLSearchParams(location.search).get("game");
  if (!id) return;
  let card = document.querySelector(`#posts .card[data-game="${CSS.escape(id)}"]`);
  if (!card) {
    const r = await api(`/api/games/${id}`);
    if (!(r.j && r.j.data)) { explain(`搵唔到活動 ${id}：可能已過期或已被清除。`); return; }
    timeFilter = "all"; fTime.value = "all";            // 預設「現在」唔會顯示將來嘅約波
    await refreshGames();
    card = document.querySelector(`#posts .card[data-game="${CSS.escape(id)}"]`);
    if (!card) { explain(`活動 ${id} 嘅狀態唔喺列表範圍（已完結／已取消）。`); return; }
  }
  card.classList.add("flash");
  card.scrollIntoView({ behavior: "smooth", block: "center" });
  explain(`你啱啱發布嘅活動已經上線（${id}）。管理按鈕喺張卡入面。`, true);
}

// 由指南頁「返回球場」返嚟會帶 ?court=ID：直接開返該場地嘅面板（WF03）
async function openCourtFromUrl() {
  const id = new URLSearchParams(location.search).get("court");
  if (!id) return;
  if (!courtById.has(id)) { explain(`搵唔到場地 ${id}：可能資料已重載，請喺地圖重新拾場。`); return; }
  const c = courtById.get(id);
  if (c.code !== currentCode) select(c.code);
  currentCourt = id;
  openCourtPanel(id);
  explain(`已打開「${c.zh}」嘅球場面板。`, true);
  await refreshGames();
  document.getElementById("courtPanel").scrollIntoView({ behavior: "smooth", block: "start" });
}

// 「我會去」用原生 <dialog>，唔使另開一頁（WF04）
const joinDlg = document.getElementById("joinDlg");
const joinHint = document.getElementById("joinHint");
// 同一個活動嘅「我會去」重試（撳多一次、或者失敗再送）用同一把 key，唔會多佔位（C06）
let joinTarget = null, joinKey = null, joinKeyGame = null;
const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : "k" + Date.now() + Math.random().toString(16).slice(2));

document.getElementById("posts").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const { act, game, signup } = btn.dataset;
  btn.disabled = true;
  try {
    if (act === "join") {
      joinTarget = game;
      if (joinKeyGame !== game) { joinKey = newKey(); joinKeyGame = game; }
      const gm = GAMES.find((g) => g.game_id === game) || {};
      joinHint.textContent = "你嘅暱稱會公開顯示喺活動卡片；預計到達時間已預填活動當日，可以改。";
      document.getElementById("jGame").textContent = gm.court_zh || game;
      // 預計到達時間：預設活動嗰日嘅開始時間（04：本版活動唔跨午夜，所以 min/max 也鎖喺同一日）
      // 已經打咗嘢就唔好蓋住 —— 重試時要保留用戶輸入（C06 嘅同一把 key 先至有意義）
      const etaIn = document.getElementById("jEta");
      if (!etaIn.value && gm.hk_date) {
        etaIn.value = gm.hk_date + "T" + (gm.hk_time || "19:30");
        etaIn.min = gm.hk_date + "T00:00";
        etaIn.max = gm.hk_date + "T23:59";
      }
      joinDlg.showModal();
    } else {
      await doAction(act, game, signup);
    }
  } finally { btn.disabled = false; }
});
document.getElementById("jGo").addEventListener("click", async () => {
  const done = await doAction("join", joinTarget);
  if (done) { joinDlg.close(); document.getElementById("jNick").value = ""; document.getElementById("jEta").value = ""; }
});
document.getElementById("jCancel").addEventListener("click", () => joinDlg.close());

// ---- 選區／篩選 ----
function select(code) {
  const same = code === currentCode;
  svg.querySelectorAll("#districts path.sel").forEach((p) => p.classList.remove("sel"));
  if (same || !code) { currentCode = null; resetZoom(); }
  else {
    currentCode = code;
    document.getElementById("d-" + code).classList.add("sel");
    zoomTo(code);
  }
  currentCourt = null;
  closeCourtPanel();          // 換區就收埋面板，否則面板會讲住舊區嘅場地
  renderWhere();
  syncChart();
  document.getElementById("btnReset").disabled = !currentCode;
  refreshGames();
}

svg.querySelectorAll("#districts path").forEach((path) => {
  path.addEventListener("click", () => select(path.dataset.district));
});
G_COURTS.addEventListener("click", (e) => {
  const g = e.target.closest(".court");
  if (g) onCourtPick(g.dataset.court);
});
G_COURTS.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const g = e.target.closest(".court");
  if (!g) return;
  e.preventDefault();
  onCourtPick(g.dataset.court);
});
document.getElementById("btnReset").addEventListener("click", () => select(null));
document.getElementById("btnLabels").addEventListener("click", (e) => {
  G_LABELS.classList.toggle("hidden");
  e.currentTarget.classList.toggle("on");
});
document.getElementById("btnCourts").addEventListener("click", (e) => {
  G_COURTS.classList.toggle("hidden");
  e.currentTarget.classList.toggle("on");
});
fTime.addEventListener("change", () => {
  timeFilter = fTime.value;
  fDate.hidden = timeFilter !== "date";
  refreshGames();
});
fDate.addEventListener("change", () => refreshGames());
fStarted.addEventListener("change", () => refreshGames());
fMine.addEventListener("change", () => refreshGames());

// ---- 定位：用 isPointInFill 做命中測試，唔使喺 JS 再寫 point-in-polygon ----
let geoCode = null;

function districtAt(lon, lat) {
  const [x, y] = project(lon, lat);
  const pt = new DOMPoint(x, y);
  const hit = [...svg.querySelectorAll("#districts path")].find((p) => p.isPointInFill(pt));
  return hit ? hit.dataset.district : null;
}

function openGeoPrompt(code, accuracy) {
  geoCode = code;
  document.getElementById("geoQ").textContent = "你而家喺 " + districtName(code) + "嗎？";
  document.getElementById("geoHint").textContent =
    "瀏覽器話你嘅位置大約准 " + Math.round(accuracy) + " 米；座標只喺你部機度計，唔會傳去任何伺服器。拒絕或失敗都仍然可以手動選區（L01）。";
  const pick = document.getElementById("geoPick");
  if (!pick.options.length) pick.innerHTML = DISTRICTS.map((d) => `<option value="${d.code}">${esc(d.zh)} ${esc(d.en)}</option>`).join("");
  document.getElementById("geoDlg").showModal();
}

function askLocation(manual) {
  if (!navigator.geolocation) { if (manual) explain("呢個瀏覽器唔支援定位，請手動選區（L01）。"); return; }
  // 每個分頁只自動問一次：發布完跳返主頁（?game=）嗰刻用戶要睇自己啱啱建嘅活動，唔好再彈攞住
  // manual 係用戶自己撳「定位」（06 號 WF02 的 [定位] 入口），所以豁免呢條規則
  if (!manual) {
    if (sessionStorage.getItem("hkGeoAsked")) return;
    if (new URLSearchParams(location.search).get("game")) return;
    sessionStorage.setItem("hkGeoAsked", "1");
  }
  if (manual) explain("定位中…", true);
  // timeout 20 秒：手機第一次鎖星往往超過 8 秒；開頁自動問嗰陣失敗仍然靜默
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const code = districtAt(pos.coords.longitude, pos.coords.latitude);
      if (code) { if (manual) explain(""); openGeoPrompt(code, pos.coords.accuracy); }   // 命中唔到（海面／唔喺香港）就唔彈
      else if (manual) explain(`座標 ${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(4)}（准 ${Math.round(pos.coords.accuracy)} 米）唔喺十八區內，請手動選區（L01）。`);
    },
    (err) => {
      if (!manual) return;
      explain(err.code === 1
        ? "你拒絕咗瀏覽器授權，仍然可以手動選區或搜尋（L01）。"
        : `定位失敗：代碼 ${err.code}（1=拒絕、2=度唔到、3=太慢），請手動選區（L01）。`);
    },
    { timeout: 20000, maximumAge: 600000 }
  );
}

document.getElementById("btnLocate").addEventListener("click", () => askLocation(true));

document.getElementById("geoYes").addEventListener("click", () => {
  document.getElementById("geoDlg").close();
  if (geoCode) select(geoCode);
});
document.getElementById("geoNo").addEventListener("click", () => document.getElementById("geoDlg").close());
document.getElementById("geoGo").addEventListener("click", () => {
  const code = document.getElementById("geoPick").value;
  document.getElementById("geoDlg").close();
  if (code) select(code);
});

// 05：活動頁可見期間約 30 秒輪詢，隱藏就暫停（唔係即時串流，失敗保留上次時間）
setInterval(() => {
  if (document.hidden || joinDlg.open || document.getElementById("geoDlg").open) return;
  refreshGames();
  if (panelCourt) fetchPanelGames(panelCourt);   // 面板嘅「開波活動」分頁用同一個輪詢節奏
}, 30000);

boot();
