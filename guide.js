// guide.js —— 指南頁：內容全部讀自 guide-data.js（同球場面板「街場指南」tab 同一份）
const gTabs = document.getElementById("gTabs");
const gPanels = document.getElementById("gPanels");

document.getElementById("gLead").textContent = GUIDE.head.lead;
document.getElementById("gTip").textContent = GUIDE.head.tip;
document.getElementById("gScope").textContent = GUIDE.head.scope;

for (const [i, t] of GUIDE.tabs.entries()) {
  const btn = document.createElement("button");
  btn.className = "tab";
  btn.setAttribute("role", "tab");
  btn.id = "tab-" + t.id;
  btn.setAttribute("aria-controls", "panel-" + t.id);
  btn.setAttribute("aria-selected", "false");
  btn.tabIndex = -1;
  btn.textContent = t.label;
  btn.addEventListener("click", () => select(t.id, true));

  const panel = document.createElement("section");
  panel.className = "tabpanel";
  panel.id = "panel-" + t.id;
  panel.setAttribute("role", "tabpanel");
  panel.setAttribute("aria-labelledby", btn.id);
  panel.hidden = true;
  panel.innerHTML = guideSectionHtml(t);          // 內容係我哋嘅固定文字，唔係使用者輸入
  gTabs.append(btn);
  gPanels.append(panel);
}

const ids = GUIDE.tabs.map((t) => t.id);

function select(id, moveFocus) {
  if (!ids.includes(id)) id = ids[0];
  for (const t of GUIDE.tabs) {
    const btn = document.getElementById("tab-" + t.id), panel = document.getElementById("panel-" + t.id);
    const on = t.id === id;
    btn.setAttribute("aria-selected", on ? "true" : "false");
    btn.tabIndex = on ? 0 : -1;
    panel.hidden = !on;
  }
  if (history.replaceState) history.replaceState(null, "", "#" + id);
  if (moveFocus) document.getElementById("tab-" + id).focus();
}

// 分頁要用键盘行到（06 共用可及性：键盘可操作、焦點清楚）
gTabs.addEventListener("keydown", (e) => {
  const cur = ids.indexOf(GUIDE.tabs.find((t) => document.getElementById("tab-" + t.id).getAttribute("aria-selected") === "true").id);
  const next = { ArrowRight: (cur + 1) % ids.length, ArrowLeft: (cur + ids.length - 1) % ids.length,
    Home: 0, End: ids.length - 1 }[e.key];
  if (next === undefined) return;
  e.preventDefault();
  select(ids[next], true);
});

// 由球場面板入嚟會帶 ?court=ID：「返回球場」就返去嗰個場地嘅面板
const fromCourt = new URLSearchParams(location.search).get("court");
if (fromCourt) document.getElementById("gBack").href = "index.html?court=" + encodeURIComponent(fromCourt);

select((location.hash || "").slice(1) || ids[0], false);
