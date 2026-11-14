// guide-data.js —— 街場指南嘅單一內容來源（07 號文件逐字；06 WF07 同球場面板都引用呢份，唔複製成某場專屬規則）
// 呢檔全部係我哋自己寫嘅固定文字，唔係使用者輸入，所以可以直接渲染；使用者輸入仍然要過 esc()。
const GUIDE = {
  head: {
    title: "香港街場指南",
    lead: "第一次打街場？先了解跟隊、半場玩法同基本禮儀。",
    tip: "提示：不同場地、時段及玩家可能有不同安排，開波前先問清楚。",
    scope: "內容為通用參考及產品玩法示例，待實地／內容審核，不宣稱全港統一或某場專屬規矩；不是正式 FIBA 規則。",
  },

  // ---- 分頁（06 WF07：[跟隊｜半場玩法｜確認清單｜禮儀安全]）----
  tabs: [
    {
      id: "follow",
      label: "點樣跟隊",
      blocks: [
        { h: "點樣跟隊？", p: "想參與下一場，可禮貌詢問「可唔可以跟隊？」並確認目前輪候安排。" },
        { diagram: "follow" },
        { steps: [
          "到場觀察：先看正在玩的玩法，等合適時機。",
          "詢問輪候：「而家有人跟隊嗎？」",
          "表示跟隊：清楚說明自己或小組想參與。",
          "確認次序：有其他人等候時，不插隊。",
          "輪到上場：按大家確認的安排加入。",
        ] },
        { p: "跟隊不等於立即上場，也不是網站預訂服務。勝方留場／敗方落場是可遇到的安排，先問清楚，不當作一定。" },
      ],
    },
    {
      id: "half",
      label: "半場玩法",
      blocks: [
        { h: "半場玩法圖解", p: "3對3：每隊3人，共6人。4對4：每隊4人，共8人。" },
        { diagram: "players" },
        { diagram: "scoring" },
        { p: "10分制示例：弧內1分、弧外2分，先到10分；是否須贏兩分、其他勝出條件仍應先確認。" },
        { p: "21分或其他玩法由現場協議，不自動套用同一計分。圖示不是站位或戰術規定。" },
      ],
    },
    {
      id: "ask",
      label: "確認清單",
      blocks: [
        { h: "開波前問清楚", checklist: [
          "打3對3還是4對4？",
          "先到幾多分，需唔需要贏兩分？",
          "弧外入球計幾多分？",
          "進球後邊隊開球，點樣check ball？",
          "防守籃板／抄截後係咪要出弧線？",
          "犯規及爭議點處理？",
          "輸隊係咪落場，已有邊隊輪候？",
          "有冇時間限制或其他約定？",
        ] },
        { p: "不將某一種進球後開球或犯規安排宣稱唯一規則。" },
        { p: "呢個清單嘅勾選只是閱讀輔助，唔代表其他玩家已經同意，亦唔會修改任何活動（10 號 V05–07）。" },
      ],
    },
    {
      id: "care",
      label: "禮儀安全",
      blocks: [
        { h: "禮儀卡片", list: [
          "先問再加入；",
          "尊重正在比賽的人；",
          "按輪候次序；",
          "按約定輪換；",
          "友善對待不同程度玩家；",
          "帶走垃圾。",
        ] },
        { h: "安全提醒", p: "留意濕滑地面、照明及場地障礙；穿合適鞋款；不適或受傷時停止；夜間／偏遠位置可結伴；遇衝突先避免爭執，必要時離開或尋求協助。這些是提醒，不是場地安全保證。" },
      ],
    },
  ],

  // ---- 介面短句（07 第 41–46 行）：網站其他地方都要用同一句，唔好自己改寫 ----
  phrases: {
    noReport: "暫無活動回報（不代表現場無人）。",
    noFacility: "未有設施資料／位置待核實。",
    joinedNotArrived: (n) => `已有 ${n} 人表示會到，不代表全部已到場。`,
    notReservation: "活動不代表預留球場，仍須尊重現場跟隊安排。",
    notePrivacy: "備註請避免電話及其他敏感資料。",
    firstTime: "第一次打街場？查看點樣跟隊。",
  },

  // ---- 圖解：每幅都附文字替代（06 共用可及性：圖解有文字）----
  diagrams: {
    follow: {
      title: "跟隊五個步驟",
      alt: "文字替代：1 到場觀察 → 2 詢問輪候 → 3 表示跟隊 → 4 確認次序 → 5 輪到上場。",
      svg: `<svg viewBox="0 0 760 96" role="img" aria-labelledby="fgT fgD" class="dg">
  <title id="fgT">跟隊五個步驟</title>
  <desc id="fgD">由左至右五格：到場觀察、詢問輪候、表示跟隊、確認次序、輪到上場，箭嘴顯示次序。</desc>
  ${["到場觀察", "詢問輪候", "表示跟隊", "確認次序", "輪到上場"].map((t, i) => {
    const x = 8 + i * 152;
    return `<g><rect x="${x}" y="26" width="128" height="44" rx="8" class="dgBox"/>
      <text x="${x + 10}" y="20" class="dgNum">步驟 ${i + 1}</text>
      <text x="${x + 64}" y="53" text-anchor="middle" class="dgTxt">${t}</text>
      ${i < 4 ? `<path d="M${x + 132} 48 h${16} l-6 -6 v12 z" class="dgArrow"/>` : ""}</g>`;
  }).join("\n  ")}
</svg>`,
    },
    players: {
      title: "半場人數：3對3 共 6 人、4對4 共 8 人",
      alt: "文字替代：3v3 每隊 3 人、兩隊合共 6 人；4v4 每隊 4 人、兩隊合共 8 人。圓點只表示人數，不是站位或戰術規定。",
      svg: `<svg viewBox="0 0 700 250" role="img" aria-labelledby="plT plD" class="dg">
  <title id="plT">半場人數示意</title>
  <desc id="plD">左右兩個半場示意：左邊 3 對 3 共六個圓點，右邊 4 對 4 共八個圓點。圓點位置只為示意，不是站位或戰術。</desc>
  <g>
    <text x="175" y="22" text-anchor="middle" class="dgH">3對3：每隊3人，共6人</text>
    <path d="M40 210 A135 135 0 0 1 310 210" class="dgArc"/>
    <rect x="130" y="150" width="90" height="60" class="dgKey"/>
    <circle cx="110" cy="120" r="13" class="dgA"/><circle cx="175" cy="95" r="13" class="dgA"/><circle cx="240" cy="120" r="13" class="dgA"/>
    <circle cx="110" cy="185" r="13" class="dgB"/><circle cx="175" cy="205" r="13" class="dgB"/><circle cx="240" cy="185" r="13" class="dgB"/>
  </g>
  <g>
    <text x="525" y="22" text-anchor="middle" class="dgH">4對4：每隊4人，共8人</text>
    <path d="M390 210 A135 135 0 0 1 660 210" class="dgArc"/>
    <rect x="480" y="150" width="90" height="60" class="dgKey"/>
    <circle cx="430" cy="110" r="13" class="dgA"/><circle cx="495" cy="88" r="13" class="dgA"/><circle cx="560" cy="88" r="13" class="dgA"/><circle cx="620" cy="110" r="13" class="dgA"/>
    <circle cx="430" cy="190" r="13" class="dgB"/><circle cx="495" cy="212" r="13" class="dgB"/><circle cx="560" cy="212" r="13" class="dgB"/><circle cx="620" cy="190" r="13" class="dgB"/>
  </g>
</svg>`,
    },
    scoring: {
      title: "10分制示例：弧內1分、弧外2分",
      alt: "文字替代：弧線內入球計 1 分，弧線外計 2 分，先到 10 分；是否須贏兩分及其他勝出條件要先問清楚。",
      svg: `<svg viewBox="0 0 420 250" role="img" aria-labelledby="scT scD" class="dg">
  <title id="scT">10分制計分示例</title>
  <desc id="scD">半場弧線內標示入球計 1 分，弧線外標示計 2 分，旁邊標示先到 10 分。此為示例，不是正式規則。</desc>
  <path d="M30 215 A180 180 0 0 1 390 215" class="dgArc"/>
  <rect x="165" y="165" width="90" height="50" class="dgKey"/>
  <text x="210" y="120" text-anchor="middle" class="dgBig">弧內入球 1 分</text>
  <text x="210" y="60" text-anchor="middle" class="dgBig">弧外入球 2 分</text>
  <text x="210" y="240" text-anchor="middle" class="dgH">示例：先到 10 分（是否須贏兩分要先確認）</text>
</svg>`,
    },
  },
};

// 俾 guide.html 同球場面板共用：渲染一個分頁嘅 blocks
// 注意：一個 block 可以同時有標題同內容（例如 { h, checklist }），所以要串埋而唔係二揀一
function guideBlockHtml(b) {
  const out = [];
  if (b.h) out.push(`<h3>${b.h}</h3>`);
  if (b.p) out.push(`<p>${b.p}</p>`);
  if (b.list) out.push(`<ul class="guideList">${b.list.map((x) => `<li>${x}</li>`).join("")}</ul>`);
  // 勾選框只是閱讀輔助：唔存 server、唔存 localStorage，亦唔代表其他玩家同意（10 號 V07）
  if (b.checklist) out.push(`<ul class="guideCheck">${b.checklist.map((x) =>
    `<li><label><input type="checkbox"> ${x}</label></li>`).join("")}</ul>`);
  if (b.steps) out.push(`<ol class="guideSteps">${b.steps.map((x) => `<li>${x}</li>`).join("")}</ol>`);
  if (b.diagram) {
    const d = GUIDE.diagrams[b.diagram];
    out.push(`<figure class="dgFig">${d.svg}<figcaption><b>${d.title}</b><br><span class="meta">${d.alt}</span></figcaption></figure>`);
  }
  return out.join("\n");
}

function guideSectionHtml(tab) {
  return tab.blocks.map(guideBlockHtml).join("\n");
}
