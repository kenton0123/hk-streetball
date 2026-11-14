// tools/reseed-demo.js —— 刷新 data/games.sample.json 嗰 8 筆示範活動（11 號第 16 行要嘅六種狀態）
// 點解要有呢檔：server 第一次連線先 seed，之後重啟唔會覆寫，所以 demo 視窗會隨時間過晒期，
// 地圖預設清單變空。呢檔用 replaceOne + upsert 逐個 game_id 換新，
// 範圍只限 sample 檔入面嘅 game_id（全部 is_demo=true），live 活動一筆都唔碰。
// 用法：node tools/seed-demo.js  →  node tools/reseed-demo.js（乾跑）  →  node tools/reseed-demo.js --yes
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const ROOT = path.join(__dirname, "..");
function readEnvFile() {
  const f = path.join(ROOT, ".env");
  const out = {};
  if (!fs.existsSync(f)) return out;
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith("#")) out[m[1]] = m[2].replace(/^"|"$/g, "");
  }
  return out;
}
const ENV = { ...readEnvFile(), ...process.env };
const APPLY = process.argv.includes("--yes");

(async () => {
  if (!ENV.MONGO_URI) { console.log("冇 MONGO_URI：本檔只服務 MongoDB 模式（記憶體模式每次啟動自己 seed）"); return; }
  const file = path.join(ROOT, "data/games.sample.json");
  const docs = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!docs.every((d) => d.is_demo === true)) throw new Error("sample 檔混咗非示範活動，中止");
  if (docs.some((d) => !/^g_demo_/.test(d.game_id))) throw new Error("game_id 唔係 g_demo_ 開頭，中止");
  if (docs.some((d) => d.manage_token || d.signups.some((s) => s.token))) throw new Error("唔准寫入憑證：先再行 seed-demo.js");
  // 示範檔無憑證（A03）：server 載入時才生成。upsert 時要清走舊 token 以外嘅嘢？
  // → 保留庫內已有嘅 manage_token/signup token，免得瀏覽器 localStorage 嘅舊憑證失效
  const client = new MongoClient(ENV.MONGO_URI);
  await client.connect();
  const db = client.db(ENV.MONGO_DB || "hk_streetball");
  const col = db.collection("games");
  let changed = 0;
  for (const d of docs) {
    const cur = await col.findOne({ game_id: d.game_id });
    const set = { ...d };
    if (cur && cur.manage_token) set.manage_token = cur.manage_token;          // 續用舊憑證
    if (cur) for (const s of set.signups) {
      const old = (cur.signups || []).find((x) => x.signup_id === s.signup_id);
      if (old && old.token) s.token = old.token;
    }
    const ids = (x) => (x.signups || []).map((s) => s.signup_id).join(",");
    const same = cur && ["starts_at", "ends_at", "recruiting_valid_until"].every((k) => cur[k] === set[k])
      && ids(cur) === ids(set);   // 多/少咗報名都算唔同，否則示範檔清唔返原狀
    console.log(`${same ? "=" : "~"} ${d.game_id.padEnd(15)} ${d.code} ${d.phase.padEnd(9)} `
      + `${String(cur ? cur.starts_at : "（庫內冇）").slice(0, 16)} → ${set.starts_at.slice(0, 16)}｜${set.creation_intent}`);
    if (!same) {
      changed++;
      if (APPLY) await col.replaceOne({ game_id: d.game_id }, set, { upsert: true });
    }
  }
  console.log(`\n範圍：${docs.length} 筆 is_demo=true、g_demo_ 開頭嘅示範活動；live 活動 0 筆。`
    + (APPLY ? `已更新 ${changed} 筆。` : `乾跑：將會更新 ${changed} 筆（加 --yes 先真正寫入）。`));
  await client.close();
})().catch((e) => { console.error("中止：" + e.message); process.exit(1); });
