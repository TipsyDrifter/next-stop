// 磨光④ 1.17.2-dev 桌機唯讀代驗（CDP 9250）：只讀，不按鍵、不改資料。
import fs from "node:fs";
const PORT = process.argv[2] || "9250";
const OUT = process.argv[3] || "cdp-verify-out";
fs.mkdirSync(OUT, { recursive: true });
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((p) => p.type === "page" && !/window=capture/.test(p.url));
if (!page) throw new Error("找不到主頁面：" + JSON.stringify(list.map((p) => p.url)));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0;
const pending = new Map();
const events = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  else if (d.method) events.push(d);
};
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression, awaitPromise = true) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.exception?.description || JSON.stringify(r.result.exceptionDetails).slice(0, 300) };
  return r.result?.result?.value;
};
await send("Runtime.enable");
await send("Log.enable");
const out = {};
out.url = page.url;
out.title = await ev("document.title", false);
out.version = await ev("window.__TAURI_INTERNALS__.invoke('plugin:app|version')");
out.bodyHasGate = await ev("(()=>{const t=document.body.innerText;return {warn:t.includes('⚠'), migration:/migration|sqlx/i.test(t), newer:t.includes('較新版'), len:t.length}})()", false);
out.migrations = await ev("window.__TAURI_INTERNALS__.invoke('plugin:sql|select',{db:'sqlite:next-stop-v2.db',query:'SELECT count(*) AS n, max(version) AS v FROM _sqlx_migrations',values:[]})");
out.tickets = await ev("window.__TAURI_INTERNALS__.invoke('plugin:sql|select',{db:'sqlite:next-stop-v2.db',query:\"SELECT count(*) AS n FROM nodes WHERE kind='ticket' AND deleted_at IS NULL\",values:[]})");
out.syncStatus = await ev("window.__TAURI_INTERNALS__.invoke('sync_status').then(s=>({phase:s.phase??s.state??null,running:s.running,schema:s.schema_version??s.local_schema??null,last_error:s.last_error??null,pending_ops:s.pending_ops??null})).catch(e=>({error:String(e)}))");
// 新文案是否在 bundle 裡：抓頁面的主 script，找幾句
out.bundle = await ev(`(async()=>{const srcs=[...document.scripts].map(s=>s.src).filter(Boolean);let hit={};for(const s of srcs){try{const t=await (await fetch(s)).text();for(const k of ['開關詳情側板','這一趟做了什麼','請選至少一個分類或荷札','上層分類','變成 ','還在進行嗎','詳情側板 開／關','子荷札','乘務記錄','次期開業予定']){hit[k]=(hit[k]||0)+(t.split(k).length-1)}}catch(e){hit['_err_'+s]=String(e)}}return {scripts:srcs.length,hit}})()`);
out.pageText = (await ev("document.body.innerText.slice(0,1500)", false));
// console：等 6 秒收事件
await new Promise((r) => setTimeout(r, 6000));
out.console = events.filter((e) => e.method === "Runtime.consoleAPICalled").map((e) => ({ type: e.params.type, text: e.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 200) }));
out.exceptions = events.filter((e) => e.method === "Runtime.exceptionThrown").map((e) => e.params.exceptionDetails?.exception?.description?.slice(0, 300));
out.logEntries = events.filter((e) => e.method === "Log.entryAdded").map((e) => ({ level: e.params.entry.level, text: e.params.entry.text.slice(0, 200) }));
const shot = await send("Page.captureScreenshot", { format: "jpeg", quality: 70 });
if (shot.result?.data) fs.writeFileSync(`${OUT}/screenshot.jpg`, Buffer.from(shot.result.data, "base64"));
fs.writeFileSync(`${OUT}/result.json`, JSON.stringify(out, null, 1), "utf8");
console.log(JSON.stringify({ ...out, pageText: out.pageText?.slice(0, 300) }, null, 1));
ws.close();
