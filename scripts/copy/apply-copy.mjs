// 磨光④ 文案班（第二段）：把採用清單套進 src/。只改字串字面值／JSX 文字，不改邏輯。
// 用法：node scripts/copy/apply-copy.mjs [--ts <typescript 路徑>] [--write]（預設乾跑，只報告）
// 讀：docs/research/2026-10-20-文案潤飾-採用.json
// 寫（--write 時）：對應的 src 檔；另產 docs/research/文案潤飾-raw/_apply-report.md（自動套了哪些、哪些要手動）
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const WRITE = args.includes("--write");
const ROOT = process.cwd();
const TS_PATH = opt("--ts", path.join(ROOT, "node_modules", "typescript"));
const ts = createRequire(import.meta.url)(TS_PATH);

const plan = JSON.parse(fs.readFileSync("docs/research/2026-10-20-文案潤飾-採用.json", "utf8"));
const CJK = /[぀-ヿ㐀-䶿一-鿿]/;
const PH = "{…}";

// 依檔案分組
const byFile = new Map();
for (const it of plan.items) {
  for (const p of it.處) {
    if (!byFile.has(p.file)) byFile.set(p.file, []);
    byFile.get(p.file).push({ ...p, uid: it.uid, 原文: it.原文, 建議: it.建議, 類型: it.類型 });
  }
}

const INLINE_TAGS = new Set(["span", "strong", "em", "b", "i", "kbd", "code", "small", "u", "s", "sup", "sub", "mark", "br"]);
function renderTemplate(t) {
  let s = t.head.text;
  for (const sp of t.templateSpans) s += PH + sp.literal.text;
  return s;
}
function tagName(el) {
  const open = ts.isJsxElement(el) ? el.openingElement : el;
  return open.tagName.getText();
}
function renderJsxChildren(el, sf, depth = 0) {
  let out = "";
  for (const c of el.children) {
    if (ts.isJsxText(c)) out += c.getText(sf).replace(/\s*\n\s*/g, "").replace(/\s+/g, " ");
    else if (ts.isJsxExpression(c)) {
      const e = c.expression;
      if (!e) continue;
      if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) out += e.text;
      else if (ts.isTemplateExpression(e)) out += renderTemplate(e);
      else out += PH;
    } else if (ts.isJsxElement(c) && INLINE_TAGS.has(tagName(c)) && depth < 3) out += renderJsxChildren(c, sf, depth + 1);
    else if (ts.isJsxSelfClosingElement(c) && tagName(c) === "br") out += "⏎";
    else out += PH;
  }
  return out.trim();
}
const norm = (s) => s.replace(/\s+/g, " ").trim();

function escapeFor(quote, text) {
  if (quote === "`") return text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
  return text.replace(/\\/g, "\\\\").replace(new RegExp(quote, "g"), "\\" + quote);
}

const report = { auto: [], manual: [], notFound: [] };
let filesTouched = 0;

for (const [file, items] of byFile) {
  const abs = path.join(ROOT, file);
  if (!fs.existsSync(abs)) {
    for (const it of items) report.notFound.push({ ...it, why: "檔案不存在（可能已被別線改名）" });
    continue;
  }
  const src = fs.readFileSync(abs, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const edits = []; // {start,end,text}

  // 收集所有候選節點（字串、樣板、JSX 元素），用「渲染後文字」比對
  const strNodes = [];
  const jsxNodes = [];
  (function walk(n) {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) strNodes.push(n);
    else if (ts.isJsxElement(n) && n.children.some((c) => ts.isJsxText(c) && CJK.test(c.getText(sf)))) jsxNodes.push(n);
    ts.forEachChild(n, walk);
  })(sf);
  const used = new Set();

  for (const it of items) {
    const want = norm(it.原文);
    const line = it.line;
    let hit = null;
    if (it.kind === "jsx") {
      hit = jsxNodes.find((n) => !used.has(n) && Math.abs(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 - line) <= 3 && norm(renderJsxChildren(n, sf)) === want) || jsxNodes.find((n) => !used.has(n) && norm(renderJsxChildren(n, sf)) === want);
    } else {
      const render = (n) => (ts.isTemplateExpression(n) ? renderTemplate(n) : n.text);
      hit = strNodes.find((n) => !used.has(n) && Math.abs(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 - line) <= 3 && norm(render(n)) === want) || strNodes.find((n) => !used.has(n) && norm(render(n)) === want);
    }
    if (!hit) {
      report.notFound.push({ ...it, why: "找不到同文字的節點（檔案可能已改）" });
      continue;
    }
    used.add(hit);
    const nowLine = sf.getLineAndCharacterOfPosition(hit.getStart(sf)).line + 1;

    if (it.類型 === "刪掉" || !it.建議) {
      report.manual.push({ ...it, nowLine, why: "刪掉要看版面（空 <p>／空 toast），手動處理" });
      continue;
    }

    if (ts.isStringLiteral(hit)) {
      const raw = hit.getText(sf);
      const q = raw[0];
      edits.push({ start: hit.getStart(sf) + 1, end: hit.getEnd() - 1, text: escapeFor(q, it.建議) });
      report.auto.push({ ...it, nowLine });
    } else if (ts.isNoSubstitutionTemplateLiteral(hit)) {
      edits.push({ start: hit.getStart(sf) + 1, end: hit.getEnd() - 1, text: escapeFor("`", it.建議) });
      report.auto.push({ ...it, nowLine });
    } else if (ts.isTemplateExpression(hit)) {
      const parts = it.建議.split(PH);
      if (parts.length !== hit.templateSpans.length + 1) {
        report.manual.push({ ...it, nowLine, why: "樣板字串的變數個數對不上" });
        continue;
      }
      // 只改各段文字，不動 ${…}
      const headStart = hit.head.getStart(sf) + 1; // 跳過 `
      const headEnd = hit.head.getEnd() - 2; // 去掉 ${
      edits.push({ start: headStart, end: headEnd, text: escapeFor("`", parts[0]) });
      hit.templateSpans.forEach((sp, i) => {
        const lit = sp.literal;
        const s = lit.getStart(sf) + 1; // 跳過 }
        const e = lit.getEnd() - (ts.isTemplateTail(lit) ? 1 : 2); // 去掉 ` 或 ${
        edits.push({ start: s, end: e, text: escapeFor("`", parts[i + 1]) });
      });
      report.auto.push({ ...it, nowLine });
    } else if (ts.isJsxElement(hit)) {
      // 只處理「文字＋表達式」單層：子節點裡沒有巢狀元素，且 {…} 個數對得上非文字子節點
      const kids = hit.children.filter((c) => !(ts.isJsxText(c) && !c.getText(sf).trim()) && !(ts.isJsxExpression(c) && !c.expression));
      const exprKids = kids.filter((c) => !ts.isJsxText(c));
      const stringExprKids = exprKids.filter((c) => ts.isJsxExpression(c) && c.expression && (ts.isStringLiteral(c.expression) || ts.isNoSubstitutionTemplateLiteral(c.expression)));
      const dynKids = exprKids.filter((c) => !stringExprKids.includes(c));
      const parts = it.建議.split(PH);
      if (kids.every((c) => ts.isJsxText(c) || stringExprKids.includes(c)) && parts.length === 1) {
        // 純文字（含 {"字串"} 表達式）：整段子節點換成一段文字；保留首尾的換行縮排
        const first = kids[0];
        const last = kids[kids.length - 1];
        const s = first.getStart(sf);
        const e = last.getEnd();
        const lead = (src.slice(hit.openingElement.getEnd(), s).match(/^\s*/) || [""])[0];
        const needsBrace = /[{}<>]/.test(it.建議);
        edits.push({ start: s, end: e, text: needsBrace ? `{${JSON.stringify(it.建議)}}` : it.建議 });
        void lead;
        report.auto.push({ ...it, nowLine });
      } else if (dynKids.length === parts.length - 1 && kids.every((c) => ts.isJsxText(c) || ts.isJsxExpression(c))) {
        // 文字＋變數交錯：重排成 文字0 {expr0} 文字1 …（原本的 {"字串"} 表達式併進文字）
        let out = "";
        parts.forEach((p, i) => {
          out += /[{}<>]/.test(p) ? `{${JSON.stringify(p)}}` : p;
          if (i < dynKids.length) out += dynKids[i].getText(sf);
        });
        const s = kids[0].getStart(sf);
        const e = kids[kids.length - 1].getEnd();
        edits.push({ start: s, end: e, text: out });
        report.auto.push({ ...it, nowLine });
      } else {
        report.manual.push({ ...it, nowLine, why: "JSX 子節點有巢狀元素或變數對不上，手動改" });
      }
    } else {
      report.manual.push({ ...it, nowLine, why: "節點型別沒處理" });
    }
  }

  if (edits.length && WRITE) {
    edits.sort((a, b) => b.start - a.start);
    let out = src;
    for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
    fs.writeFileSync(abs, out, "utf8");
    filesTouched++;
  } else if (edits.length) filesTouched++;
}

// 報告
let md = `# 文案套用報告（${WRITE ? "已寫入" : "乾跑"}）\n\n`;
md += `自動套用 ${report.auto.length} 處（${filesTouched} 個檔）；要手動 ${report.manual.length} 處；找不到 ${report.notFound.length} 處。\n\n`;
if (report.manual.length) {
  md += `## 要手動改\n\n| 檔 | 行 | 原文 | 建議 | 原因 |\n|---|---|---|---|---|\n`;
  for (const m of report.manual) md += `| ${m.file} | ${m.nowLine ?? m.line} | ${m.原文.replace(/\|/g, "\\|")} | ${(m.建議 || "（刪掉）").replace(/\|/g, "\\|")} | ${m.why} |\n`;
  md += `\n`;
}
if (report.notFound.length) {
  md += `## 找不到\n\n| 檔 | 行 | 原文 | 原因 |\n|---|---|---|---|\n`;
  for (const m of report.notFound) md += `| ${m.file} | ${m.line} | ${m.原文.replace(/\|/g, "\\|")} | ${m.why} |\n`;
  md += `\n`;
}
fs.mkdirSync("docs/research/文案潤飾-raw", { recursive: true });
fs.writeFileSync("docs/research/文案潤飾-raw/_apply-report.md", md, "utf8");
console.log(`${WRITE ? "WROTE" : "DRY"} auto=${report.auto.length} files=${filesTouched} manual=${report.manual.length} notFound=${report.notFound.length}`);
