// server.js —— 開波HK 後端：Express + MongoDB（冇連線字串時改用記憶體示範資料）
// 規格來自 HK_Streetball_Handoff：04 資料模型、05 操作契約、07 文案、10 視覺化。
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { MongoClient } = require("mongodb");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const TARGET = { "3v3": 6, "4v4": 8 };          // 04：target 由玩法推出，客戶端不能覆寫
const NOW_VALID_MIN = 60;                        // 04：now 招募有效至確認後 60 分鐘
const MAX_NOTE = 500, MAX_NICK = 30;

// 唔另裝 dotenv：自己讀 .env（呢個檔唔會入 zip）
function readEnvFile() {
  const f = path.join(ROOT, ".env");
  if (!fs.existsSync(f)) return {};
  const out = {};
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith("#")) out[m[1]] = m[2].replace(/^"|"$/g, "");
  }
  return out;
}
const ENV = { ...readEnvFile(), ...process.env };

// ---- 靜態資料：官方場地同地區對照（handoff 清理後的結果）----
// 檔案係來源，MongoDB 係實際供應俾 API 嘅資料庫；雨邊邊數目唔夾就中止啟動
let DISTRICTS = JSON.parse(fs.readFileSync(path.join(ROOT, "data/districts.json"), "utf8"));
let COURTS = JSON.parse(fs.readFileSync(path.join(ROOT, "data/courts.json"), "utf8"));
const courtById = new Map(COURTS.map((c) => [c.id, c]));
const districtByCode = new Map(DISTRICTS.map((d) => [d.code, d]));
if (!DISTRICTS.length || !COURTS.length) throw new Error("data/ 入面冇資料");

function reindexReference() {
  courtById.clear(); districtByCode.clear();
  for (const c of COURTS) courtById.set(c.id, c);
  for (const d of DISTRICTS) districtByCode.set(d.code, d);
}

// 第一次連線將 data/*.json 导入 MongoDB；之後每次開機都從庫讀（唔帶 _id 出 API）
async function loadReferenceData() {
  const src = { districts: DISTRICTS, courts: COURTS };
  for (const name of ["districts", "courts"]) {
    const rows = src[name], col = db.collection(name);
    if (await col.countDocuments() === 0) await col.insertMany(rows.map((r) => ({ ...r })));
    const fromDb = await col.find({}, { projection: { _id: 0 } }).sort({ code: 1, id: 1 }).toArray();
    if (fromDb.length !== rows.length)
      throw new Error(name + "：MongoDB " + fromDb.length + " 筆 ≠ data/ " + rows.length + " 筆");
    if (name === "districts") DISTRICTS = fromDb; else COURTS = fromDb;
    console.log("[ref] " + name + " " + fromDb.length + " 筆（ MongoDB " + db.collection(name).namespace + "）");
  }
  reindexReference();
}

// ---- 活動儲存：MongoDB 優先，失敗即用記憶體 + 示範活動 ----
let db = null, client = null, mode = "memory";
const mem = new Map();

// ---- 示範資料嘅「即刻開波」四筆：每次啟動重新錨定時間窗口 ----
// 04 話 now 活動有效至確認後 60 分鐘。seed 咗幾個鐘之後全部會變 expired，
// 上線俾評核者隨時撳入會睇到空白清單；呢度每次啟動將「未終止」嘅四筆 demo 視窗錨返喺「而家」。
// 只碰呢四個 game_id：g_demo_expired／ended／cancel 要留低做 T04／T06 嘅證據。
// 免費層冷啟動（sleep 後重啟）都會順手執行一次，所以 URL 放幾日都仲有嘢睇。
const DEMO_LIVE = { g_demo_recruit: [15, 95], g_demo_full: [10, 90], g_demo_started: [35, 100], g_demo_withdrawn: [20, 90] };
const HK_MS = 8 * 3600000, DAY_MS = 86400000;   // 亞洲／香港 = UTC+8，無夏令時間
// 回需要改嘅欄位；如果份資料仍然生動、或唔係那四筆，就回 null（唔寫入）
function reanchorDemo(g, nowMs = Date.now()) {
  const win = DEMO_LIVE[g.game_id];
  if (!win || g.is_demo !== true || g.creation_intent !== "now") return null;
  if (new Date(g.recruiting_valid_until) > new Date(nowMs)) return null;
  const todayMid = Math.floor((nowMs + HK_MS) / DAY_MS) * DAY_MS - HK_MS;
  const start = Math.max(nowMs - win[0] * 60000, todayMid + 5 * 60000);
  const end = Math.min(start + win[1] * 60000, todayMid + DAY_MS - 5 * 60000);
  if (end <= start) return null;                       // 唔准跨午夜或零長視窗（04）
  const T = TARGET[g.format];
  if (!T || g.original_group_size < 1 || g.original_group_size >= T) return null;
  const active = (g.signups || []).filter((s) => s.attendance_status !== "withdrawn").length;
  return {
    starts_at: new Date(start).toISOString(), ends_at: new Date(end).toISOString(),
    organizer_confirmed_at: new Date(nowMs).toISOString(),
    recruiting_valid_until: new Date(Math.min(nowMs + NOW_VALID_MIN * 60000, end)).toISOString(),
    seats_left: Math.max(T - g.original_group_size - active, 0),
    updated_at: new Date(nowMs).toISOString(),
  };
}

function loadSamples() {
  const f = path.join(ROOT, "data/games.sample.json");
  if (!fs.existsSync(f)) return;
  let touched = 0;
  for (const g of JSON.parse(fs.readFileSync(f, "utf8"))) {
    if (!courtById.has(g.court_id)) throw new Error("示範活動指向唔存在嘅場地：" + g.court_id);
    // 示範檔本身唔含憑證（A03）；載入時先即時生成，之後只透過私密回應發放
    g.manage_token = token();
    for (const s of g.signups) s.token = token();
    if (!TARGET[g.format] || g.target_players !== TARGET[g.format])
      throw new Error("示範活動嘅 target_players 唔符合玩法：" + g.game_id);
    const set = reanchorDemo(g);
    if (set) { Object.assign(g, set); touched++; }
    mem.set(g.game_id, g);
  }
  console.log("[seed] 示範活動 " + mem.size + " 個（is_demo=true）" + (touched ? "，重新錨定視窗 " + touched + " 個" : ""));
}

// MongoDB 模式：同上，但寫返入庫（只 updateOne 呢四筆 g_demo_*，live 活動一筆唔碰）
async function reanchorDemoInDb() {
  const col = db.collection("games");
  let touched = 0;
  for (const gid of Object.keys(DEMO_LIVE)) {
    const g = await col.findOne({ game_id: gid });
    if (!g) continue;
    const set = reanchorDemo(g);
    if (!set) continue;
    await col.updateOne({ game_id: gid }, { $set: set });
    touched++;
  }
  if (touched) console.log("[seed] MongoDB：重新錨定 demo 視窗 " + touched + " 筆（只碰 g_demo_*，live 0 筆）");
}

// 上線之後無人會重新啟動 server，但 04 話 now 活動只有效 60 分鐘：
// 所以每 5 分鐘檢查一次那四筆示範活動。reanchorDemo 對仍然生動嘅回 null，即係唔寫入，
// 所以呢個計時器只係「將變咔過期嘅示範卡推返上線」，唔會改到使用者嘅 live 活動。
function demoKeepAlive(minutes = 5) {
  setInterval(async () => {
    try {
      if (mode === "mongo") return await reanchorDemoInDb();
      let touched = 0;
      for (const gid of Object.keys(DEMO_LIVE)) {
        const g = mem.get(gid);
        if (!g) continue;
        const set = reanchorDemo(g);
        if (!set) continue;
        Object.assign(g, set); touched++;
      }
      if (touched) console.log("[seed] 記憶體：重新錨定 demo 視窗 " + touched + " 筆");
    } catch (e) { console.log("[seed] 保活本次跳過：" + String(e.message).slice(0, 60)); }
  }, minutes * 60000);
}

async function initStore() {
  loadSamples();
  if (!ENV.MONGO_URI) {
    demoKeepAlive();
    console.log("[store] 冇 MONGO_URI → 記憶體示範模式（唔跨裝置、唔保證併發）");
    return;
  }
  try {
    client = new MongoClient(ENV.MONGO_URI);
    await client.connect();
    db = client.db(ENV.MONGO_DB || "hk_streetball");
    await loadReferenceData();
    await db.collection("games").createIndex({ court_id: 1 });
    await db.collection("games").createIndex({ code: 1, phase: 1 });
    await db.collection("idempotency_keys").createIndex({ key: 1 }, { unique: true });
    // 05 第 32 行建議保留 24 小時：TTL index 就係呢度嘅「自動刪除」（刪 key，唔刪活動）
    await db.collection("idempotency_keys").createIndex({ created_at: 1 }, { expireAfterSeconds: IDEM_TTL_SEC });
    const n = await db.collection("games").countDocuments();
    if (n === 0) {
      const docs = [...mem.values()];
      if (docs.length) await db.collection("games").insertMany(docs);
    } else {
      mem.clear();
    }
    await reanchorDemoInDb();
    await db.command({ ping: 1 });
    mode = "mongo";
    demoKeepAlive();
    console.log("[store] MongoDB 已連線：" + db.databaseName + " → games/districts/courts（demo 視窗每 5 分鐘自檢）");
  } catch (e) {
    db = null; mode = "memory";
    demoKeepAlive();
    console.log("[store] MongoDB 連線失敗（" + e.message.slice(0, 70) + "）→ 記憶體示範模式");
  }
}

// 統一存取：兩套後端行同一份業務規則
const games = {
  async all() {
    if (mode === "mongo") return db.collection("games").find({}).toArray();
    return [...mem.values()];
  },
  async get(id) {
    if (mode === "mongo") return db.collection("games").findOne({ game_id: id });
    return mem.get(id) || null;
  },
  async insert(g) {
    if (mode === "mongo") await db.collection("games").insertOne(g);
    else mem.set(g.game_id, g);
  },
  // 一般欄位更新（version 樂觀檢查；05 話過舊要回 409）
  async patch(id, set, expectVersion) {
    if (mode === "mongo") {
      const filter = { game_id: id };
      if (expectVersion != null) filter.version = expectVersion;
      const g = await db.collection("games").findOneAndUpdate(
        filter,
        { $set: { ...set, updated_at: new Date().toISOString() }, $inc: { version: 1 } },
        { returnDocument: "after" });
      return g || null;
    }
    const g = mem.get(id);
    if (!g) return null;
    if (expectVersion != null && g.version !== expectVersion) return null;
    Object.assign(g, set);
    g.version += 1;
    g.updated_at = new Date().toISOString();
    return g;
  },
  // 最後單位：用 seats_left > 0 做條件，先至係原子佔位
  async join(id, signup) {
    if (mode === "mongo") {
      const g = await db.collection("games").findOneAndUpdate(
        { game_id: id, seats_left: { $gt: 0 } },
        { $inc: { seats_left: -1, version: 1 }, $push: { signups: signup }, $set: { updated_at: new Date().toISOString() } },
        { returnDocument: "after" });
      return g || "full";
    }
    const g = mem.get(id);
    if (!g) return null;
    if (g.seats_left <= 0) return "full";
    g.seats_left -= 1;
    g.signups.push(signup);
    g.version += 1;
    g.updated_at = new Date().toISOString();
    return g;
  },
  // Signup 狀態轉換：只有由 from 狀態先至生效，所以重複提交不會多釋一個位（J06）
  // 退出／重新加入保留原紀錄，只改狀態（J07：保留單人紀錄）
  async setSignup(id, sid, from, to, set, seatDelta, needSeat) {
    const iso = new Date().toISOString();
    if (mode === "mongo") {
      const prefixed = {};
      for (const [k, v] of Object.entries(set)) prefixed[`signups.$[s].${k}`] = v;
      const filter = {
        game_id: id,
        // $inc 同 $set 必須捆埋一齊生效：把 from 狀態放落文件篩選，
        // 否则 arrayFilters 冇中嘅時候會淨釋咗個名額（實測過嘅 bug）
        signups: { $elemMatch: from ? { signup_id: sid, attendance_status: from } : { signup_id: sid } },
      };
      if (needSeat) filter.seats_left = { $gt: 0 };
      const g = await db.collection("games").findOneAndUpdate(
        filter,
        {
          $set: { "signups.$[s].attendance_status": to, ...prefixed, updated_at: iso },
          $inc: { seats_left: seatDelta, version: 1 },
        },
        {
          arrayFilters: [{ "s.signup_id": sid, "s.attendance_status": from }],
          returnDocument: "after",
        });
      if (g) return g;
      const cur = await db.collection("games").findOne({ game_id: id });
      if (!cur || !cur.signups.some((x) => x.signup_id === sid)) return null;
      return { noop: true, doc: cur };          // 已係目標狀態／唔係 from 狀態 → 當冚掂處理
    }
    const g = mem.get(id);
    if (!g) return null;
    if (needSeat && g.seats_left <= 0) return { noop: true, doc: g };
    const s = g.signups.find((x) => x.signup_id === sid);
    if (!s) return null;
    if (s.attendance_status !== from) return { noop: true, doc: g };
    s.attendance_status = to;
    Object.assign(s, set);
    g.seats_left += seatDelta;
    g.version += 1;
    g.updated_at = iso;
    return g;
  },
};

// ---- 香港時間：04 指明顯示與日期篩選一律 Asia/Hong_Kong（唔跟裝置時區）----
const HKF = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
});
function hkStamp(instant) {
  const p = {};
  for (const t of HKF.formatToParts(new Date(instant))) p[t.type] = t.value;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
const hkDate = (instant) => hkStamp(instant).date;
const isoIn = (ms) => new Date(Date.now() + ms).toISOString();

// ---- 04 的衍生數值：G 原有小組、S 有效加入、A 網站報到、T 目標 ----
// 呢度係唯一計數位置：客戶端傳入嘅任何 count 欄位一概忽略（C03、C04 係 P0）
function derive(g, now = new Date()) {
  const active = g.signups.filter((s) => s.attendance_status !== "withdrawn");
  const S = active.length;
  const webArrived = active.filter((s) => s.attendance_status === "arrived").length;
  const T = TARGET[g.format];
  const committed = g.original_group_size + S;
  const remaining = Math.max(T - committed, 0);

  let phase = g.phase;
  const ends = new Date(g.ends_at), valid = new Date(g.recruiting_valid_until);
  if ((phase === "scheduled" || phase === "started")) {
    if (ends <= now) phase = phase === "started" ? "ended" : "expired";   // T08
    else if (phase === "scheduled" && valid <= now) phase = "expired";     // T04
  }
  // 顯示狀態優先判終止，再判時間，再由剩餘名額顯 full / recruiting（04 第 24 行）
  const status = phase === "scheduled" ? (remaining === 0 ? "full" : "recruiting") : phase;
  const joinable = phase === "scheduled" && remaining > 0;
  // 原有小組到場未知 → 現場總數係 null，唔可以填 0（J03、V04）
  const on_site = g.original_group_arrived === null || g.original_group_arrived === undefined
    ? null : g.original_group_arrived + webArrived;
  return {
    target: T, signups_active: S, web_arrived: webArrived, committed, remaining,
    on_site, phase, status, joinable,
    expires_in_min: phase === "scheduled" ? Math.max(0, Math.round((valid - now) / 60000)) : null,
  };
}

// 公開回應只返 05 第 36 行許可嘅欄位：無 Signup 名單、無任何管理憑證（A03 係 P0）
function publicGame(g, now = new Date()) {
  const d = derive(g, now);
  const c = courtById.get(g.court_id) || {};
  const dist = districtByCode.get(g.code) || {};
  const st = hkStamp(g.starts_at), en = hkStamp(g.ends_at);
  return {
    game_id: g.game_id, court_id: g.court_id,
    court_zh: c.zh, court_en: c.en, addr: c.addr || null,
    code: g.code, district_zh: dist.zh, district_en: dist.en,
    creation_intent: g.creation_intent, format: g.format, target_players: d.target,
    starts_at: g.starts_at, ends_at: g.ends_at, hk_date: st.date, hk_time: st.time, hk_end: en.time,
    phase: d.phase, status: d.status, joinable: d.joinable,
    organizer_nickname: g.organizer_nickname, organizer_presence: g.organizer_presence,
    original_group_size: g.original_group_size, original_group_arrived: g.original_group_arrived,
    committed: d.committed, web_joined: d.signups_active, web_arrived: d.web_arrived,
    on_site: d.on_site, remaining: d.remaining,
    skill_level: g.skill_level, beginner_friendly: g.beginner_friendly, notes: g.notes,
    acknowledged_unverified_court: g.acknowledged_unverified_court === true,
    organizer_confirmed_at: g.organizer_confirmed_at, recruiting_valid_until: g.recruiting_valid_until,
    expires_in_min: d.expires_in_min, is_demo: g.is_demo === true, version: g.version,
    created_at: g.created_at, updated_at: g.updated_at,
    court_source: { dataset: c.src || null, processing_date: c.proc || null },
  };
}

// ---- 回應格式：照 05 的 {data, meta} / {error:{code,message,fields}, meta} ----
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));

const ok = (res, data, extra) => res.status(200).json({
  data, meta: { server_time: new Date().toISOString(), mode, count: Array.isArray(data) ? data.length : undefined, ...extra },
});
// 私密回應：憑證只出现一次，而且不可缓存（05：綁安全上下文且 no-store）
const okPrivate = (res, data, priv, extra) => res.set("Cache-Control", "no-store")
  .status(201).json({ data, private: priv, meta: { server_time: new Date().toISOString(), mode, ...extra } });
const fail = (res, status, code, message, fields) => res.status(status).json({
  error: { code, message, fields: fields || null }, meta: { server_time: new Date().toISOString() },
});

// 04：無效座標、已核實關閉、已核實不適用 → 唔准發布；其他待核實 → 要用戶確認已閱讀
function publishCheck(court, acknowledged) {
  if (!court) return { block: 404, msg: "場地唔存在", field: { court_id: "not_found" } };
  if (court.lng === null || court.lat === null)
    return { block: 403, msg: "呢個場地無有效座標，唔可以發布活動（D02）", field: { court_id: "invalid_coordinates" } };
  if (court.oper === "closed" || court.suit === "not_suitable")
    return { block: 403, msg: "呢個場地已核實為關閉或不適用，唔准發布（D07）", field: { court_id: "not_publishable" } };
  if (!acknowledged)
    return { warn: true, msg: "場地資料未經過人工核實，發布前請先確認已閱讀提醒（D08）", field: { acknowledged_unverified_court: "required" } };
  return {};
}

const token = () => crypto.randomBytes(16).toString("hex");
// 管理權限只由 header 帶，唔放 URL、唔入日誌（A01/A03）
function authorized(doc, req) {
  const h = req.get("authorization") || "";
  const t = h.replace(/^Bearer\s+/i, "");
  return Boolean(t) && t === doc.manage_token;
}
function signupAuthorized(g, sid, req) {
  const s = g.signups.find((x) => x.signup_id === sid);
  if (!s) return { missing: true };
  const h = req.get("authorization") || "";
  const t = h.replace(/^Bearer\s+/i, "");
  return { signup: s, good: Boolean(t) && t === s.token };
}

// ---- 05 第 32 行：Idempotency-Key（同 key 同內容回原結果、異內容 409、保留 24 小時）----
// 24 小時後嘅「自動刪除」靠 MongoDB TTL index 清 key 紀錄；活動本身唔删（T06 要詳情可讀）
const IDEM_TTL_SEC = 24 * 3600;
const idemMem = new Map();
function stableJson(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return "[" + v.map(stableJson).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stableJson(v[k])).join(",") + "}";
}
function fpOf(scope, body) {
  return crypto.createHash("sha256").update(scope + "|" + stableJson(body || {})).digest("hex").slice(0, 32);
}
function idemSweep() {
  const cut = Date.now() - IDEM_TTL_SEC * 1000;
  for (const [k, v] of idemMem) if (+v.created_at < cut) idemMem.delete(k);
}
// 以 upsert 搶佔 key：搶唔到嘅後來者先可以判定係重放、衝突、定係仲喺度處理
async function idemTake(key, scope, body) {
  const fp = fpOf(scope, body), claimed = token();
  const rec = mode === "mongo"
    ? await db.collection("idempotency_keys").findOneAndUpdate(
      { key },
      { $setOnInsert: { key, scope, fp, state: "in_progress", game_id: null, signup_id: null, claimed_by: claimed, created_at: new Date() } },
      { upsert: true, returnDocument: "after" })
    : (() => {
      idemSweep();
      let d = idemMem.get(key);
      if (!d) { d = { key, scope, fp, state: "in_progress", game_id: null, signup_id: null, claimed_by: claimed, created_at: new Date() }; idemMem.set(key, d); }
      return d;
    })();
  if (rec.scope !== scope || rec.fp !== fp) return { conflict: true };
  if (rec.claimed_by === claimed) return { fresh: true, rec };
  if (rec.state === "done") return { replay: true, rec };
  return { pending: true };
}
async function idemFinish(key, ids) {
  if (mode === "mongo") await db.collection("idempotency_keys").updateOne({ key }, { $set: { ...ids, state: "done" } });
  else if (idemMem.get(key)) Object.assign(idemMem.get(key), ids, { state: "done" });
}
async function idemRelease(key) {                        // 建立失敗 → 交返個 key 出去，容許原樣重試
  if (mode === "mongo") await db.collection("idempotency_keys").deleteOne({ key });
  else idemMem.delete(key);
}
// 重放用現行文档嘅憑證，唔喺 key 紀錄再存一份
async function idemReplay(res, rec, kind) {
  const g = await games.get(rec.game_id);
  if (!g) return fail(res, 409, "idempotency_stale", "原 key 对应嘅活動已經唔喺資料庫，請重新提交");
  if (kind === "signup") {
    const s = g.signups.find((x) => x.signup_id === rec.signup_id);
    if (!s) return fail(res, 409, "idempotency_stale", "原 key 对应嘅參加紀錄搵唔到，請重新提交");
    return okPrivate(res, publicGame(g), { signup_id: s.signup_id, manage_token: s.token }, { idempotent_replay: true });
  }
  return okPrivate(res, publicGame(g), { game_id: g.game_id, manage_token: g.manage_token }, { idempotent_replay: true });
}
function idemKeyOf(req) {
  const k = String(req.get("idempotency-key") ?? "").trim();
  return k.length >= 8 && k.length <= 128 ? k : null;
}

// ---- 讀取 ----
app.get("/api/meta", (req, res) => ok(res, {
  mode,
  storage: mode === "mongo" ? "MongoDB（跨裝置共享）" : "記憶體（重啟即冇，唔跨裝置）",
  courts_total: COURTS.length,
  courts_locatable: COURTS.filter((c) => c.lng !== null).length,
  courts_without_coords: COURTS.filter((c) => c.lng === null).length,
  districts: DISTRICTS.length,
  source_dataset: "康文署籃球場 facility-bkbc.json（2026-11-13 處理）",
  basemap: "Paulkit/HKMap（MIT）",
  recruiting_valid_min: NOW_VALID_MIN,
}));

app.get("/api/districts", (req, res) => ok(res, DISTRICTS));

app.get("/api/courts", (req, res) => {
  let list = COURTS;
  const { district_id, code, q } = req.query;
  if (district_id) list = list.filter((c) => c.district_id === district_id);
  if (code) list = list.filter((c) => c.code === code);
  if (q) { const s = String(q).toLowerCase(); list = list.filter((c) => (c.zh + c.en + (c.addr || "")).toLowerCase().includes(s)); }
  // 05：地圖需完整分頁或靜態 GeoJSON，唔可以把首 30 筆當全部 → 一次過返回並講明
  return ok(res, list, { scope: "full_dataset", bbox_applied: false });
});

app.get("/api/courts/:id", (req, res) => {
  const c = courtById.get(req.params.id);
  if (!c) return fail(res, 404, "not_found", "場地唔存在");
  return ok(res, { ...c, publish: publishCheck(c, true) });
});

// V03：十八區圖表永遠用完整資料集，唔随篩選重算
app.get("/api/stats/districts", (req, res) => ok(res, DISTRICTS.map((d) => ({
  district_id: d.district_id, code: d.code, zh: d.zh, en: d.en,
  records: d.records, locatable: COURTS.filter((c) => c.code === d.code && c.lng !== null).length,
  needs_review: COURTS.filter((c) => c.code === d.code && c.lng === null).length,
  unique_source_ids: d.unique_source_ids,
})).sort((a, b) => b.records - a.records || a.code.localeCompare(b.code))));

// 05：time_filter=now/later_today/date；預設只返招募中同已滿；dataset 隔離 live/demo
function matchFilters(g, d, q, now) {
  if (q.district_id && g.district_id !== q.district_id) return false;
  if (q.code && g.code !== q.code) return false;
  if (q.court_id && g.court_id !== q.court_id) return false;
  if (q.dataset === "live" && g.is_demo) return false;
  if (q.dataset === "demo" && !g.is_demo) return false;
  const tf = q.time_filter || "all";
  const st = new Date(g.starts_at);
  if (tf === "now" && !(st <= now && new Date(g.ends_at) > now)) return false;
  if (tf === "later_today" && !(st > now && hkDate(g.starts_at) === hkDate(now))) return false;
  if (tf === "date" && hkDate(g.starts_at) !== q.date) return false;
  const wanted = String(q.status || "recruiting,full").split(",").map((s) => s.trim());
  if (!wanted.includes(d.status)) return false;
  return true;
}

app.get("/api/games", async (req, res) => {
  const q = req.query;
  if (q.time_filter === "date" && !q.date) return fail(res, 400, "invalid_query", "date 模式需要 date=YYYY-MM-DD");
  if (q.date && !/^\d{4}-\d{2}-\d{2}$/.test(q.date)) return fail(res, 400, "invalid_query", "date 格式係 YYYY-MM-DD");
  const now = new Date();
  const all = await games.all();
  const list = all.filter((g) => matchFilters(g, derive(g, now), q, now))
    .map((g) => publicGame(g, now))
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  return ok(res, list, { time_filter: q.time_filter || "all", hk_today: hkDate(now) });
});

app.get("/api/games/:id", async (req, res) => {
  const g = await games.get(req.params.id);
  if (!g) return fail(res, 404, "not_found", "冇呢個活動");
  return ok(res, publicGame(g));           // 終止狀態仍可讀（05、T06）
});

// ---- 建立：所有欄位喺伺服器驗證，客戶端傳入嘅 count／target 一概忽略（C03、C04）----
async function createGame(req, res) {
  const b = req.body || {}, fields = {}, now = new Date();
  const nick = String(b.organizer_nickname ?? "").trim();
  if (nick.length < 1 || nick.length > MAX_NICK) fields.organizer_nickname = `1–${MAX_NICK} 字元`;
  const format = b.format;
  if (!TARGET[format]) fields.format = "只接受 3v3 或 4v4";
  if (!["now", "planned"].includes(b.creation_intent)) fields.creation_intent = "now 或 planned";
  if (!["at_court", "on_the_way", "not_yet"].includes(b.organizer_presence)) fields.organizer_presence = "at_court / on_the_way / not_yet";
  if (!["unspecified", "casual", "intermediate", "high_intensity"].includes(b.skill_level)) fields.skill_level = "unspecified / casual / intermediate / high_intensity";
  const court = courtById.get(b.court_id);
  const pc = publishCheck(court, b.acknowledged_unverified_court === true);
  if (pc.block) return fail(res, pc.block, "court_not_publishable", pc.msg, pc.field);
  if (pc.warn) return fail(res, 422, "acknowledgement_required", pc.msg, pc.field);
  if (Object.keys(fields).length) return fail(res, 422, "invalid", "欄位唔正確", fields);

  const T = TARGET[format];
  if (b.target_players !== undefined && Number(b.target_players) !== T)
    return fail(res, 422, "target_derived", `目標人數由玩法自動計算：${format} = ${T} 人，不能自行指定`, { target_players: "derived_only" });
  const G = Number(b.original_group_size);
  if (!Number.isInteger(G) || G < 1 || G >= T) fields.original_group_size = `必須係 1 至 ${T - 1} 嘅整數（發布時最少缺 1 人）`;
  const rawA = b.original_group_arrived;
  const A = rawA === undefined || rawA === null || rawA === "" ? null : Number(rawA);
  if (A !== null && (!Number.isInteger(A) || A < 0 || A > G)) fields.original_group_arrived = "0 至原有小組人數，或者唔填（未知）";
  if (A !== null && b.organizer_presence === "at_court" && A < 1) fields.original_group_arrived = "發起人已在場，到場人數唔可以係 0";
  const notes = b.notes === undefined || b.notes === null ? null : String(b.notes);
  if (notes !== null && notes.length > MAX_NOTE) fields.notes = `最多 ${MAX_NOTE} 字元`;

  let starts, ends;
  if (b.creation_intent === "now") {
    starts = now;                                        // C01：now 嘅開始時間由服務端決定
    ends = b.ends_at ? new Date(b.ends_at) : new Date(now.getTime() + 90 * 60000);
    if (!(ends > starts)) fields.ends_at = "結束要晚於開始";
    else if (hkDate(starts) !== hkDate(ends)) fields.ends_at = "本版唔跨午夜（04）";
  } else {
    starts = new Date(b.starts_at); ends = new Date(b.ends_at);
    if (!Number.isFinite(+starts)) fields.starts_at = "請填開始時間";
    else if (!(starts > now)) fields.starts_at = "預先約波要係將來時間（C02）";
    if (!Number.isFinite(+ends)) fields.ends_at = "請填結束時間";
    else if (!(ends > starts)) fields.ends_at = "結束要晚於開始";
    else if (hkDate(starts) !== hkDate(ends)) fields.ends_at = "本版唔跨午夜（04）";
  }
  if (Object.keys(fields).length) return fail(res, 422, "invalid", "欄位唔正確", fields);

  // 04：now 有效至 min(確認+60 分鐘, ends_at)；planned 有效至 ends_at
  const validUntil = b.creation_intent === "now"
    ? new Date(Math.min(now.getTime() + NOW_VALID_MIN * 60000, +ends)).toISOString()
    : ends.toISOString();
  const gid = "g_" + crypto.randomBytes(6).toString("hex");
  const mt = token();
  const doc = {
    game_id: gid, court_id: court.id, district_id: court.district_id, code: court.code,
    creation_intent: b.creation_intent, format, target_players: T,
    organizer_nickname: nick, organizer_presence: b.organizer_presence,
    original_group_size: G, original_group_arrived: A,
    starts_at: starts.toISOString(), ends_at: ends.toISOString(),
    skill_level: b.skill_level, beginner_friendly: b.beginner_friendly === true, notes,
    phase: "scheduled", created_at: now.toISOString(), updated_at: now.toISOString(),
    organizer_confirmed_at: now.toISOString(), recruiting_valid_until: validUntil,
    acknowledged_unverified_court: true, is_demo: b.is_demo === true,
    version: 1, seats_left: T - G, signups: [], manage_token: mt,
  };
  await games.insert(doc);
  // 唔喺呢度回應：帶 key 時要先把 key 紀錄標成 done，先至送出回應，
  // 否則客端收到 201 之後即刻重放會撞入 idempotency_in_progress（實測過間歇性失敗）
  return { game_id: gid, data: publicGame(doc, now), priv: { game_id: gid, manage_token: mt } };
}

// C06／05 第 32 行：帶 Idempotency-Key 先經一層「搶key → 重放／衝突／處理中」，先至真正建立
function sendPrivate(res, out) { if (out) okPrivate(res, out.data, out.priv); }

app.post("/api/games", async (req, res) => {
  const ikey = idemKeyOf(req);
  if (!ikey) return sendPrivate(res, await createGame(req, res));
  const t = await idemTake(ikey, "POST /api/games", req.body || {});
  if (t.conflict) return fail(res, 409, "idempotency_conflict", "同一個 Idempotency-Key 用咗唔同嘅內容（05）", null);
  if (t.pending) return fail(res, 409, "idempotency_in_progress", "同一個 key 嘅上一個請求仲喺度處理，請稍後重試", null);
  if (t.replay) return idemReplay(res, t.rec, "game");
  try {
    const out = await createGame(req, res);
    if (out && out.game_id) await idemFinish(ikey, { game_id: out.game_id });
    else await idemRelease(ikey);                       // 驗證失敗：交返 key，容許原樣重試
    sendPrivate(res, out);
  } catch (e) { await idemRelease(ikey); throw e; }
});

// 發起人操作：全部要 Bearer 憑證（A01）；過期／終止不可復活（T07）
async function organizerOnly(req, res) {
  const g = await games.get(req.params.id);
  if (!g) { fail(res, 404, "not_found", "冇呢個活動"); return null; }
  if (!authorized(g, req)) { fail(res, 401, "unauthorized", "缺少或錯誤嘅發起人憑證（前端隱藏唔算保護）"); return null; }
  return g;
}

// 05 第 15 行 + C07（P0）：發起人可以改文字／時間／小組人數，但场地不能换；
// 計數欄一律由伺服器重新推，客戶端傳入即拒（C03）。改動要帶 expected_version（05 第 33 行）。
app.patch("/api/games/:id", async (req, res) => {
  const g = await organizerOnly(req, res);
  if (!g) return;
  const b = req.body || {}, fields = {};
  if (b.court_id !== undefined && b.court_id !== g.court_id)
    return fail(res, 403, "court_immutable", "不允許換場：要取消呢個活動再另一個（C07，參加者唔會靜默搬走）", { court_id: "immutable" });
  for (const k of ["target_players", "seats_left", "signups", "phase", "status", "version", "is_demo", "manage_token", "game_id", "court_id", "code", "district_id", "created_at"])
    if (b[k] !== undefined) fields[k] = "由伺服器計算，唔可以改";
  if (b.format !== undefined && b.format !== g.format) fields.format = "玩法要另建活動先可以改（目標人數會跟著變）";
  if (b.creation_intent !== undefined && b.creation_intent !== g.creation_intent) fields.creation_intent = "即刻／預先唔可以互轉";
  if (Object.keys(fields).length) return fail(res, 422, "invalid", "呢啲欄位唔可由客戶端覆寫", fields);

  const d = derive(g);
  if (["expired", "ended", "cancelled"].includes(d.phase))
    return fail(res, 409, "not_open", `活動已 ${d.phase}，紀錄不再改動（05）`);
  const timeEditable = d.phase === "scheduled";        // 已開始就只可以改文字類欄位
  const set = {};
  if (b.notes !== undefined) {
    const n = b.notes === null || b.notes === "" ? null : String(b.notes);
    if (n !== null && n.length > MAX_NOTE) return fail(res, 422, "invalid", "備註過長", { notes: `最多 ${MAX_NOTE} 字元` });
    set.notes = n;
  }
  if (b.skill_level !== undefined) {
    if (!["unspecified", "casual", "intermediate", "high_intensity"].includes(b.skill_level))
      return fail(res, 422, "invalid", "強度選項唔正確", { skill_level: "unspecified / casual / intermediate / high_intensity" });
    set.skill_level = b.skill_level;
  }
  if (b.beginner_friendly !== undefined) set.beginner_friendly = b.beginner_friendly === true;
  if (!timeEditable) {
    if (b.starts_at !== undefined || b.ends_at !== undefined || b.original_group_size !== undefined || b.organizer_presence !== undefined)
      return fail(res, 409, "not_started_edit", "活動已開始，時間與人數不再可改（05 第 37 行要改時間必須喺開始前）", null);
  } else {
    if (b.organizer_presence !== undefined) {
      if (!["at_court", "on_the_way", "not_yet"].includes(b.organizer_presence)) fields.organizer_presence = "at_court / on_the_way / not_yet";
      set.organizer_presence = b.organizer_presence;
    }
    const G = b.original_group_size === undefined ? g.original_group_size : Number(b.original_group_size);
    if (!Number.isInteger(G) || G < 1 || G >= g.target_players) fields.original_group_size = `必須係 1 至 ${g.target_players - 1} 嘅整數`;
    const rawA = b.original_group_arrived === undefined ? g.original_group_arrived : b.original_group_arrived;
    const A = rawA === undefined || rawA === null || rawA === "" ? null : Number(rawA);
    if (A !== null && (!Number.isInteger(A) || A < 0 || A > G)) fields.original_group_arrived = "0 至原有小組人數，或者唔填（未知）";
    const pres = set.organizer_presence ?? g.organizer_presence;
    if (A !== null && pres === "at_court" && A < 1) fields.original_group_arrived = "發起人已在場，到場人數唔可以係 0";
    const active = g.signups.filter((s) => ["going", "arrived"].includes(s.attendance_status)).length;
    if (Object.keys(fields).length) return fail(res, 422, "invalid", "欄位唔正確", fields);
    if (G + active > g.target_players)
      return fail(res, 409, "over_commit", `原有小組 ${G} + 網站已佔 ${active} 超過目標 ${g.target_players} 人，先要有人退出`, { original_group_size: "would_over_commit" });
    set.original_group_size = G;
    set.original_group_arrived = A;
    let starts = new Date(g.starts_at), ends = new Date(g.ends_at);
    if (b.starts_at !== undefined || b.ends_at !== undefined) {
      if (b.starts_at !== undefined) starts = new Date(b.starts_at);
      if (b.ends_at !== undefined) ends = new Date(b.ends_at);
      const tf = {};
      if (!Number.isFinite(+starts)) tf.starts_at = "請填開始時間";
      if (!Number.isFinite(+ends)) tf.ends_at = "請填結束時間";
      if (!tf.starts_at && !tf.ends_at) {
        if (!(ends > starts)) tf.ends_at = "結束要晚於開始";
        else if (hkDate(starts) !== hkDate(ends)) tf.ends_at = "本版唔跨午夜（04）";
        else if (g.creation_intent === "planned" && !(starts > new Date())) tf.starts_at = "預先約波嘅開始時間要係將來（C02）";
      }
      if (Object.keys(tf).length) return fail(res, 422, "invalid", "欄位唔正確", tf);
      set.starts_at = starts.toISOString();
      set.ends_at = ends.toISOString();
      if (g.creation_intent === "now") {
        set.organizer_confirmed_at = new Date().toISOString();
        set.recruiting_valid_until = new Date(Math.min(Date.now() + NOW_VALID_MIN * 60000, +ends)).toISOString();
      } else {
        set.recruiting_valid_until = ends.toISOString();
      }
    }
    set.seats_left = g.target_players - G - active;    // 重新推，唔受傳入值影響
  }
  if (!Object.keys(set).length) return ok(res, publicGame(g), { unchanged: true });
  const out = await games.patch(g.game_id, set, b.expected_version);
  if (!out) return fail(res, 409, "version_conflict", "資料已被他人更新，請刷新（05 expected_version）", null);
  return ok(res, publicGame(out));
});

app.post("/api/games/:id/confirm", async (req, res) => {
  const g = await organizerOnly(req, res);
  if (!g) return;
  const d = derive(g);
  if (d.phase !== "scheduled") return fail(res, 409, "not_open", `活動已係 ${d.phase}，確認不能復活過期活動（T07）`);
  const now = new Date();
  const valid = g.creation_intent === "now"
    ? new Date(Math.min(+now + NOW_VALID_MIN * 60000, +new Date(g.ends_at))).toISOString()
    : g.recruiting_valid_until;
  const out = await games.patch(g.game_id, { organizer_confirmed_at: now.toISOString(), recruiting_valid_until: valid }, req.body && req.body.expected_version);
  if (!out) return fail(res, 409, "version_conflict", "資料已被他人更新，請刷新（05 expected_version）");
  return ok(res, publicGame(out));
});

app.post("/api/games/:id/start", async (req, res) => {
  const g = await organizerOnly(req, res);
  if (!g) return;
  const d = derive(g);
  if (d.phase !== "scheduled") return fail(res, 409, "bad_phase", `活動已係 ${d.phase}，唔可以由呢度開始`);
  if (new Date(g.starts_at) > new Date()) return fail(res, 409, "not_yet_due", "未到你填嘅開始時間；想早打要先明確修改時間（T03）");
  const out = await games.patch(g.game_id, { phase: "started", started_at: new Date().toISOString() });
  return ok(res, publicGame(out));
});

app.post("/api/games/:id/end", async (req, res) => {
  const g = await organizerOnly(req, res);
  if (!g) return;
  const d = derive(g);
  if (d.phase !== "started") return fail(res, 409, "bad_phase", "只有開始咗嘅活動可以先完結");
  const out = await games.patch(g.game_id, { phase: "ended", ended_at: new Date().toISOString() });
  return ok(res, publicGame(out));
});

app.post("/api/games/:id/cancel", async (req, res) => {
  const g = await organizerOnly(req, res);
  if (!g) return;
  const d = derive(g);
  if (d.phase !== "scheduled") return fail(res, 409, "bad_phase", `活動已係 ${d.phase}，取消只適用於未開始嘅活動`);
  const out = await games.patch(g.game_id, { phase: "cancelled", cancelled_at: new Date().toISOString() });
  return ok(res, publicGame(out));
});

// ---- 加入／報到／退出：一次一人，名額檢查同新增要原子（J05 係 P0）----
async function joinGame(req, res) {
  const g = await games.get(req.params.id);
  if (!g) return fail(res, 404, "not_found", "冇呢個活動");
  const now = new Date();
  const d = derive(g, now);
  if (!d.joinable) {
    const why = { full: "名額已經搶完（已滿唔等於已開始）", started: "已經開始，唔再招募", expired: "活動已過期，請參加新活動", cancelled: "活動已取消", ended: "活動已完結" };
    return fail(res, 409, "not_joinable", why[d.status] || "而家唔接受加入：" + d.status, { status: d.status });
  }
  const nick = String((req.body || {}).participant_nickname ?? "").trim();
  if (nick.length < 1 || nick.length > MAX_NICK) return fail(res, 422, "invalid", "暱稱要 1–30 字元", { participant_nickname: `1–${MAX_NICK} 字元` });
  const eta = (req.body || {}).estimated_arrival_at;
  let etaIso = null;
  if (eta !== undefined && eta !== null && eta !== "") {
    const t = new Date(eta);
    if (!Number.isFinite(+t)) return fail(res, 422, "invalid", "到達時間格式唔正確", { estimated_arrival_at: "ISO8601" });
    etaIso = t.toISOString();
  }
  const sid = "s_" + crypto.randomBytes(5).toString("hex");
  const st = token();
  const signup = {
    signup_id: sid, participant_nickname: nick, attendance_status: "going",
    estimated_arrival_at: etaIso, joined_at: now.toISOString(), updated_at: now.toISOString(),
    arrived_at: null, withdrawn_at: null, is_demo: g.is_demo === true, version: 1, token: st,
  };
  const r = await games.join(g.game_id, signup);
  if (r === "full") return fail(res, 409, "game_full", "最後一個名額比人搶先咗，請刷新列表（J05）", { status: "full" });
  if (!r) return fail(res, 404, "not_found", "冇呢個活動");
  // 防呆：如果計出超額，即當失敗還回名額，唔好默默超額
  const after = derive(r, new Date());
  if (after.committed > after.target) {
    await games.setSignup(r.game_id, sid, "going", "withdrawn", { withdrawn_at: new Date().toISOString() }, 1, false);
    return fail(res, 409, "game_full", "名額衝突，未能加入", null);
  }
  // 同上：key 標 done 之後先回應，重放先至唔會誤判「處理中」
  return { signup_id: sid, data: publicGame(r), priv: { signup_id: sid, manage_token: st } };
}

// 同一個 Idempotency-Key 重放「我會去」：唔會多佔一個位（C06）
app.post("/api/games/:id/signups", async (req, res) => {
  const ikey = idemKeyOf(req);
  if (!ikey) return sendPrivate(res, await joinGame(req, res));
  const t = await idemTake(ikey, "POST /api/games/" + req.params.id + "/signups", req.body || {});
  if (t.conflict) return fail(res, 409, "idempotency_conflict", "同一個 Idempotency-Key 用咗唔同嘅內容（05）", null);
  if (t.pending) return fail(res, 409, "idempotency_in_progress", "同一個 key 嘅上一個請求仲喺度處理，請稍後重試", null);
  if (t.replay) return idemReplay(res, t.rec, "signup");
  try {
    const out = await joinGame(req, res);
    if (out && out.signup_id) await idemFinish(ikey, { game_id: req.params.id, signup_id: out.signup_id });
    else await idemRelease(ikey);
    sendPrivate(res, out);
  } catch (e) { await idemRelease(ikey); throw e; }
});

async function signupOnly(req, res) {
  const g = await games.get(req.params.id);
  if (!g) { fail(res, 404, "not_found", "冇呢個活動"); return null; }
  const { signup, missing, good } = signupAuthorized(g, req.params.sid, req);
  if (missing) { fail(res, 404, "not_found", "冇呢個參加紀錄"); return null; }
  // 用他人 Signup 嘅憑證報到 → 拒絕（A02 係 P0）
  if (!good) { fail(res, 401, "unauthorized", "參加憑證唔正確"); return null; }
  return { g, signup };
}

// 報到只轉狀態，唔再多佔一人（J02）；亦可用嚟改到達時間／誤報修正
app.patch("/api/games/:id/signups/:sid", async (req, res) => {
  const ctx = await signupOnly(req, res);
  if (!ctx) return;
  const b = req.body || {};
  const to = b.attendance_status;
  if (to !== undefined && !["going", "arrived"].includes(to))
    return fail(res, 422, "invalid", "只能改為 going 或 arrived", { attendance_status: "going|arrived" });
  const d = derive(ctx.g);
  if (["expired", "cancelled", "ended"].includes(d.phase)) return fail(res, 409, "not_open", `活動已 ${d.phase}，狀態不再改動`);
  if (ctx.signup.attendance_status === "withdrawn") return fail(res, 409, "withdrawn", "你已經退出咗呢個活動，要用重新加入");
  const iso = new Date().toISOString();
  const eta = b.estimated_arrival_at === undefined ? ctx.signup.estimated_arrival_at : (b.estimated_arrival_at || null);
  let doc = ctx.g;
  if ((to && to !== ctx.signup.attendance_status) || b.estimated_arrival_at !== undefined) {
    const from = to ? (to === "arrived" ? "going" : "arrived") : ctx.signup.attendance_status;
    const set = { estimated_arrival_at: eta };
    if (to === "arrived") set.arrived_at = iso;
    else if (to === "going") set.arrived_at = null;
    const r = await games.setSignup(ctx.g.game_id, req.params.sid, from, to || ctx.signup.attendance_status, set, 0, false);
    if (!r) return fail(res, 404, "not_found", "冇呢個活動");
    doc = r.doc || r;
  }
  return ok(res, publicGame(doc));
});

app.post("/api/games/:id/signups/:sid/withdraw", async (req, res) => {
  const ctx = await signupOnly(req, res);
  if (!ctx) return;
  const d = derive(ctx.g);
  // 終止狀態不改歷史（05）；開始咗嘅活動退出唔重開招募（T02）
  if (["expired", "cancelled", "ended"].includes(d.phase)) return fail(res, 409, "not_open", `活動已 ${d.phase}，退出唔改動歷史紀錄`);
  const iso = new Date().toISOString();
  const delta = d.phase === "scheduled" ? 1 : 0;   // 未開始先釋位（T01）
  const from = ctx.signup.attendance_status;       // going／arrived 都可以退出，用實際狀態做條件
  if (from === "withdrawn") return ok(res, publicGame(ctx.g));
  const r = await games.setSignup(ctx.g.game_id, req.params.sid, from, "withdrawn", { withdrawn_at: iso }, delta, false);
  if (!r) return fail(res, 404, "not_found", "冇呢個活動");
  if (r.noop) return ok(res, publicGame(r.doc));    // 啱啱被人改咗狀態 → 冚掂，唔多釋一位（J06）
  return ok(res, publicGame(r));
});

// 重新加入要重驗名額（J07、T06）
app.post("/api/games/:id/signups/:sid/rejoin", async (req, res) => {
  const ctx = await signupOnly(req, res);
  if (!ctx) return;
  const d = derive(ctx.g);
  if (!d.joinable) return fail(res, 409, "not_joinable", "而家冇名額或活動已結束／過期，未能重新加入", { status: d.status });
  const r = await games.setSignup(ctx.g.game_id, req.params.sid, "withdrawn", "going", { withdrawn_at: null, updated_at: new Date().toISOString() }, -1, true);
  const doc = (r && r.doc) || r;
  if (!doc) return fail(res, 404, "not_found", "冇呢個活動");
  if (r && r.noop) return fail(res, 409, "game_full", "名額已比人取走，重新加入失敗（已重驗名額）", null);
  return ok(res, publicGame(doc));
});

// ---- 靜態檔案：網頁同 data/ 入面嘅 GeoJSON 都由同一個 server 提供 ----
app.use(express.static(ROOT, { extensions: ["html"] }));
app.use("/api", (req, res) => fail(res, 404, "not_found", "冇呢個 API 路徑"));
app.use((err, req, res, next) => {                       // 出錯唔印 body，避免洩漏憑證（A03）
  console.log("[error] " + (err && err.message ? err.message.slice(0, 80) : err));
  if (res.headersSent) return next(err);
  return fail(res, 500, "server_error", "伺服器錯誤");
});

initStore().then(() => {
  app.listen(PORT, () => {
    console.log(`開波HK server: http://localhost:${PORT}  [${mode}]`);
    console.log(`  場地 ${COURTS.length} 筆（可定位 ${COURTS.filter((c) => c.lng !== null).length}）／地區 ${DISTRICTS.length} 區`);
  });
});

process.on("SIGINT", async () => { if (client) await client.close(); process.exit(0); });
