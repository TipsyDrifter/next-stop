// 磨光④ 文案班：掃 src/**/*.ts(x)，抽出所有含中文（含日文假名）的字串字面值與 JSX 文字。
// 用法：node scripts/copy/extract-strings.mjs [--ts <typescript 套件路徑>] [--out <json>] [--md <markdown>]
// 排除：console.*、註解（AST 本來就不會抽到）、測試、mock 種子資料（src/data/）、dev 工具（src/ui/dev/）、CSS。
// 不改任何 src/ 檔。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const ROOT = process.cwd();
const TS_PATH = opt("--ts", path.join(ROOT, "node_modules", "typescript"));
const OUT_JSON = opt("--out", "docs/research/2026-10-20-文案-字串清單.json");
const OUT_MD = opt("--md", "docs/research/2026-10-20-文案-字串清單.md");

const require = createRequire(import.meta.url);
const ts = require(TS_PATH);

const CJK = /[぀-ヿ㐀-䶿一-鿿]/;
const EXCLUDE_DIRS = ["src/data", "src/ui/dev"];
const EXCLUDE_FILE = /(\.test\.|__tests__|\.d\.ts$|mock|seed|fixture)/i;

// 畫面：照路徑猜
const SCREEN_BY_DIR = [
  ["src/ui/today", "今日視圖"],
  ["src/ui/outline", "路線圖"],
  ["src/ui/calendar", "行程表"],
  ["src/ui/schedule", "行程表（手機串流）"],
  ["src/ui/notes", "旅客筆記"],
  ["src/ui/timetable", "時刻表"],
  ["src/ui/ticket", "售票口"],
  ["src/ui/settings", "設定"],
  ["src/ui/mobile", "手機殼"],
  ["src/ui/panel", "詳情側板"],
  ["src/ui/sidebar", "側欄"],
  ["src/ui/shell", "殼層／快捷鍵"],
  ["src/ui/complete", "完成卡"],
  ["src/ui/stamps", "印章"],
  ["src/ui/common", "共用元件"],
  ["src/ui/ambience", "氛圍"],
  ["src/lines", "各線登記檔"],
  ["src/domain", "邏輯層文字"],
  ["src/store", "狀態層文字"],
  ["src/lib", "共用函式"],
  ["src/ui", "UI 其他"],
  ["src", "其他"],
];
function screenOf(file) {
  for (const [d, s] of SCREEN_BY_DIR) if (file.startsWith(d + "/")) return s;
  return "其他";
}

const INLINE_TAGS = new Set(["span", "strong", "em", "b", "i", "kbd", "code", "small", "u", "s", "sup", "sub", "mark", "br"]);
const HINT_CLASS = /(ns-note|hint|desc|muted|help|caption|text-ink-soft|ns-sub|techo-sub|ns-tt-sub|ns-bk-when|explain|ns-help)/;
const ERR_CLASS = /(err|error|fail|warn|danger)/;
const EMPTY_CLASS = /(empty|blank)/;
const TITLE_CLASS = /(techo-label|title|heading|ns-h\d|ns-bk-h|section-title)/;

function listFiles(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const rel = path.relative(ROOT, p).replace(/\\/g, "/");
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.some((d) => rel === d || rel.startsWith(d + "/"))) continue;
      listFiles(p, acc);
    } else if (/\.(ts|tsx)$/.test(e.name) && !EXCLUDE_FILE.test(rel)) acc.push(rel);
  }
  return acc;
}

const records = [];
let nextId = 1;
const consumed = new Set(); // 已被 JSX 元素整段吃掉的子節點

function lineOf(sf, node) {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function enclosingComponent(node) {
  let n = node;
  while (n) {
    if (ts.isFunctionDeclaration(n) && n.name) return n.name.text;
    if (ts.isMethodDeclaration(n) && n.name) return n.name.getText();
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n.parent) {
      if (ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name)) return n.parent.name.text;
      if (ts.isPropertyAssignment(n.parent)) return n.parent.name.getText();
    }
    n = n.parent;
  }
  return "";
}

function enclosingConst(node) {
  // 模組層常數（例如 JOIN_CHOICE_TEXT.adoptLabel）
  const parts = [];
  let n = node;
  while (n) {
    if (ts.isPropertyAssignment(n)) parts.unshift(n.name.getText());
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
      parts.unshift(n.name.text);
      break;
    }
    if (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
      // 函式裡面的常數不算模組層
      if (parts.length) return parts.join(".");
    }
    n = n.parent;
  }
  return parts.join(".");
}

function isInConsole(node) {
  let n = node;
  while (n) {
    if (ts.isCallExpression(n)) {
      const t = n.expression.getText();
      if (/^console\./.test(t) || /^(log|debug|warn|error|trace)\(/.test(t + "(")) return true;
    }
    n = n.parent;
  }
  return false;
}

function callContext(node) {
  // 最近的呼叫名 + 物件屬性名
  let prop = "";
  let call = "";
  let n = node;
  while (n && !call) {
    if (!prop && ts.isPropertyAssignment(n)) prop = n.name.getText();
    if (ts.isCallExpression(n)) call = n.expression.getText().split("\n")[0].slice(0, 60);
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) break;
    n = n.parent;
  }
  return { prop, call };
}

function roleFromProp(prop) {
  if (!prop) return "";
  if (/^(title|heading|header)$/i.test(prop)) return "標題";
  if (/^(body|description|desc|hint|help|sub|note|detail|explain|summary|caption|tip)$/i.test(prop)) return "說明小字";
  if (/label$/i.test(prop) || /^(label|confirm|cancel|action|ok|button|btn)$/i.test(prop)) return "按鈕／標籤";
  if (/placeholder/i.test(prop)) return "placeholder";
  if (/empty/i.test(prop)) return "空狀態";
  if (/^(message|msg|toast)$/i.test(prop)) return "toast";
  if (/^(name|short|glyph|abbr)$/i.test(prop)) return "名稱";
  if (/^(error|err)$/i.test(prop)) return "錯誤訊息";
  return "";
}

function roleFromCall(call) {
  if (!call) return "";
  if (/toast|notify|notice/i.test(call)) return "toast";
  if (/confirm|ask|alert|dialog/i.test(call)) return "確認框";
  if (/setError|Error\(/.test(call)) return "錯誤訊息";
  return "";
}

function tagName(el) {
  const open = ts.isJsxElement(el) ? el.openingElement : el;
  return open.tagName.getText();
}
function classOf(el) {
  const open = ts.isJsxElement(el) ? el.openingElement : el;
  for (const a of open.attributes.properties) {
    if (ts.isJsxAttribute(a) && a.name.getText() === "className" && a.initializer) return a.initializer.getText();
  }
  return "";
}

function roleFromJsx(el) {
  const tag = tagName(el);
  const cls = classOf(el);
  if (tag === "button" || /ns-btn|btn-/.test(cls)) return "按鈕";
  if (/^h[1-6]$/.test(tag) || tag === "legend" || TITLE_CLASS.test(cls)) return "標題";
  if (tag === "option") return "選項";
  if (tag === "label") return "欄位標籤";
  if (ERR_CLASS.test(cls)) return "錯誤訊息";
  if (EMPTY_CLASS.test(cls)) return "空狀態";
  if (HINT_CLASS.test(cls) || tag === "small") return "說明小字";
  if (tag === "p") return "段落";
  if (tag === "li") return "列表項";
  if (tag === "kbd" || tag === "code") return "鍵帽／代碼";
  return "文字";
}

// 把 JSX 元素的子節點攤成一段文字（表達式用 {…}、字串表達式直接展開、行內子元素展開）
function renderJsxChildren(el, sf, depth = 0) {
  if (!ts.isJsxElement(el)) return "";
  let out = "";
  for (const c of el.children) {
    if (ts.isJsxText(c)) {
      out += c.getText(sf).replace(/\s*\n\s*/g, "").replace(/\s+/g, " ");
    } else if (ts.isJsxExpression(c)) {
      const e = c.expression;
      if (!e) continue; // 純註解 {/* … */}
      if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
        out += e.text;
        consumed.add(e);
      } else if (ts.isTemplateExpression(e)) {
        out += renderTemplate(e);
        consumed.add(e);
      } else out += "{…}";
    } else if (ts.isJsxElement(c) && INLINE_TAGS.has(tagName(c)) && depth < 3) {
      const inner = renderJsxChildren(c, sf, depth + 1);
      out += inner;
      consumed.add(c);
    } else if (ts.isJsxSelfClosingElement(c) && tagName(c) === "br") out += "⏎";
    else out += "{…}";
  }
  return out.trim();
}

function renderTemplate(t) {
  let s = t.head.text;
  for (const sp of t.templateSpans) s += "{…}" + sp.literal.text;
  return s;
}

function push(file, sf, node, text, role, extra) {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t || !CJK.test(t)) return;
  records.push({
    id: nextId++,
    file,
    line: lineOf(sf, node),
    screen: screenOf(file),
    component: enclosingComponent(node),
    const: enclosingConst(node),
    role,
    text: t,
    ...extra,
  });
}

function visit(node, sf, file) {
  if (consumed.has(node)) return;

  // JSX 元素：有含中文的 JsxText 子節點，整段抽
  if (ts.isJsxElement(node)) {
    const hasCjkText = node.children.some((c) => ts.isJsxText(c) && CJK.test(c.getText(sf)));
    if (hasCjkText) {
      const text = renderJsxChildren(node, sf);
      push(file, sf, node, text, roleFromJsx(node), { kind: "jsx", tag: tagName(node) });
      // 子節點裡的 JsxText 已消耗；其餘表達式照常往下走（屬性、巢狀非行內元素）
      for (const c of node.children) if (!ts.isJsxText(c)) visit(c, sf, file);
      node.openingElement.attributes.properties.forEach((a) => visit(a, sf, file));
      return;
    }
  }

  // JSX 屬性字串
  if (ts.isJsxAttribute(node) && node.initializer) {
    const name = node.name.getText();
    const init = node.initializer;
    let text = null;
    let inner = null;
    if (ts.isStringLiteral(init)) {
      text = init.text;
      inner = init;
    } else if (ts.isJsxExpression(init) && init.expression) {
      const e = init.expression;
      if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
        text = e.text;
        inner = e;
      } else if (ts.isTemplateExpression(e)) {
        text = renderTemplate(e);
        inner = e;
      }
    }
    if (text != null && CJK.test(text) && name !== "className") {
      const role =
        name === "title" ? "tooltip" : name === "placeholder" ? "placeholder" : /^aria-/.test(name) ? "無障礙標籤" : name === "alt" ? "圖片替代文字" : `屬性 ${name}`;
      const parentEl = node.parent.parent; // JsxAttributes -> opening/selfclosing
      push(file, sf, inner, text, role, { kind: "attr", attr: name, tag: parentEl && parentEl.tagName ? parentEl.tagName.getText() : "" });
      consumed.add(inner);
    }
    if (text == null) ts.forEachChild(node, (c) => visit(c, sf, file));
    return;
  }

  // 一般字串字面值 / 樣板字串
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
    const text = ts.isTemplateExpression(node) ? renderTemplate(node) : node.text;
    if (CJK.test(text)) {
      const p = node.parent;
      // 排除：import、物件鍵、型別字面值、console
      if (ts.isImportDeclaration(p) || ts.isExternalModuleReference(p)) return;
      if (ts.isPropertyAssignment(p) && p.name === node) return;
      if (ts.isLiteralTypeNode(p)) return;
      if (isInConsole(node)) return;
      const { prop, call } = callContext(node);
      let role = roleFromProp(prop) || roleFromCall(call);
      let kind = "str";
      if (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(p.operatorToken.kind)) {
        role = "比較值（資料，非文案）";
        kind = "cmp";
      } else if (ts.isCaseClause(p)) {
        role = "case 值（資料，非文案）";
        kind = "cmp";
      } else if (ts.isJsxExpression(p)) {
        const el = p.parent;
        role = ts.isJsxElement(el) ? roleFromJsx(el) : "文字";
        kind = "jsx-expr";
      }
      if (!role) role = ts.isTemplateExpression(node) ? "組合句" : "字串";
      push(file, sf, node, text, role, { kind, prop, call });
    }
    return;
  }

  ts.forEachChild(node, (c) => visit(c, sf, file));
}

const files = listFiles(path.join(ROOT, "src"));
for (const rel of files) {
  const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
  const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  visit(sf, sf, rel);
}

// 統計
const byRole = {};
for (const r of records) byRole[r.role] = (byRole[r.role] || 0) + 1;
const byScreen = {};
for (const r of records) byScreen[r.screen] = (byScreen[r.screen] || 0) + 1;
const uniqueTexts = new Set(records.map((r) => r.text)).size;

fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
fs.writeFileSync(OUT_JSON, JSON.stringify({ generated: new Date().toISOString(), files: files.length, total: records.length, unique: uniqueTexts, byRole, byScreen, records }, null, 1), "utf8");

// Markdown
let md = `# 文案字串清單（磨光④・自動抽取）\n\n`;
md += `> 由 \`scripts/copy/extract-strings.mjs\` 掃 \`src/**/*.ts(x)\` 產生，${new Date().toISOString().slice(0, 16).replace("T", " ")}。排除 console、註解、測試、mock 種子（\`src/data/\`）、dev 工具（\`src/ui/dev/\`）、CSS。\n`;
md += `> 同一份資料的 JSON 在 \`${path.basename(OUT_JSON)}\`（第二段套用用）。\n\n`;
md += `**總數**：${records.length} 條（去重後 ${uniqueTexts} 句），掃了 ${files.length} 個檔。\n\n`;
md += `## 依畫面\n\n| 畫面 | 條數 |\n|---|---|\n`;
for (const [k, v] of Object.entries(byScreen).sort((a, b) => b[1] - a[1])) md += `| ${k} | ${v} |\n`;
md += `\n## 依角色\n\n| 角色 | 條數 |\n|---|---|\n`;
for (const [k, v] of Object.entries(byRole).sort((a, b) => b[1] - a[1])) md += `| ${k} | ${v} |\n`;
md += `\n## 明細（依檔案）\n\n`;
let curFile = "";
for (const r of records) {
  if (r.file !== curFile) {
    curFile = r.file;
    md += `\n### ${r.file}（${r.screen}）\n\n| # | 行 | 元件 | 角色 | 原文 |\n|---|---|---|---|---|\n`;
  }
  const where = r.component || r.const || "";
  md += `| ${r.id} | ${r.line} | ${where} | ${r.role} | ${r.text.replace(/\|/g, "\\|")} |\n`;
}
fs.writeFileSync(OUT_MD, md, "utf8");

console.log(`files=${files.length} records=${records.length} unique=${uniqueTexts}`);
console.log("byRole", byRole);
console.log("byScreen", byScreen);
