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

startLanding();   // A：進站第一幕要即刻鋪上去，唔好等 API 資料載入完先見到

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
    // WF02：地圖有清單替代之外，圓點本身都要用鍵盤到（撳入就開球場面板）
    g.setAttribute("tabindex", "0");
    g.setAttribute("role", "button");
    g.setAttribute("aria-label", `${c.zh} ${c.en || ""}，${districtName(c.code)}，撳入睇球場面板`);
    if (c.id === currentCourt) g.classList.add("sel");
    g.append(dot, t);
    G_COURTS.appendChild(g);
  }
}

// C.1／D：「X 筆紀錄 = 可定位 Y + 待核實 Z」呢類副標題已刪；
// 可定位／待核實嘅區分改由街場地圖嘅圖表負責，所以 V01「唔混計」仍然成立
function renderWhere() {
  document.getElementById("where").textContent = currentCode ? districtName(currentCode) : "全港十八區";
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
// 10 號文件：圖表係「全收錄資料概覽」，只喺開頁撱一次，唔隨時間／地區／場地篩選重算；
// 數值永遠用文字直接俾出（唔靠長度估），另備數值表格替代版。
let STATS = [];

async function loadChart() {
  const box = document.getElementById("knowBox");
  const r = await api("/api/stats/districts");
  if (!r.j || !r.j.data) { box.hidden = true; return; }   // 攞唔到就唔畫假圖
  STATS = r.j.data;
  renderChart();
  renderRatioChart();
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

// D Tab B 第二張圖：每 10 萬人有幾多筆球場紀錄。
// 分子係收錄紀錄數（未去重，所以唔等同場地數）；分母係 2021 年人口普查嘅區議會分區總人口。
// 兩個數嘅年份唔同（場地資料 2026 處理、人口 2021 普查），所以圖下面要講清楚
function renderRatioChart() {
  const rows = STATS.map((d) => {
    const pop = POP2021[d.code];
    return { code: d.code, zh: d.zh, en: d.en, records: d.records, pop, per100k: d.records / pop * 100000 };
  }).sort((a, b) => b.per100k - a.per100k);
  const max = Math.max(...rows.map((r) => r.per100k));
  const nf = new Intl.NumberFormat("en-US");
  document.getElementById("ratioBars").innerHTML = rows.map((r) => `
    <li><button type="button" class="chartRow" data-code="${r.code}" aria-pressed="false">
      <span class="chartName">${esc(r.zh)}</span>
      <span class="barTrack" aria-hidden="true"><span class="barFill" style="width:${(r.per100k / max * 100).toFixed(1)}%"></span></span>
      <span class="chartNum">每 10 萬人 ${r.per100k.toFixed(1)} 筆</span>
      <span class="chartSub">${r.records} 筆紀錄｜人口 ${nf.format(r.pop)}（2021）</span>
      <span class="chartMark"></span>
    </button></li>`).join("");
  document.querySelector("#ratioTable tbody").innerHTML = rows.map((r) =>
    `<tr data-code="${r.code}"><th scope="row">${esc(r.zh)} ${esc(r.en)}</th><td>${r.records}</td><td>${nf.format(r.pop)}</td><td>${r.per100k.toFixed(1)}</td></tr>`).join("");
  const top = rows[0], bottom = rows[rows.length - 1];
  document.getElementById("ratioSource").textContent =
    `人口來源：${POP2021_SOURCE}。球場紀錄來源：${META.source_dataset || "康文署籃球場資料"}（${META.courts_total} 筆）。` +
    `全港平均：每 10 萬人 ${(STATS.reduce((a, d) => a + d.records, 0) / POP2021_LAND_TOTAL * 100000).toFixed(1)} 筆。`;
  document.getElementById("ratioNote").textContent =
    `最高係${top.zh}（每 10 萬人 ${top.per100k.toFixed(1)} 筆），最低係${bottom.zh}（${bottom.per100k.toFixed(1)} 筆）。` +
    "呢個比例只係「收錄紀錄 ÷ 常住人口」：紀錄未完成去重，所以唔等同實際球場數；人口係 2021 年普查數字（唔含水上人口），" +
    "同場地資料嘅年份唔同；亦唔反映交通便利程度、場地質素或者實際使用率。";
  syncChart();
}

// 選區由地圖、定位對話框或圖表邊度改都一樣：條圖高亮、下拉、表格三處同步
function syncChart() {
  if (!STATS.length) return;
  document.querySelectorAll("#chartBars .chartRow, #ratioBars .chartRow").forEach((b) => {
    const on = b.dataset.code === currentCode;
    b.setAttribute("aria-pressed", on ? "true" : "false");
    b.querySelector(".chartMark").textContent = on ? "（已選）" : "";
  });
  document.querySelectorAll("#chartTable tbody tr, #ratioTable tbody tr").forEach((tr) =>
    tr.classList.toggle("sel", tr.dataset.code === currentCode));
  const pick = document.getElementById("chartPick");
  if (pick.querySelector("option")) pick.value = currentCode || "";
  document.getElementById("chartClear").disabled = !currentCode;
}

// 兩張圖同「選區」下拉都喺 Tab B：撳完就跳返 Tab A，等用戶真係睇到地圖放大咗（唔係淨係行高亮）
function chartPicked(code) {
  if (document.body.dataset.view === "courts" && document.body.dataset.tab === "know") setMapTab("map");
  select(code);
}
document.getElementById("chartBars").addEventListener("click", (e) => {
  const btn = e.target.closest(".chartRow");
  if (btn) chartPicked(btn.dataset.code);
});
document.getElementById("ratioBars").addEventListener("click", (e) => {
  const btn = e.target.closest(".chartRow");
  if (btn) chartPicked(btn.dataset.code);
});
document.getElementById("chartPick").addEventListener("change", (e) => {
  const v = e.target.value;
  // （全港）= 清除；揀返同一區則唔好當「再撳一次」而取消選區
  if (v === "") select(null); else if (v !== currentCode) chartPicked(v); else syncChart();
});
document.getElementById("chartClear").addEventListener("click", () => select(null));
document.getElementById("chartMode").addEventListener("click", (e) => {
  const useTable = document.getElementById("chartTable").hidden;
  document.getElementById("chartTable").hidden = !useTable;
  document.getElementById("chartBars").hidden = useTable;
  e.currentTarget.setAttribute("aria-pressed", useTable ? "true" : "false");
  e.currentTarget.textContent = useTable ? "改回長條圖" : "改用數值表格";
});
document.getElementById("ratioMode").addEventListener("click", (e) => {
  const useTable = document.getElementById("ratioTable").hidden;
  document.getElementById("ratioTable").hidden = !useTable;
  document.getElementById("ratioBars").hidden = useTable;
  e.currentTarget.setAttribute("aria-pressed", useTable ? "true" : "false");
  e.currentTarget.textContent = useTable ? "改回長條圖" : "改用數值表格";
});

// ---- WF03：球場面板（06 號文件）----
// 面板係地圖圓點嘅替代視圖。D（Round 1）：兩個分頁 = 球場資料｜開波活動（嵌套嘅街場指南分頁已刪，
// 指南內容一律去 guide.html 睇）；照明／有蓋／適合打半場／營運狀態四個欄位同官方免責細字亦已刪，
// 未核實呢件事只用一行細字講（#cpWarn）
let panelCourt = null;
let PANEL_GAMES = [], panelFetchFailed = false;
const CP_TABS = ["info", "games"];

// 發布資格（04）：無效座標／已核實關閉或不適用 → 阻擋（D02、D07）。其餘照准發布，只保留一行提醒
function panelEligibility(c) {
  if (c.lng === null || c.lat === null) return { blocked: "呢個場地無有效座標，唔可以喺度發布活動（D02）；「開波活動」分頁仍然可以睇紀錄。" };
  if (c.oper === "closed" || c.suit === "not_suitable") return { blocked: "呢個場地已核實為關閉或不適用，唔准發布（D07）。" };
  return {};
}

function courtFactsHtml(c) {
  const row = (k, v) => `<tr><th scope="row">${k}</th><td>${v}</td></tr>`;
  const calc = c.n_num === null || c.n_num === undefined ? "未能換算" : `可換算 ${c.n_num} 個半場`;
  return `<table class="courtFacts"><tbody>
    ${row("英文名", esc(c.en || "無"))}
    ${row("地址", esc(c.addr || "無"))}
    ${row("原文時間", esc(c.hours || "無"))}
    ${row("球場數（原文）", esc(c.n_raw ?? "未知") + `（${calc}）`)}
    ${row("座標", c.lng === null ? "來源冇座標" : `${c.lat}, ${c.lng}`)}
    ${row("來源", `<a href="${esc(c.src)}" target="_blank" rel="noopener noreferrer">康文署設施資料</a>（${esc(c.proc || "未知")} 處理；來源行 ${esc(String(c.row ?? "無"))}）`)}
  </tbody></table>`;
}

function renderPanelGames() {
  const box = document.getElementById("cpp-games");
  if (panelFetchFailed) { box.innerHTML = `<p class="empty">撱唔到呢個場地嘅活動：server 可能未行，稍後自動重試。</p>`; return; }
  if (!PANEL_GAMES.length) {
    box.innerHTML = `<p class="empty">呢個場地暫無活動回報（唔代表現場冇人）。</p>`;
    return;
  }
  // D：面板呢個分頁直接用主列表同一套卡（C.4 格式＋加入／管理按鈕）。
  // 街場地圖分頁下面並冇另一個活動列表，所以唔可以再叫用戶「去下面嘅卡片」
  box.textContent = "";
  const head = document.createElement("p");
  head.className = "meta";
  head.textContent = `呢個場地目前有 ${PANEL_GAMES.length} 個活動仍喺招募／已滿／進行中（睇全部時間）：`;
  box.appendChild(head);
  for (const g of PANEL_GAMES) box.appendChild(gameCard(g));
}
document.getElementById("cpp-games").addEventListener("click", onGameActionClick);

async function fetchPanelGames(id) {
  const q = new URLSearchParams({ court_id: id, time_filter: "all", status: "recruiting,full,started" });
  const r = await api("/api/games?" + q);
  panelFetchFailed = !r.j || Boolean(r.j.error);
  PANEL_GAMES = panelFetchFailed ? [] : r.j.data;
  renderPanelGames();
}

// D：兩張大卡（即刻開波／預先約波）嘅 markup 喺 HTML 度，呢度只負責填深連結 href；
// 唔可發布嘅場地就收埋成組卡，用一行字講明原因
function renderCpActions(c) {
  const e = panelEligibility(c);
  const href = (i) => "post.html?court=" + encodeURIComponent(c.id) + "&intent=" + i;
  document.getElementById("cpActions").hidden = Boolean(e.blocked);
  document.getElementById("cpNow").href = href("now");
  document.getElementById("cpLater").href = href("planned");
  // 三行誠實字之一（未核實提醒）：保留一行細字，唔再逐項列明、亦唔再強制剔確認
  document.getElementById("cpWarn").textContent = e.blocked ||
    "呢個場地嘅照明、有蓋、適合半場與營運狀態等資料未經人工核實，到場前請自行確認。";
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
  document.getElementById("cpAddr").textContent = "地址：" + (c.addr || "無地址");
  // D：「資料未核實」同「官方設施資料」兩個 tag 已刪；只保留「位置待核實」，
  // 因為佢解釋緊點解呢個場地唔喺地圖上、亦唔准發布（功能資訊，唔係免責聲明）
  document.getElementById("cpBadges").innerHTML =
    c.lng === null ? '<span class="badge warn">位置待核實</span>' : "";
  document.getElementById("cpp-info").innerHTML = courtFactsHtml(c);
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
document.getElementById("cpTabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab");
  if (btn) selectCpTab(btn.id.slice(4), true);
});
// 分頁用鍵盤行到（同指南頁一套 WAI-ARIA tab pattern）
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

// C.1：時間下拉同「進行中」toggle 已刪 —— 列表一律攞全部時間、招募中／已滿／進行中，
// 時段瀏覽改由分區 overlay 嘅時間窗分頁負責（C.3）
function gameQuery() {
  const q = new URLSearchParams();
  if (currentCode) q.set("code", currentCode);
  if (currentCourt) q.set("court_id", currentCourt);
  q.set("status", "recruiting,full,started");
  return q.toString();
}

let lastFetch = null, lastFetchFailed = false;
let HK_TODAY = null;          // server 嘅香港今日（V08：時間窗分頁要用呢個，唔用本機時鐘）

async function refreshGames() {
  const r = await api("/api/games?" + gameQuery());
  if (!r.j) { lastFetchFailed = true; renderGames(null); setStatus("撱唔到活動：server 可能未行（保留上次成功嘅畫面）"); return; }
  lastFetchFailed = false;
  if (r.j.error) { setStatus(r.j.error.message); return; }
  lastFetch = new Date();
  GAMES = r.j.data;
  if (r.j.meta && r.j.meta.hk_today) HK_TODAY = r.j.meta.hk_today;
  drawCourts(currentCode);
  renderGames(r.j.meta);
  if (distDlg.open) renderWinGames();       // C.3：overlay 開住就一齊更新（輪詢／撳完按鈕都適用）
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

// C.4：張卡嘅人數行 —— 即刻開波講「已經到咗幾個」，預先約波講「有幾多人會黎」；
// 「X 個網友會到」只有真係有人報咗先至出現；「未知」唔可以顯示做 0（J03、V04）
function countsLine(g) {
  const head = g.creation_intent === "now"
    ? (g.on_site === null ? "已經到咗幾多未知" : `已經到咗 ${g.on_site} 個`)
    : `有 ${g.original_group_size} 人會黎`;
  const web = g.web_joined > 0 ? `｜${g.web_joined} 個網友會到` : "";
  return `${head}${web}｜尚缺 <b>${g.remaining}</b> 人`;
}

// C.4：日期顯示做英文月份縮寫（Nov 19），時間仍然係香港時間（server 用 hk_date／hk_time 俾）
const MON_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function hkDayLabel(dateStr) {
  const [y, m, d] = String(dateStr || "").split("-").map(Number);
  return MON_EN[m - 1] && d ? `${MON_EN[m - 1]} ${d}` : (dateStr || "");
}
// 距今日有幾日：用 server 嘅 hk_today 做基準，唔用呢部機嘅時鐘（V08）
function dayOffset(dateStr) {
  const a = String(HK_TODAY || "").split("-").map(Number);
  const b = String(dateStr || "").split("-").map(Number);
  if (a.length !== 3 || b.length !== 3 || a.some(Number.isNaN) || b.some(Number.isNaN)) return null;
  return Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 86400000);
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
    box.innerHTML = `<p class="empty">呢個範圍暫無活動回報（唔代表現場冇人）。<br>
      ${currentCode ? "不如你喺呢個區首個開波？<a href=\"post.html?code=" + currentCode + "\">去發布</a>" : "<a href=\"post.html\">去發布</a>"}</p>`;
    return;
  }
  for (const g of GAMES) box.appendChild(gameCard(g));
}

// C.4：張卡嘅格式（時間行、人數行、發起人狀態）。列表同分區 overlay 用同一個 renderer，
// 所以兩邊嘅按鈕、憑證、示範資料標記行為完全一樣
const SKILL_ZH = {
  unspecified: "無所謂", casual: "輕鬆", intermediate: "中等", high_intensity: "進階",
};
function gameCard(g) {
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
      <p class="meta">${esc(hkDayLabel(g.hk_date))} ${esc(g.hk_time)}–${esc(g.hk_end)}
        ${g.expires_in_min !== null ? "｜名額有效約 " + g.expires_in_min + " 分鐘" : ""}</p>
      <p class="count">${countsLine(g)}</p>
      <progress value="${Math.min(g.committed, g.target_players)}" max="${g.target_players}"></progress>
      ${g.notes ? '<p class="note">' + esc(g.notes) + "</p>" : ""}
      <p class="meta">發起人 ${esc(g.organizer_nickname)}（${g.organizer_presence === "at_court" ? "已到" : "未到"}）
        · 強度 ${esc(SKILL_ZH[g.skill_level] || g.skill_level)}</p>
      ${actLine(g, mine, isOrganizer)}`;
  return card;
}

// 冇按鈕就唔好喺張卡尾加字：呢度只會列招募中／已滿／進行中，寫「已結束」係假資訊
function actLine(g, mine, isOrganizer) {
  const html = buttonsFor(g, mine, isOrganizer);
  return html ? `<p class="act">${html}</p>` : "";
}

function buttonsFor(g, mine, isOrganizer) {
  const b = [];
  if (g.joinable && !mine) b.push(`<button data-act="join" data-game="${g.game_id}">我會到</button>`);
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
  return b.join("");
}

// ---- 動作：全部去 server 做，本機只記自己嘅憑證 ----
async function doAction(act, gameId, signupId) {
  const g = GAMES.find((x) => x.game_id === gameId);
  const mine = signupId ? mySignups()[signupId] : null;
  let r;
  if (act === "join") {
    // C.4：「我會到」唔再問暱稱 —— 呢個網站唔設帳號，參加者對其他人係匿名（A03）
    // datetime-local 嘅值冇時區，瀏覽器會按自己嘅時區解釋；活動顯示嘅係香港時間，
    // 所以要同 post.js 一樣補 +08:00，否則喺非 HK 時區嘅機上會存入另一日（05：日期用含時區嘅 ISO8601）
    const etaRaw = document.getElementById("jEta").value;
    const eta = etaRaw
      ? new Date(etaRaw + (etaRaw.length === 16 ? ":00" : "") + "+08:00").toISOString() : undefined;
    r = await api(`/api/games/${gameId}/signups`, { method: "POST", body: { estimated_arrival_at: eta }, idem: joinKey });
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
      idempotency_stale: "原 key 對應嘅紀錄已唔喺資料庫，請重新填寫送出。",
    };
    explain(why[code] || ("錯誤 " + code + "：" + ((r.j.error && r.j.error.message) || "網絡失敗，你輸入嘅內容保留喺度")));
    if (code === "game_full" || code === "not_joinable") await refreshEverywhere();
    return false;
  }
  explain("");
  await refreshEverywhere();   // C.1：「進行中」toggle 已刪，列表本身就包 started，唔使再改篩選
  if (act === "start") explain(`活動已開始（${gameId}），列表已自動包括進行中嘅活動。`, true);
  if (act === "end" || act === "cancel") explain(`活動已結算（${gameId}）：終止後嘅紀錄唔喺預設清單顯示，因為列表只列招募中／已滿／進行中。`, true);
  return true;
}

function explain(msg, good) {
  const el = document.getElementById("msgline");
  el.textContent = msg;
  el.style.color = msg ? (good ? "#7ee2a8" : "#ff9a9a") : "";
}

// 改動完要同時刷新三個位置：主列表、時間窗 overlay（refreshGames 結尾自己做）、球場面板嘅開波活動分頁
async function refreshEverywhere() {
  await refreshGames();
  if (panelCourt) await fetchPanelGames(panelCourt);
}

// 由 post.html 跳返嚟會帶 ?game=ID：指出啱啱嗰個活動喺邊
async function focusFromUrl() {
  const id = new URLSearchParams(location.search).get("game");
  if (!id) return;
  let card = document.querySelector(`#posts .card[data-game="${CSS.escape(id)}"]`);
  if (!card) {
    const r = await api(`/api/games/${id}`);
    if (!(r.j && r.j.data)) { explain(`搵唔到活動 ${id}：可能已過期或已被清除。`); return; }
    await refreshGames();      // C.1：冇時間篩選，列表本身就包晒招募中／已滿／進行中
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

// A：進站第一幕 —— 冇帶 ?view= 就用四張大卡蓋住街場地圖畫面。
//    ?view=games／?view=courts 係兩張地圖卡嘅目的地；?game=／?court= 係深連結（發布完跳返、指南返回），都唔好俾第一幕擋住
function startLanding() {
  const qs = new URLSearchParams(location.search);
  const view = qs.get("view");
  const land = document.getElementById("landing");
  if (view || qs.get("game") || qs.get("court")) {
    land.remove();
    setView(view === "courts" ? "courts" : "games");
    return;
  }
  setView("courts");                       // 第一幕嘅背景就係街場地圖
  land.hidden = false;
  land.querySelector(".landBtn").focus();
  const close = () => { land.hidden = true; };
  land.addEventListener("click", (e) => { if (e.target === land) close(); });
  addEventListener("keydown", (e) => { if (e.key === "Escape" && !land.hidden) close(); });
}

// 同一頁兩種用途：games＝睇有咩波打（冇分頁、冇圖表）、courts＝街場地圖（兩個分頁）
// 邊塊顯示由 CSS 用 body[data-view] ＋ body[data-tab] 控制，所以呢度只負責改 dataset
function setView(v) {
  document.body.dataset.view = v;
  document.body.dataset.tab = "map";        // 每次入頁都由 Tab A（球場地圖）開始
  document.querySelectorAll("nav a").forEach((a) => a.removeAttribute("aria-current"));
  const link = document.querySelector(`nav a[href="index.html?view=${v}"]`);
  if (link) link.setAttribute("aria-current", "page");
}

// D：街場地圖嘅兩個分頁 —— Tab A 球場地圖（#mapWrap＋球場面板）｜Tab B Do you know…?（#knowBox 兩張圖）
const MAP_TABS = ["map", "know"];
function setMapTab(id, moveFocus) {
  if (!MAP_TABS.includes(id)) id = "map";
  document.body.dataset.tab = id;
  for (const key of MAP_TABS) {
    const btn = document.getElementById("cmt-" + key);
    btn.setAttribute("aria-selected", key === id ? "true" : "false");
    btn.tabIndex = key === id ? 0 : -1;
  }
  document.getElementById("knowBox").hidden = id !== "know";
  if (moveFocus) document.getElementById("cmt-" + id).focus();
}
document.getElementById("cmTabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab");
  if (btn) setMapTab(btn.id.slice(4), true);
});
// 分頁用鍵盤行到（同指南頁、球場面板一套 WAI-ARIA tab pattern）
document.getElementById("cmTabs").addEventListener("keydown", (e) => {
  const cur = MAP_TABS.indexOf(document.body.dataset.tab);
  const n = MAP_TABS.length;
  const next = { ArrowRight: (cur + 1) % n, ArrowLeft: (cur + n - 1) % n, Home: 0, End: n - 1 }[e.key];
  if (next === undefined) return;
  e.preventDefault();
  setMapTab(MAP_TABS[next], true);
});

// 「我會到」用原生 <dialog>，唔使另開一頁（WF04）
const joinDlg = document.getElementById("joinDlg");
// 同一個活動嘅「我會到」重試（撳多一次、或者失敗再送）用同一把 key，唔會多佔位（C06）
let joinTarget = null, joinKey = null, joinKeyGame = null;
const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : "k" + Date.now() + Math.random().toString(16).slice(2));

// 活動列表同分區 overlay 用同一套卡，所以按鈕處理共用一個（C.3／C.4）
async function onGameActionClick(e) {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const { act, game, signup } = btn.dataset;
  btn.disabled = true;
  try {
    if (act === "join") {
      joinTarget = game;
      if (joinKeyGame !== game) { joinKey = newKey(); joinKeyGame = game; }
      const gm = GAMES.find((g) => g.game_id === game) || {};
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
}
document.getElementById("posts").addEventListener("click", onGameActionClick);
document.getElementById("winGames").addEventListener("click", onGameActionClick);

document.getElementById("jGo").addEventListener("click", async () => {
  const done = await doAction("join", joinTarget);
  if (done) { joinDlg.close(); document.getElementById("jEta").value = ""; }
});
document.getElementById("jCancel").addEventListener("click", () => joinDlg.close());

// ---- C.3：撳一個區 → 時間窗 overlay（早上／下午／晚上／明日／2 天後以上）----
// 時段用 server 返嘅 hk_date／hk_time 計，唔用呢部機嘅時鐘（V08）；
// 今日已經過咗嘅時段唔顯示，因為嗰啲活動再都加唔到人
const distDlg = document.getElementById("distDlg");
const WINDOWS = [
  { id: "am", label: "早上", zh: "00:00–11:59", from: "00:00", to: "11:59" },
  { id: "pm", label: "下午", zh: "12:00–17:59", from: "12:00", to: "17:59" },
  { id: "night", label: "晚上", zh: "18:00–23:59", from: "18:00", to: "23:59" },
  { id: "tomorrow", label: "明日", zh: "全日", from: null, to: null },
  { id: "later", label: "2 天後以上", zh: "全日", from: null, to: null },
];
let winTab = null;

function windowOf(g) {
  const off = dayOffset(g.hk_date);
  if (off === null) return "later";
  if (off >= 2) return "later";
  if (off === 1) return "tomorrow";
  if (off < 0) return null;                      // 今日之前：唔屬於任何將來時段
  const t = g.hk_time || "00:00";
  return t < "12:00" ? "am" : t < "18:00" ? "pm" : "night";
}

// 而家香港幾點（由 server 嘅 hk_today + 本機分鐘數推唔出，所以直接用 Intl 攞 HK 時間；
// 只影響「今日嘅時段過咗未」呢個顯示判斷，數值本身一律用 server 嘅）
function hkNowHM() {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Hong_Kong", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const o = {};
  for (const x of p) o[x.type] = x.value;
  return `${o.hour}:${o.minute}`;
}

function visibleWindows() {
  const now = hkNowHM();
  return WINDOWS.filter((w) => {
    if (w.from === null) return true;            // 明日／2 天後以上永遠顯示
    return w.to >= now;                          // 今日已經過完嘅時段收埋
  });
}

function openDistrictOverlay(code) {
  const d = districtByCode.get(code);
  document.getElementById("distTitle").textContent = `${d ? d.zh : code} ${d ? d.en : ""}`.trim();
  document.getElementById("distPost").href = "post.html?code=" + code;
  const list = visibleWindows();
  winTab = list.some((w) => w.id === winTab) ? winTab : list[0].id;
  document.getElementById("winTabs").innerHTML = list.map((w) =>
    `<button type="button" role="tab" data-win="${w.id}" aria-selected="${w.id === winTab}"${w.id === winTab ? "" : " tabindex=\"-1\""}>${w.label}<span class="fine">${w.zh}</span></button>`).join("");
  distDlg.showModal();
  renderWinGames();
}

function renderWinGames() {
  if (!distDlg.open) return;
  const box = document.getElementById("winGames");
  box.textContent = "";
  const list = GAMES.filter((g) => windowOf(g) === winTab);
  const w = WINDOWS.find((x) => x.id === winTab);
  document.getElementById("winNote").textContent = list.length
    ? `時段以活動嘅香港開始時間計；「未知」唔會當 0（J03、V04）。`
    : `呢個時段（${w.label} ${w.zh}）暫無活動回報 —— 唔代表現場冇人（V05、V07）。`;
  if (!list.length) return;
  for (const g of list) box.appendChild(gameCard(g));
}

document.getElementById("winTabs").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-win]");
  if (!btn) return;
  winTab = btn.dataset.win;
  document.querySelectorAll("#winTabs button").forEach((b) => {
    const on = b.dataset.win === winTab;
    b.setAttribute("aria-selected", String(on));
    b.tabIndex = on ? 0 : -1;
  });
  renderWinGames();
});
// WAI-ARIA tab pattern：左右掣轉時段（同指南頁、球場面板一套做法）
document.getElementById("winTabs").addEventListener("keydown", (e) => {
  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "Home" && e.key !== "End") return;
  const btns = [...document.querySelectorAll("#winTabs button")];
  if (!btns.length) return;
  e.preventDefault();
  let i = btns.findIndex((b) => b.dataset.win === winTab);
  if (e.key === "Home") i = 0;
  else if (e.key === "End") i = btns.length - 1;
  else i = (i + (e.key === "ArrowRight" ? 1 : -1) + btns.length) % btns.length;
  btns[i].click();
  btns[i].focus();
});
document.getElementById("distClose").addEventListener("click", () => distDlg.close());

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
  closeCourtPanel();          // 換區就收埋面板，否則面板會講住舊區嘅場地
  renderWhere();
  syncChart();
  document.getElementById("btnReset").disabled = !currentCode;
  const done = refreshGames();
  // C.3：「睇有咩波打」撳一個區 → 等列表攞到嗰區嘅活動先彈時間窗 overlay；
  // 「街場地圖」撳區只係放大揀場，唔好擋住地圖（D）
  if (document.body.dataset.view === "games" && currentCode) {
    const c = currentCode;
    done.then(() => { if (currentCode === c) openDistrictOverlay(c); });
  }
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

// ---- 定位：用 isPointInFill 做命中測試，唔使喺 JS 再寫 point-in-polygon ----
let geoCode = null;

function districtAt(lon, lat) {
  const [x, y] = project(lon, lat);
  const pt = new DOMPoint(x, y);
  const hit = [...svg.querySelectorAll("#districts path")].find((p) => p.isPointInFill(pt));
  return hit ? hit.dataset.district : null;
}

function openGeoPrompt(code) {
  geoCode = code;
  document.getElementById("geoQ").textContent = "你而家喺 " + districtName(code) + "嗎？";
  // C.2：對話框文案跟 Round 1（accuracy 唔再顯示，但座標依然只喺本機計 —— L01 嘅保證冇變）
  document.getElementById("geoHint").textContent = "放心！座標資料並不會存放喺伺服器！";
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
      if (code) { if (manual) explain(""); openGeoPrompt(code); }   // 命中唔到（海面／唔喺香港）就唔彈
      else if (manual) explain("定位成功但唔喺香港十八區範圍內（座標只喺你部機度計，唔會上傳），請手動選區（L01）。");
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
