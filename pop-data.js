// pop-data.js —— 十八區人口（靜態參考數字，用嚟計「球場對人口」比例圖）
//
// 來源：政府統計處《2021 年人口普查》，經 data.gov.hk 發布嘅
//       「2021 Population Census (Statistics and Boundaries of District Council Districts)」
//       CSV：https://www.census2021.gov.hk/doc/DC_21C.zip（檔案 DC_21C.CSV，欄位 dc_class / t_pop）
// 下載日：2026-11-19。dc_class 嘅英文代碼同本站 districts 嘅 code 完全對得上（18 個全部匹配）。
// 已核：18 區總和 = 7,411,945 = 官方「陸上總計」，差 0。（官方總人口 7,413,070 另含水上人口，
//       唔屬於任何區議會分區，所以比例圖用陸上總計做分母先至啱。）
// 呢份係一次性普查數字，唔會跟活動資料更新；用嘅時候要講明係 2021 年。
const POP2021 = {
  A: 235953,   // 中西區 Central and Western
  B: 166695,   // 灣仔區 Wan Chai
  C: 529603,   // 東區 Eastern
  D: 263278,   // 南區 Southern
  E: 310647,   // 油尖旺區 Yau Tsim Mong
  F: 431090,   // 深水埗區 Sham Shui Po
  G: 410634,   // 九龍城區 Kowloon City
  H: 406802,   // 黃大仙區 Wong Tai Sin
  J: 673166,   // 觀塘區 Kwun Tong
  K: 320094,   // 荃灣區 Tsuen Wan
  L: 506879,   // 屯門區 Tuen Mun
  M: 668080,   // 元朗區 Yuen Long
  N: 309631,   // 北區 North
  P: 316470,   // 大埔區 Tai Po
  Q: 489037,   // 西貢區 Sai Kung
  R: 692806,   // 沙田區 Sha Tin
  S: 495798,   // 葵青區 Kwai Tsing
  T: 185282,   // 離島區 Islands
};
const POP2021_LAND_TOTAL = 7411945;
const POP2021_SOURCE = "政府統計處《2021 年人口普查》：區議會分區總人口（data.gov.hk 發布嘅 DC_21C.CSV，2026-11-19 下載）";
