// 磨光④ 文案班：把 Gemini 的潤飾結果整理成對照表（給使用者看）＋採用清單 JSON（第二段套用用）。
// 用法：node scripts/copy/build-review-table.mjs
// 讀：docs/research/文案潤飾-raw/results.json、_auto-keep.json、2026-10-20-文案-字串清單.json、scripts/copy/whitelist.json、scripts/copy/review-notes.json（人工標記：退回／體檢／改建議）
// 寫：docs/research/2026-10-20-文案潤飾-對照表.md、docs/research/2026-10-20-文案潤飾-採用.json
import fs from "node:fs";

const RAW = "docs/research/文案潤飾-raw";
const results = JSON.parse(fs.readFileSync(`${RAW}/results.json`, "utf8"));
const auto = JSON.parse(fs.readFileSync(`${RAW}/_auto-keep.json`, "utf8"));
const list = JSON.parse(fs.readFileSync("docs/research/2026-10-20-文案-字串清單.json", "utf8"));
const wl = JSON.parse(fs.readFileSync("scripts/copy/whitelist.json", "utf8"));
const notesPath = "scripts/copy/review-notes.json";
const notes = fs.existsSync(notesPath) ? JSON.parse(fs.readFileSync(notesPath, "utf8")) : { override: {}, reject: {}, check: {}, extra: [] };
const WL_TERMS = Object.entries(wl)
  .filter(([k]) => !k.startsWith("_"))
  .flatMap(([, v]) => v)
  .sort((a, b) => b.length - a.length);
const recById = new Map(list.records.map((r) => [r.id, r]));

const SHORT_ROLES = /按鈕|標籤|tooltip|placeholder|印章|選項|名稱|鍵帽|欄位標籤|無障礙/;
const HINT_ROLES = /說明小字|段落|列表項|組合句|字串|文字|toast|確認框|錯誤訊息|空狀態/;
const count = (s, re) => (s.match(re) || []).length;

// 人工標記用 record id 當鍵；對到 uid
const noteFor = (r, table, tableUid) => {
  if (tableUid && tableUid[r.uid] != null) return tableUid[r.uid];
  for (const id of r.occurrences) if (table && table[id] != null) return table[id];
  return undefined;
};
const rows = [];
for (const r of Object.values(results)) {
  const uid = Number(r.uid);
  let 建議 = r.建議 ?? "";
  let 類型 = r.改動類型 || "不動";
  let 理由 = r.理由 || "";
  const 原文 = r.text;
  let 退回 = "";
  const 標記 = [];

  const ov = noteFor(r, notes.override, notes.overrideUid);
  if (ov) {
    const o = ov;
    if (o.建議 != null) 建議 = o.建議;
    if (o.類型) 類型 = o.類型;
    if (o.理由) 理由 = o.理由;
    標記.push("人工改");
  }
  const ck = noteFor(r, notes.check, notes.checkUid);
  if (ck) 標記.push(`體檢 ${ck}`);

  // 一致性：建議＝原文 → 不動
  if (類型 !== "刪掉" && 建議.trim() === 原文.trim()) 類型 = "不動";
  if (類型 === "不動" && 建議.trim() !== 原文.trim() && 建議.trim()) 類型 = "精簡";
  if (類型 === "刪掉" && 建議.trim()) 類型 = "精簡";

  if (類型 !== "不動") {
    // 自檢：白名單詞被改掉
    for (const t of WL_TERMS) {
      if (原文.includes(t) && !建議.includes(t) && 類型 !== "刪掉") {
        退回 = `改掉了白名單詞「${t}」`;
        break;
      }
    }
    // 自檢：日系語彙（不在白名單的單字層級，但整個 App 刻意用的字）
    const NIHON = ["時刻", "今日", "本班", "到站", "出發", "発", "班", "蓋章", "蓋", "印"];
    if (!退回 && 類型 !== "刪掉") {
      for (const t of NIHON) if (原文.includes(t) && !建議.includes(t)) { 退回 = `動到日系語彙「${t}」`; break; }
    }
    if (!退回 && 類型 !== "刪掉" && 原文.includes("子項") && !建議.includes("子項")) 退回 = "「子項」一詞保留（別處還在用，改了會不一致）";
    // 自檢：變數個數
    if (!退回 && 類型 !== "刪掉" && count(原文, /\{…\}/g) !== count(建議, /\{…\}/g)) 退回 = "變數 {…} 個數不符";
    // 自檢：短文字變長
    if (!退回 && SHORT_ROLES.test(r.role) && [...建議].length > [...原文].length) 退回 = "按鈕／標籤／提示變長了";
    // 自檢：半形括號混入
    if (!退回 && /[()]/.test(建議) && !/[()]/.test(原文)) 退回 = "改成半形括號";
    // 自檢：刪掉有後果字眼的句子
    if (!退回 && 類型 === "刪掉" && /刪|清|消失|找不回|不可逆|覆蓋|蓋掉|重新開始/.test(原文)) 退回 = "刪掉的句子含後果提醒";
    // 自檢：空建議但不是刪掉
    if (!退回 && 類型 !== "刪掉" && !建議.trim()) 退回 = "建議是空的";
    const rj = noteFor(r, notes.reject, notes.rejectUid);
    if (rj) 退回 = rj;
    if (ov) 退回 = ""; // 人工改過的建議不再自檢退回
  }

  // 分區
  let 區 = "其他";
  if (類型 !== "不動") {
    const selfMade = /自創|發明|生造|新詞|不在白名單|不常見的詞|罕見/.test(理由);
    if (類型 === "刪掉" || (類型 === "精簡" && HINT_ROLES.test(r.role) && [...原文].length >= 24)) 區 = "說明小字砍短";
    else if (類型 === "換詞" && selfMade) 區 = "自創詞";
    else if (類型 === "換詞") 區 = "術語換白話";
    else 區 = "其他";
  }

  rows.push({ uid, 畫面: r.screen, 角色: r.role, 原文, 建議, 類型, 理由, 退回, 標記, 區, occurrences: r.occurrences, file: r.file });
}
rows.sort((a, b) => a.uid - b.uid);

// 體檢的補充條目（A 的加工單；整句新建議，不一定對到單一字串）
const extra = notes.extra || [];

// 統計
const stat = { 總數: list.unique, 自動不動: auto.length, 送潤飾: rows.length, 精簡: 0, 換詞: 0, 刪掉: 0, 不動: 0, 退回: 0 };
for (const r of rows) {
  if (r.退回) stat.退回++;
  else stat[r.類型] = (stat[r.類型] || 0) + 1;
}
const 採用 = rows.filter((r) => r.類型 !== "不動" && !r.退回);

// ---- Markdown ----
const esc = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, "⏎");
let md = `# 文案潤飾對照表（磨光④）\n\n`;
md += `> 潤飾：Gemini 4 Argon（經 OmniAPI，model id \`gemini-4-argon\`），40 批；原始 prompt 與回應在 \`docs/research/文案潤飾-raw/\`。\n`;
md += `> 字串來源：\`scripts/copy/extract-strings.mjs\` 掃 \`src/**/*.ts(x)\`（排除 console、註解、測試、mock 種子、dev 工具）。\n`;
md += `> 品味類——整體看一眼就好，不用逐條驗；有不對味的指出那一條即可，其餘照表套用。\n\n`;

md += `## 範圍與備註\n\n`;
md += `- 掃的是前端 \`src/**/*.ts(x)\`。**Rust 側（\`src-tauri/\`）約 1,100 條中文字串沒納入**——多是備份／同步失敗的原因說明與系統匣選單，要的話下一輪再開一班。\n`;
md += `- 自檢退回的規則：改掉白名單詞、動到日系語彙（時刻、今日、班、到站、出發、蓋、着…）、按鈕／標籤變長、變數 \`{…}\` 個數不符、刪掉含後果提醒的句子、開發用 mock／內部錯誤訊息；另有 F 逐條看過後手動退回或改寫的（理由寫在表裡）。\n`;
md += `- 第二段套用：採用的句子裡約 960 處能用腳本套（只換字串、不動邏輯），其餘 31 處是 JSX 裡文字與變數交錯的，由 F 用 Edit 手改；\`{…}\` 是程式填的變數、\`⏎\` 是換行。\n`;
md += `- 體檢加工單（A 10-20 16:41）六題的建議列在下一節，表裡對應的列標【體檢 N3】等。\n\n`;
md += `## 白名單（一律不動）\n\n`;
for (const [k, v] of Object.entries(wl)) {
  if (k.startsWith("_")) continue;
  md += `- **${k}**：${v.join("、")}\n`;
}
md += `\n`;

md += `## 統計\n\n| 項目 | 條數 |\n|---|---|\n`;
md += `| 抽到的字串（去重後的句子） | ${stat.總數} |\n`;
md += `| 自動判不動（兩字以內的章名／單字標籤、白名單詞、純資料比較值） | ${stat.自動不動} |\n`;
md += `| 送 Gemini 潤飾 | ${stat.送潤飾} |\n`;
md += `| ├ 精簡 | ${stat.精簡} |\n| ├ 換詞 | ${stat.換詞} |\n| ├ 刪掉 | ${stat.刪掉} |\n| ├ 不動 | ${stat.不動} |\n| └ 退回（建議違反白名單／改掉印章語彙／意思跑掉，不採用） | ${stat.退回} |\n`;
md += `| **採用、第二段會套進程式碼** | **${採用.length}** 句（對應 ${採用.reduce((n, r) => n + r.occurrences.length, 0)} 處） |\n\n`;

if (extra.length) {
  md += `## 體檢加工單（A 轉來的體檢發現；第二段一起套）\n\n| 編號 | 題目 | 現況 | 建議（統一成） | 說明 |\n|---|---|---|---|---|\n`;
  for (const e of extra) md += `| ${e.編號} | ${esc(e.題目)} | ${esc(e.現況)} | ${esc(e.建議)} | ${esc(e.說明 || "")} |\n`;
  md += `\n`;
}

const SECTIONS = ["說明小字砍短", "術語換白話", "自創詞", "其他"];
const SECTION_DESC = {
  說明小字砍短: "超過兩句的說明、解釋機制的小字，砍成一句或 tooltip 等級；「刪掉」＝整段拿掉。",
  術語換白話: "工程味、鐵道迷以外看不懂的詞，換成日常說法。",
  自創詞: "不在白名單、也不是大家會用的詞，換掉。",
  其他: "按鈕、標籤、toast、短句的順口修。",
};
for (const sec of SECTIONS) {
  const rs = rows.filter((r) => r.區 === sec && !r.退回 && r.類型 !== "不動");
  md += `## ${sec}（${rs.length} 條）\n\n${SECTION_DESC[sec]}\n\n`;
  if (!rs.length) {
    md += `（無）\n\n`;
    continue;
  }
  md += `| 畫面 | 角色 | 原文 | 建議 | 理由 |\n|---|---|---|---|---|\n`;
  for (const r of rs) {
    const tag = r.標記.length ? `【${r.標記.join("／")}】` : "";
    const 建議 = r.類型 === "刪掉" ? "（刪掉）" : r.建議;
    md += `| ${esc(r.畫面)} | ${esc(r.角色)} | ${esc(r.原文)} | ${esc(建議)} | ${tag}${esc(r.理由)} |\n`;
  }
  md += `\n`;
}

const rejected = rows.filter((r) => r.退回);
md += `## 退回（Gemini 有建議、但不採用；${rejected.length} 條）\n\n| 畫面 | 角色 | 原文 | Gemini 建議 | 退回原因 |\n|---|---|---|---|---|\n`;
for (const r of rejected) md += `| ${esc(r.畫面)} | ${esc(r.角色)} | ${esc(r.原文)} | ${esc(r.建議 || "（刪掉）")} | ${esc(r.退回)}；Gemini 理由：${esc(r.理由)} |\n`;
md += `\n`;

md += `## 不動（${stat.不動} 條）\n\n送潤飾但 Gemini 認為原文已經夠好的句子，不列明細；全文在 \`文案潤飾-raw/results.json\`。自動判不動的 ${stat.自動不動} 條在 \`文案潤飾-raw/_auto-keep.json\`。\n`;

fs.writeFileSync("docs/research/2026-10-20-文案潤飾-對照表.md", md, "utf8");

// ---- 採用清單（第二段用）----
const apply = 採用.map((r) => ({
  uid: r.uid,
  原文: r.原文,
  建議: r.類型 === "刪掉" ? "" : r.建議,
  類型: r.類型,
  區: r.區,
  標記: r.標記,
  處: r.occurrences.map((id) => {
    const rec = recById.get(id);
    return { id, file: rec.file, line: rec.line, kind: rec.kind, role: rec.role, tag: rec.tag, attr: rec.attr, component: rec.component, const: rec.const };
  }),
}));
fs.writeFileSync("docs/research/2026-10-20-文案潤飾-採用.json", JSON.stringify({ generated: new Date().toISOString(), stat, extra, items: apply }, null, 1), "utf8");

console.log(JSON.stringify(stat));
console.log(`採用 ${採用.length} 句／${採用.reduce((n, r) => n + r.occurrences.length, 0)} 處；退回 ${rejected.length}`);
const byRej = {};
for (const r of rejected) byRej[r.退回] = (byRej[r.退回] || 0) + 1;
console.log("退回原因", byRej);
