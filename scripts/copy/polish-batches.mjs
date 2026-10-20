// 磨光④ 文案班：把字串清單分批送 Gemini 4 Argon（經本機 OmniAPI 的 MCP HTTP 端點）潤飾。
// 用法：node scripts/copy/polish-batches.mjs [--only 3] [--limit 1] [--dry] [--size 90]
// 每批的 prompt 與回應原文存 docs/research/文案潤飾-raw/batch-NN.prompt.md / batch-NN.response.json；
// 已有回應的批次會跳過（可中斷續跑）。合併結果寫 docs/research/文案潤飾-raw/results.json。
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const DRY = args.includes("--dry");
const ONLY = opt("--only", null);
const LIMIT = Number(opt("--limit", "0"));
const SIZE = Number(opt("--size", "90"));
const MODEL = opt("--model", "gemini-4-argon");
const MCP = "http://127.0.0.1:7788/mcp";

const LIST = "docs/research/2026-10-20-文案-字串清單.json";
const RAW_DIR = "docs/research/文案潤飾-raw";
const WL_PATH = "scripts/copy/whitelist.json";

const data = JSON.parse(fs.readFileSync(LIST, "utf8"));
const wl = JSON.parse(fs.readFileSync(WL_PATH, "utf8"));
const WL_TERMS = Object.entries(wl)
  .filter(([k]) => !k.startsWith("_"))
  .flatMap(([, v]) => v);
const WL_SET = new Set(WL_TERMS);

// ---- 去重、預先過濾 ----
const uniq = new Map();
for (const r of data.records) {
  if (!uniq.has(r.text)) uniq.set(r.text, []);
  uniq.get(r.text).push(r);
}
const items = []; // 要送的
const auto = []; // 自動判定不動
let uid = 1;
for (const [text, rs] of uniq) {
  const base = { uid: uid++, text, screen: rs[0].screen, role: rs[0].role, file: rs[0].file, occurrences: rs.map((r) => r.id) };
  if (rs.every((r) => r.kind === "cmp")) auto.push({ ...base, why: "比較值／資料，不是文案" });
  else if ([...text].length <= 2) auto.push({ ...base, why: "兩個字以內（印章、單字標籤）" });
  else if (WL_SET.has(text)) auto.push({ ...base, why: "白名單詞" });
  else items.push(base);
}

// ---- 分批：同畫面同批；store／domain 依檔案 ----
const SCREEN_DESC = {
  今日視圖: "首頁「今日視圖」：今天要做的車票清單、誤點區、蓋章、推遲、臨時車票行內新增。",
  路線圖: "「路線圖」主視圖：左側幹線／路線側欄＋右側任務大綱樹（支線→列車→車廂→車票），行內改名、拖曳、移動、刪除、完成蓋章。",
  行程表: "「行程表」桌機日曆（月／週／串流），格內清單、當日清單、截止日標記。",
  "行程表（手機串流）": "手機今日 tab 裡的「行程表」串流（往下雙向串流＋週條＋月曆覆蓋層）。",
  旅客筆記: "「旅客筆記」頁：捕捉框（Ctrl+N 記一句）、收件匣、筆記、日記、當天足跡、荷札（標籤）管理、變待辦。",
  時刻表: "「時刻表」頁：時間記錄（發車台計時、分類、方眼塗色、日程、統計、時數目標、荷札）。",
  售票口: "「售票口」記帳模組：帳本、看帳（統計）、管帳（帳戶、分類、幣別、預算、定期帳、從財務管家匯入）。",
  設定: "「設定」頁：一般、備份與還原、快捷鍵、同步（端對端加密同步，用 Cloudflare R2 做雲端）。",
  手機殼: "Android 手機殼層：底部 tab、手機版各頁、手機同步頁、返回鍵、toast。",
  詳情側板: "任務「詳情側板」：點一張票／列車打開的右側面板，欄位、工作日誌、花費時間、重複規則、完成卡。",
  側欄: "桌機左側欄：幹線／路線清單、搜尋、頁務件、記一句。",
  "殼層／快捷鍵": "桌機殼層：快捷鍵登記表（設定頁「快捷鍵」籤與 ? 疊層顯示的說明）、頁面切換、全域提示。",
  完成卡: "完成蓋章後的「完成卡」：心情三燈＋一行工作日誌。",
  印章: "印章元件（済、延着、繰越、運休、受付…）的替代文字與說明。",
  共用元件: "共用元件：確認框、toast、日期挑選器、空狀態、關閉鈕等。",
  氛圍: "氛圍層（主題、背景動態）。",
  各線登記檔: "各功能線的登記檔：頁名、快捷鍵說明、同步表的人話標籤、刪除提示。",
  邏輯層文字: "邏輯層（domain）產生的文字：狀態標籤、同步合併提示、重複規則的人話描述、售票口與時刻表的計算說明。",
  狀態層文字: "狀態層（store）產生的文字：toast 訊息、確認框標題與內文、同步頁大段說明（加入同步、密語、復原碼、紀元、重新開始）、備份與還原。",
  共用函式: "共用函式產生的日期／通知文字。",
  其他: "其他。",
};
const BIG_SCREENS = new Set(["狀態層文字", "邏輯層文字", "售票口", "旅客筆記", "時刻表", "手機殼"]);
const groups = new Map();
for (const it of items) {
  const key = BIG_SCREENS.has(it.screen) ? `${it.screen}｜${path.basename(it.file)}` : it.screen;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(it);
}
// 小群合併到同畫面、再切 SIZE
const batches = [];
const byScreen = new Map();
for (const [key, arr] of groups) {
  const screen = key.split("｜")[0];
  if (!byScreen.has(screen)) byScreen.set(screen, []);
  byScreen.get(screen).push({ key, arr });
}
for (const [screen, parts] of byScreen) {
  let cur = [];
  let curKeys = [];
  const flush = () => {
    if (cur.length) batches.push({ screen, keys: [...curKeys], items: cur });
    cur = [];
    curKeys = [];
  };
  for (const { key, arr } of parts) {
    if (cur.length && cur.length + arr.length > SIZE) flush();
    if (arr.length > SIZE) {
      flush();
      for (let i = 0; i < arr.length; i += SIZE) batches.push({ screen, keys: [key], items: arr.slice(i, i + SIZE) });
    } else {
      cur.push(...arr);
      curKeys.push(key);
    }
  }
  flush();
}
batches.forEach((b, i) => (b.no = i + 1));

fs.mkdirSync(RAW_DIR, { recursive: true });
fs.writeFileSync(path.join(RAW_DIR, "_auto-keep.json"), JSON.stringify(auto, null, 1), "utf8");
fs.writeFileSync(path.join(RAW_DIR, "_batches.json"), JSON.stringify(batches.map((b) => ({ no: b.no, screen: b.screen, keys: b.keys, n: b.items.length, uids: b.items.map((i) => i.uid) })), null, 1), "utf8");
console.log(`unique=${uniq.size} auto-keep=${auto.length} to-send=${items.length} batches=${batches.length}`);
if (DRY) {
  for (const b of batches) console.log(`#${String(b.no).padStart(2, "0")} ${b.screen} ×${b.items.length}  ${b.keys.map((k) => k.split("｜")[1] || "").filter(Boolean).join(",")}`);
  process.exit(0);
}

// ---- prompt ----
const SYSTEM = `你是一位文筆自然、很有真人感的中文文案編輯，正在替一個叫「私鐵手帳（Next Stop）」的個人生產力 App 潤飾介面文案。
這個 App 用鐵道比喻管理任務：專案是路線、任務是列車、待辦是車票，完成就蓋「済」章；還有旅客筆記（筆記／日記）、時刻表（時間記錄）、售票口（記帳）。
使用者是一般人，不是工程師。請用繁體中文（台灣用語）作答。`;

function buildPrompt(b) {
  const lines = [];
  lines.push(`## 任務`);
  lines.push(`下面是 App 裡「${b.screen}」這部分的 ${b.items.length} 條介面文字。請逐條檢查，照三條規則給建議：`);
  lines.push(`1. **大眾化**：不要術語、不要一般人看不懂的詞；能用日常說法就用日常說法。`);
  lines.push(`2. **精簡**：說明小字一段超過兩句的，優先砍成一句、或改成 tooltip 等級的短句；能不解釋機制就不解釋，只講「這會發生什麼」「你要做什麼」。`);
  lines.push(`3. **不自創詞**：不要發明新名詞；既有的專屬語彙（見白名單）保留，其他地方用大家都懂的字。`);
  lines.push(``);
  lines.push(`## 一定要遵守`);
  lines.push(`- **白名單裡的詞一律不動**（不換同義詞、不加解釋）；含白名單詞的句子可以精簡，但詞本身原樣保留。`);
  lines.push(`- 日文只當印章／標籤／狀態章名（済・延着・繰越・運休・受付・領収・入鋏・検印…），不當句子用；目前文案裡的日文章名都保留。`);
  lines.push(`- 「按鈕」「標籤」「印章」「tooltip」這類短文字**不可以變長**；要嘛更短，要嘛不動。`);
  lines.push(`- 中文標點與全形括號照原文習慣（全形「」（）、「——」、「…」照用）；不要改成半形。`);
  lines.push(`- \`{…}\` 是程式填入的變數（數字、名稱、日期），**個數與相對位置不能動**，建議句裡也要留著一樣多的 \`{…}\`；\`⏎\` 是換行，照留。`);
  lines.push(`- 不要改變意思、不要把警告變成沒有警告、不要把「會刪掉」「找不回來」這類後果拿掉——可以講得更短，但後果要在。`);
  lines.push(`- 原文已經夠好就填「不動」，不要為改而改。`);
  lines.push(`- 鍵盤鍵名（Ctrl、Enter、T、Shift…）、英文專名（Cloudflare、R2、API token、bucket）照原樣；但如果一句話在教一般人做開發者才會做的事（跑指令、填 bucket），請把句子改成一般人看得懂的指引，指令本身可以保留。`);
  lines.push(``);
  lines.push(`## 白名單（原樣保留的詞）`);
  for (const [k, v] of Object.entries(wl)) {
    if (k.startsWith("_")) continue;
    lines.push(`- ${k}：${v.join("、")}`);
  }
  lines.push(``);
  lines.push(`## 這批的畫面脈絡`);
  lines.push(SCREEN_DESC[b.screen] || b.screen);
  if (b.keys.some((k) => k.includes("｜"))) lines.push(`來源檔：${b.keys.map((k) => k.split("｜")[1]).filter(Boolean).join("、")}`);
  lines.push(``);
  lines.push(`## 條目（id｜角色｜原文）`);
  for (const it of b.items) lines.push(`${it.uid}｜${it.role}｜${it.text}`);
  lines.push(``);
  lines.push(`## 輸出格式`);
  lines.push(`只輸出一個 JSON 物件：{"items":[{"id":數字,"原文":"…","建議":"…","改動類型":"精簡|換詞|刪掉|不動","理由":"一句話"}, …]}`);
  lines.push(`- 每一條都要有一筆，id 與原文照抄。`);
  lines.push(`- 「不動」時「建議」填原文；「刪掉」（整段多餘、使用者不需要知道）時「建議」填空字串並在理由說為什麼可以拿掉。`);
  lines.push(`- 一條同時精簡又換詞，類型填「精簡」。理由盡量短（十幾個字）。`);
  return lines.join("\n");
}

// ---- MCP HTTP ----
let sessionId = null;
let rpcId = 1;
async function rpc(method, params) {
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(MCP, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }) });
  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  // SSE 或純 JSON
  const datas = text
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim());
  const payloads = datas.length ? datas.map((d) => JSON.parse(d)) : [JSON.parse(text)];
  const msg = payloads.find((p) => p.result || p.error) || payloads[0];
  if (msg.error) throw new Error(`RPC error: ${JSON.stringify(msg.error).slice(0, 500)}`);
  return msg.result;
}
async function initMcp() {
  await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "nextstop-copy-polish", version: "0.1" } });
  // notifications/initialized
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "mcp-session-id": sessionId };
  await fetch(MCP, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
}
function toolText(result) {
  const c = (result.content || []).find((x) => x.type === "text");
  if (!c) throw new Error("tool result has no text: " + JSON.stringify(result).slice(0, 300));
  try {
    return JSON.parse(c.text);
  } catch {
    return { text: c.text };
  }
}
async function callTool(name, args) {
  const r = await rpc("tools/call", { name, arguments: args });
  if (r.isError) throw new Error("tool error: " + JSON.stringify(r).slice(0, 500));
  return toolText(r);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function complete(prompt) {
  let out = await callTool("complete_text", {
    prompt,
    system: SYSTEM,
    model: MODEL,
    response_format: { type: "json_object" },
    max_completion_tokens: 32000,
  });
  let waited = 0;
  while (out && out.status === "running" && out.task_id) {
    await sleep(20000);
    waited += 20;
    out = await callTool("get_job_result", { task_id: out.task_id });
    if (waited > 1200) throw new Error("waited too long for " + out.task_id);
  }
  return out;
}

function parseItems(out) {
  const raw = out.text ?? out.result ?? "";
  const s = typeof raw === "string" ? raw : JSON.stringify(raw);
  const start = s.indexOf("{");
  const j = JSON.parse(s.slice(start, s.lastIndexOf("}") + 1));
  return Array.isArray(j) ? j : j.items;
}

// ---- 主流程 ----
await initMcp();
const resultsPath = path.join(RAW_DIR, "results.json");
const results = fs.existsSync(resultsPath) ? JSON.parse(fs.readFileSync(resultsPath, "utf8")) : {};
let done = 0;
for (const b of batches) {
  if (ONLY && String(b.no) !== ONLY) continue;
  if (LIMIT && done >= LIMIT) break;
  const tag = `batch-${String(b.no).padStart(2, "0")}`;
  const respPath = path.join(RAW_DIR, `${tag}.response.json`);
  if (fs.existsSync(respPath) && !ONLY) {
    continue;
  }
  const prompt = buildPrompt(b);
  fs.writeFileSync(path.join(RAW_DIR, `${tag}.prompt.md`), `# ${tag}｜${b.screen}｜${b.items.length} 條｜model=${MODEL}\n\n## system\n\n${SYSTEM}\n\n## user\n\n${prompt}\n`, "utf8");
  const t0 = Date.now();
  process.stdout.write(`${tag} ${b.screen} ×${b.items.length} … `);
  let out;
  try {
    out = await complete(prompt);
  } catch (e) {
    console.log(`FAIL ${e.message}`);
    fs.writeFileSync(path.join(RAW_DIR, `${tag}.error.txt`), String(e.stack || e), "utf8");
    continue;
  }
  fs.writeFileSync(respPath, JSON.stringify(out, null, 1), "utf8");
  let parsed;
  try {
    parsed = parseItems(out);
  } catch (e) {
    console.log(`parsed FAIL ${e.message}`);
    continue;
  }
  const byId = new Map(parsed.map((p) => [Number(p.id), p]));
  let missing = 0;
  for (const it of b.items) {
    const p = byId.get(it.uid);
    if (!p) {
      missing++;
      continue;
    }
    results[it.uid] = { ...it, batch: b.no, 建議: p["建議"] ?? "", 改動類型: p["改動類型"] ?? "", 理由: p["理由"] ?? "", 回傳原文: p["原文"] };
  }
  fs.writeFileSync(resultsPath, JSON.stringify(results, null, 1), "utf8");
  const cost = out.cost_usd != null ? ` $${Number(out.cost_usd).toFixed(4)}` : "";
  console.log(`ok ${parsed.length} 筆${missing ? `（缺 ${missing}）` : ""} ${((Date.now() - t0) / 1000).toFixed(0)}s${cost} model=${out.model || ""}`);
  done++;
}
console.log(`results=${Object.keys(results).length}/${items.length}`);
