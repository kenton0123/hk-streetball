// tools/seed-demo.js —— 產生 data/games.sample.json（11 號文件第 2 節要求嘅測試情境）
// 全部 is_demo=true、用真實 LCSD 場地 ID。
// 時間依「香港日界」計算：04 話本版活動唔跨午夜，所以 now 類活動一律 clamp 喺當日內，
// 已結束／已取消／已過期就用上一個香港日，確保每次執行都重算到正確狀態。
// 呢檔唔寫入任何管理憑證：server 載入時先即時生成 token（A03：公開檔唔可以含憑證）。
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const COURTS = JSON.parse(fs.readFileSync(path.join(ROOT, "data/courts.json"), "utf8"));
const MIN = 60000, DAY = 86400000, HK_OFF = 8 * 3600000;   // Asia/Hong_Kong = UTC+8，無夏令時間
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

// offsetDays 個香港日嘅午夜（返返真・UTC 毫秒）
const hkMidnight = (offsetDays) => (Math.floor((now + HK_OFF) / DAY) + offsetDays) * DAY - HK_OFF;
const todayMid = hkMidnight(0), nextMid = hkMidnight(1), prevMid = hkMidnight(-1);

// now 意圖：開始≤而家<結束，而且同一個香港日內
const nowWindow = (startBackMin, lenMin) => {
  const start = Math.max(now - startBackMin * MIN, todayMid + 5 * MIN);
  const end = Math.min(start + lenMin * MIN, nextMid - 5 * MIN);
  return { start, end };
};

const pick = (code) => {
  const c = COURTS.find((x) => x.code === code && x.lng !== null);
  if (!c) throw new Error("呢個區冇可定位場地：" + code);
  return c;
};

function game(o) {
  const c = pick(o.code);
  const T = o.format === "3v3" ? 6 : 8;
  const signups = (o.signups || []).map((s, i) => ({
    signup_id: `s_demo_${o.tag}_${i + 1}`,
    participant_nickname: s.nick, attendance_status: s.status,
    estimated_arrival_at: s.eta === undefined ? null : iso(s.eta),
    joined_at: iso(o.start - 10 * MIN), updated_at: iso(now),
    arrived_at: s.status === "arrived" ? iso(o.start) : null,
    withdrawn_at: s.status === "withdrawn" ? iso(now) : null,
    is_demo: true, version: 1,
  }));
  const active = signups.filter((s) => s.attendance_status !== "withdrawn").length;
  const confirm = o.confirm === undefined ? o.start : o.confirm;
  return {
    game_id: "g_demo_" + o.tag,
    court_id: c.id, district_id: c.district_id, code: c.code,
    creation_intent: o.intent, format: o.format, target_players: T,
    organizer_nickname: o.nick, organizer_presence: o.presence,
    original_group_size: o.group,
    original_group_arrived: o.arrived === undefined ? null : o.arrived,
    starts_at: iso(o.start), ends_at: iso(o.end),
    skill_level: o.skill || "casual", beginner_friendly: o.beginner !== false, notes: o.notes || null,
    phase: o.phase || "scheduled",
    created_at: iso(o.start - 20 * MIN), updated_at: iso(now),
    organizer_confirmed_at: iso(confirm),
    // 04：now 有效至 min(確認+60 分鐘, ends_at)；planned 有效至 ends_at
    recruiting_valid_until: o.intent === "now"
      ? iso(Math.min(confirm + NOW_VALID * MIN, o.end)) : iso(o.end),
    acknowledged_unverified_court: true, is_demo: true, version: 1,
    seats_left: Math.max(T - o.group - active, 0),
    signups,
  };
}
const NOW_VALID = 60;

const w1 = nowWindow(15, 95), w2 = nowWindow(10, 90), w3 = nowWindow(35, 100), w4 = nowWindow(20, 90);
const docs = [
  // 招募中：G=3，仲缺 3 人
  game({ tag: "recruit", code: "H", nick: "Kenton", presence: "at_court", group: 3, arrived: 3,
    intent: "now", start: w1.start, end: w1.end, confirm: now - 5 * MIN, format: "3v3", notes: "打半場，有波，新手都歡迎" }),
  // 已滿：G=4 + 2 個網站加入 = 6；已滿唔等於已開始（J04）
  game({ tag: "full", code: "F", nick: "Lam", presence: "on_the_way", group: 4, arrived: 0,
    intent: "now", start: w2.start, end: w2.end, format: "3v3",
    signups: [{ nick: "Ben", status: "going", eta: now + 10 * MIN }, { nick: "Chris", status: "going", eta: now + 5 * MIN }] }),
  // 已開始：原有小組到場未知 → 現場總數 null，另列網站已到（J03）
  game({ tag: "started", code: "G", nick: "Yuki", presence: "at_court", group: 4, arrived: null, phase: "started",
    intent: "now", start: w3.start, end: w3.end, format: "3v3",
    signups: [{ nick: "Alan", status: "arrived" }, { nick: "Kit", status: "going", eta: now + 15 * MIN }] }),
  // 退出過嘅活動：going 佔位、withdrawn 唔佔（J07）
  game({ tag: "withdrawn", code: "R", nick: "Fung", presence: "at_court", group: 2, arrived: 1,
    intent: "now", start: w4.start, end: w4.end, format: "3v3",
    signups: [{ nick: "Joe", status: "withdrawn" }, { nick: "Ray", status: "going", eta: now + 20 * MIN }] }),
  // 上一個香港日：已完結、已取消、已過期（详情仍可讀，唔接受加入 — T06）
  game({ tag: "ended", code: "E", nick: "Marco", presence: "not_yet", group: 6, arrived: 6, phase: "ended",
    intent: "now", start: prevMid + 20 * 60 * MIN, end: prevMid + 22 * 60 * MIN, format: "4v4" }),
  game({ tag: "cancel", code: "J", nick: "Wai", presence: "not_yet", group: 5, arrived: 0, phase: "cancelled",
    intent: "now", start: prevMid + 18 * 60 * MIN, end: prevMid + 20 * 60 * MIN, format: "4v4" }),
  // now 活動超過 60 分鐘冇再確認 → expired（T04）；用昨日視窗保證已過期
  game({ tag: "expired", code: "Q", nick: "Soso", presence: "at_court", group: 2, arrived: 2,
    intent: "now", start: prevMid + 19 * 60 * MIN, end: prevMid + 21 * 60 * MIN, confirm: prevMid + 19 * 60 * MIN, format: "3v3" }),
  // 預先約波：6 日後 19:30–21:30 香港時間；有效至 ends_at，唔由發布起計 60 分鐘（T05）
  game({ tag: "planA", code: "P", nick: "Terence", presence: "not_yet", group: 4, arrived: null,
    intent: "planned", start: hkMidnight(6) + 19.5 * 3600000, end: hkMidnight(6) + 21.5 * 3600000, format: "4v4",
    notes: "下次想試 4 對 4，唔使錢" }),
];

// 寫檔前自己檢查：狀態、意圖、名額、同日規則三者要互相對辦
const PHASES = ["scheduled", "started", "ended", "cancelled", "expired"];
const hkDay = (when) => iso(Date.parse(when) + HK_OFF).slice(0, 10);
const hkHM = (when) => iso(Date.parse(when) + HK_OFF).slice(11, 16);
for (const g of docs) {
  if (!PHASES.includes(g.phase)) throw new Error("唔知咩 phase：" + g.game_id + " " + g.phase);
  if (!["now", "planned"].includes(g.creation_intent)) throw new Error("intent 唔啱：" + g.game_id);
  if (g.target_players !== (g.format === "3v3" ? 6 : 8)) throw new Error("target 唔對：" + g.game_id);
  const active = g.signups.filter((s) => s.attendance_status !== "withdrawn").length;
  if (g.seats_left !== Math.max(g.target_players - g.original_group_size - active, 0))
    throw new Error("seats_left 同人數唔對辦：" + g.game_id);
  if (g.original_group_size < 1 || g.original_group_size >= g.target_players)
    throw new Error("原有小組超出玩法上限：" + g.game_id);
  if (new Date(g.ends_at) <= new Date(g.starts_at)) throw new Error("結束早過開始：" + g.game_id);
  if (hkDay(g.starts_at) !== hkDay(g.ends_at)) throw new Error("跨咗午夜：" + g.game_id);
  if (g.signups.some((s) => s.token)) throw new Error("示範檔唔應該有憑證：" + g.game_id);
}

fs.writeFileSync(path.join(ROOT, "data/games.sample.json"), JSON.stringify(docs, null, 1));
console.log("wrote data/games.sample.json：" + docs.length + " 個示範活動（全部 is_demo=true）");
for (const g of docs) {
  const active = g.signups.filter((s) => s.attendance_status !== "withdrawn").length;
  console.log(`  ${g.game_id.padEnd(15)} ${g.code} ${g.format} ${g.creation_intent.padEnd(7)} ${g.phase.padEnd(9)} `
    + `G=${g.original_group_size} S=${active} seats_left=${g.seats_left} HK ${hkDay(g.starts_at)} `
    + `${hkHM(g.starts_at)}–${hkHM(g.ends_at)} valid=${hkDay(g.recruiting_valid_until)} ${hkHM(g.recruiting_valid_until)}`);
}
