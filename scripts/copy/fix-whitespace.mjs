// 磨光④（第二段修補）：apply-copy 用「去頭尾空白的建議」換掉了原本帶頭尾空白的字串（例如 " 則手記" → "則筆記"），
// 把 HEAD 版與現在版的字串節點依出現順序配對，把原本的頭尾空白補回去。只報告或 --write。
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";

const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const ROOT = process.cwd();
const ts = createRequire(import.meta.url)(path.join(ROOT, "node_modules", "typescript"));

const changed = execSync("git diff --name-only HEAD -- src", { encoding: "utf8" }).split("\n").filter((f) => /\.(ts|tsx)$/.test(f));
const parse = (name, src) => ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true, name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
function literals(sf) {
  const out = [];
  (function walk(n) {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push({ kind: "lit", node: n, text: n.text });
    else if (ts.isTemplateExpression(n)) {
      out.push({ kind: "head", node: n.head, text: n.head.text });
      for (const sp of n.templateSpans) out.push({ kind: ts.isTemplateTail(sp.literal) ? "tail" : "mid", node: sp.literal, text: sp.literal.text });
    }
    ts.forEachChild(n, walk);
  })(sf);
  return out;
}
let fixedTotal = 0;
const skipped = [];
for (const file of changed) {
  const cur = fs.readFileSync(file, "utf8");
  let head;
  try {
    head = execSync(`git show HEAD:"${file}"`, { encoding: "utf8" });
  } catch {
    continue;
  }
  const a = literals(parse(file, head));
  const b = literals(parse(file, cur));
  if (a.length !== b.length) {
    skipped.push(`${file}（HEAD ${a.length} 個、現在 ${b.length} 個字串節點，數量不同，請手查）`);
    continue;
  }
  const edits = [];
  for (let i = 0; i < a.length; i++) {
    const o = a[i].text;
    const n = b[i].text;
    if (o === n) continue;
    const lead = (o.match(/^\s+/) || [""])[0];
    const trail = (o.match(/\s+$/) || [""])[0];
    if (!lead && !trail) continue;
    const nLead = (n.match(/^\s+/) || [""])[0];
    const nTrail = (n.match(/\s+$/) || [""])[0];
    if (nLead === lead && nTrail === trail) continue;
    const fixed = lead + n.replace(/^\s+/, "").replace(/\s+$/, "") + trail;
    // 節點原始碼範圍：字串字面值去掉引號；樣板各段去掉 ` / ${ / }
    const node = b[i].node;
    const raw = node.getText();
    let start = node.getStart();
    let end = node.getEnd();
    if (b[i].kind === "lit") {
      start += 1;
      end -= 1;
    } else if (b[i].kind === "head") {
      start += 1;
      end -= 2;
    } else if (b[i].kind === "mid") {
      start += 1;
      end -= 2;
    } else {
      start += 1;
      end -= 1;
    }
    const q = raw[0];
    const esc = (t) => (q === "`" ? t.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${") : t.replace(/\\/g, "\\\\").replace(new RegExp(q, "g"), "\\" + q));
    edits.push({ start, end, text: esc(fixed), from: n, to: fixed });
  }
  if (!edits.length) continue;
  edits.sort((x, y) => y.start - x.start);
  let out = cur;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  if (WRITE) fs.writeFileSync(file, out, "utf8");
  fixedTotal += edits.length;
  console.log(`${file}: ${edits.length} 處`);
  for (const e of edits.slice().reverse()) console.log(`   ${JSON.stringify(e.from)} → ${JSON.stringify(e.to)}`);
}
console.log(`${WRITE ? "WROTE" : "DRY"} 補空白 ${fixedTotal} 處；跳過 ${skipped.length} 檔`);
for (const s of skipped) console.log("  ", s);
