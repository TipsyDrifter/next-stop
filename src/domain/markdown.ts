/**
 * 📝 旅客筆記・Markdown 解析（車次④「筆記掛樹・Markdown」；契約 §4.1／§4.2、§0-0 的 P1／P3／P6／P7／P8）
 *
 * 規格：docs/research/2026-10-15-旅客筆記-車次④掛樹Markdown-契約.md
 * 行為對照：prototypes/旅客筆記-掛樹Markdown-src/md.js（`smoke.mjs` 21 項）——規則以契約 §0-0 為準，原型的寫法逐字移植
 *
 * 這支只做「字串 → AST」，不產 HTML：畫面由 React 畫 AST（`MdBody`／`MobileMdBody`），整條線不用 `dangerouslySetInnerHTML`。
 * 行內切段（荷札／行內程式碼／網址）由呼叫端傳進來的 `split`（＝③ 的 `inlineSegments`）做，所以荷札的判定與存檔時一致
 * （`**粗**#標籤` 的 `#標籤` 不是小牌，與 ③ 的 `parseTags` 同一份規則）。
 *
 * 寫法限制：
 *   - 零 import（只有 `import type`，執行期剝掉）——`scripts/tests/markdown.test.ts` 用 node 直接載入本檔
 *   - 只用可剝除語法：不用 enum／namespace／參數屬性
 *
 * 規則摘要：
 *   - 標題：行首 `#`×1–6 ＋ 空白；層級＝min(井號數, 3)。`#標題`（無空白）是荷札、不是標題（0-9）
 *   - 清單：符號後要有空白（`１．一`、`3、4 月…` 不算有序，P8）；縮排每 2 格一層、最多 3 層；縮進一次跳兩層以上只深一層；
 *     同一層有序／無序混用 ⇒ 結束這個清單、另開兄弟清單（P7）；有序清單記第一項的號碼 `start`（P6）
 *   - 連結只放行 http／https（`isSafeHref`），其他 scheme 與相對路徑一律當純文字
 */
import type { InlineSegment } from "./tags";

/* ═══ 型別（契約 §4.1） ═══ */

export type MdInline =
  | InlineSegment // text／tag／code／url（③ 既有）
  | { kind: "strong"; children: MdInline[] }
  | { kind: "em"; children: MdInline[] }
  | { kind: "link"; text: string; href: string }; // [text](href)；href 經 isSafeHref 否則整段退成 text

export interface MdListItem {
  inline: MdInline[];
  /** 只會是 list（巢狀）；深度 ≤ 3 */
  children: MdBlock[];
}

export type MdListBlock = {
  type: "list";
  ordered: boolean;
  /** 有序清單第一項的號碼（全形數字已轉半形；畫 `<ol start>`）；無序＝1（P6） */
  start: number;
  items: MdListItem[];
};

export type MdBlock =
  | { type: "heading"; level: 1 | 2 | 3; inline: MdInline[] }
  | { type: "paragraph"; lines: MdInline[][] } // 段內一行一個陣列（畫 <br>，與 plainParagraphs 同口徑）
  | MdListBlock
  | { type: "quote"; lines: MdInline[][] }
  | { type: "code"; text: string; lang: string | null } // 圍欄；text 原樣、不切段
  | { type: "hr" };

/** 一行字 → text／tag／code／url 段；正式 App 傳 `inlineSegments`（`tags.ts`） */
export type InlineSplitter = (line: string) => InlineSegment[];

/* ═══ 安全 ═══ */

/** 連結只放行 http／https（主對話放行條件 4；`mailto:`／`javascript:`／`file:`／`data:`／相對路徑都不放行） */
export function isSafeHref(href: string): boolean {
  return /^https?:\/\//i.test(String(href || ""));
}

/**
 * 裸網址段（`url` kind）可以拿去當 `<a href>` 的字：http(s) 照用；`www.` 開頭補 `https://`（③ 的 URL_SRC 認得 www.）；
 * 其餘＝null（畫成純文字）。`link` 段的 `href` 已經過 `isSafeHref`，不必再包。
 */
export function urlSegHref(text: string): string | null {
  const t = String(text || "");
  if (isSafeHref(t)) return t;
  if (/^www\./i.test(t)) return "https://" + t;
  return null;
}

/* ═══ 行內（§4.2 parseInline；P1 跨段合併連結） ═══ */

/** **x** → strong、*x* → em；x 首尾不是空白；`***x***`＝strong 含 em；不配對的星號原樣；strong 裡可含 em、不再深 */
function emph(text: string, allowStrong: boolean): MdInline[] {
  const out: MdInline[] = [];
  let buf = "";
  const flush = (): void => {
    if (buf) {
      out.push({ kind: "text", text: buf });
      buf = "";
    }
  };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    let m: RegExpExecArray | null;
    if (allowStrong && (m = /^\*\*\*(?=\S)([^*]*?\S)\*\*\*/.exec(rest))) {
      flush();
      out.push({ kind: "strong", children: [{ kind: "em", children: [{ kind: "text", text: m[1] }] }] });
      i += m[0].length;
      continue;
    }
    if (allowStrong && (m = /^\*\*(?=\S)([\s\S]*?\S)\*\*/.exec(rest)) && m[1].indexOf("**") < 0) {
      flush();
      out.push({ kind: "strong", children: emph(m[1], false) });
      i += m[0].length;
      continue;
    }
    if ((m = /^\*(?=[^\s*])([^*]*?[^\s*])\*(?!\*)/.exec(rest)) || (m = /^\*([^\s*])\*(?!\*)/.exec(rest))) {
      flush();
      out.push({ kind: "em", children: [{ kind: "text", text: m[1] }] });
      i += m[0].length;
      continue;
    }
    buf += text.charAt(i);
    i++;
  }
  flush();
  return out;
}

const LINK_HEAD = /\[([^\[\]\n]+)\]\($/;

/** text 段裡的完整連結 `[字](網址)`（網址沒被 URL_SRC 切走時用；放行的 scheme 只有 http／https，所以實際上少見，留作保險） */
function textWithLinks(text: string): MdInline[] {
  let out: MdInline[] = [];
  const re = /\[([^\[\]\n]+)\]\(([^)\s]+)\)/g;
  let pos = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (!isSafeHref(m[2])) continue;
    if (m.index > pos) out = out.concat(emph(text.slice(pos, m.index), true));
    out.push({ kind: "link", text: m[1], href: m[2] });
    pos = m.index + m[0].length;
  }
  if (pos < text.length) out = out.concat(emph(text.slice(pos), true));
  return out;
}

/**
 * 只對 `text` 段做 `[文字](網址)`／`**粗**`／`*斜*`；`tag`／`code`／`url` 段原樣穿過
 * （它們在 `split` 已切好，所以 `` `**x**` `` 不會變粗、`#a/b` 不會被 `*` 吃掉）。
 *
 * P1：`inlineSegments` 先把網址切成 `url` 段，所以連結要跨段合併——`text` 段尾是 `[文字](`、下一段是 `url`、再下一段以 `)` 開頭
 * ⇒ 一個 `link`；`url` 段裡若含 `)`（網址把後面的中文一起吃掉時），從第一個 `)` 切開，後面的字退回文字。
 */
export function parseInline(input: readonly InlineSegment[]): MdInline[] {
  const segs: InlineSegment[] = input.slice();
  let out: MdInline[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const nextSeg = segs[i + 1];
    if (s.kind === "text" && nextSeg && nextSeg.kind === "url" && LINK_HEAD.test(s.text)) {
      const u = nextSeg.text;
      const nx = segs[i + 2];
      const cut = u.indexOf(")");
      let href: string | null = null;
      let after: string | null = null;
      if (cut > 0) {
        href = u.slice(0, cut);
        after = u.slice(cut + 1);
      } else if (nx && nx.kind === "text" && nx.text.charAt(0) === ")") {
        href = u;
        after = null;
      }
      // 與裸網址同一個口徑（評審 nice）：`[字](www.x.com)` 補 https://；其他 scheme 仍不放行
      const safe = href ? urlSegHref(href) : null;
      if (safe) {
        const hm = LINK_HEAD.exec(s.text) as RegExpExecArray;
        out = out.concat(textWithLinks(s.text.slice(0, hm.index)));
        out.push({ kind: "link", text: hm[1], href: safe });
        if (after !== null) {
          if (after) segs.splice(i + 2, 0, { kind: "text", text: after });
          i += 1;
        } else if (nx && nx.kind === "text") {
          segs[i + 2] = { kind: "text", text: nx.text.slice(1) };
          i += 1;
        }
        continue;
      }
    }
    if (s.kind === "text") out = out.concat(textWithLinks(s.text));
    else out.push(s);
  }
  return out.filter((x) => !(x.kind === "text" && !x.text));
}

/* ═══ 區塊（§4.2 parseMarkdown） ═══ */

const RE_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const RE_FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;
/** 標題：`#`×1–6（P3）；層級取 min(井號數, 3) */
const RE_HEAD = /^(#{1,6})[ \t　]+(.*)$/;
const RE_HR = /^[-*_]{3,}\s*$/;
const RE_QUOTE = /^>[ \t]?(.*)$/;
// 條列符號與 notes.ts:200-202 同字集
const RE_BULLET_SPACED = /^[-*+－＊][ \t　]+/;
const RE_BULLET_GLYPH = /^[・•‧·∙●○◦▪■□][ \t　]*/;
/** 有序：符號後一定要有空白（P8：`１．一`、`3、4 月…` 不算） */
const RE_ORDERED = /^([0-9０-９]{1,3})[.．、)）][ \t　]+/;

/** 前導空白寬度：空白 1、Tab 2、全形空白 2 */
function indentOf(line: string): number {
  let w = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line.charAt(i);
    if (c === " ") w += 1;
    else if (c === "\t" || c === "　") w += 2;
    else break;
  }
  return w;
}

/** 「１２」→ 12 */
function toInt(s: string): number {
  const half = s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  return parseInt(half, 10) || 1;
}

interface ListFrame {
  /** 這一層的深度（0 起算；最多 2＝三層） */
  d: number;
  list: MdListBlock;
  /** 這個清單掛在哪個項目底下（根＝null） */
  holder: MdListItem | null;
}
interface ListState {
  root: MdListBlock;
  /** 第一項的縮排寬度（之後的深淺都相對它算） */
  base: number;
  stack: ListFrame[];
}

/**
 * 整份內文 → 區塊。先 `\r\n`→`\n`；逐行：圍欄 → 空行 → 標題 → hr → 引用 → 條列 → 段落。
 * 行內一律 `split(line)` 再 `parseInline`；圍欄裡的行原樣進 `code.text`、不切段。
 */
export function parseMarkdown(body: string, split: InlineSplitter): MdBlock[] {
  const lines = String(body || "").replace(/\r\n?/g, "\n").split("\n");
  const inl = (line: string): MdInline[] => parseInline(split(line));
  /**
   * 區塊符號（`>`、`・` 等）被剝掉後再切段，`#` 會變成「行首」而被認成荷札；但 ③ 的存檔判定（`parseTags`）看的是整行原字，
   * 前一字是符號、不在 PRE_OK ⇒ 不算荷札。所以把符號一起餵給 `split`，切完再把第一個 text 段的符號砍掉
   * （符號裡沒有 `#`、反引號、網址字元，段界不會動），讓閱讀態的小牌與存檔判定看同一份字。
   */
  const inlWith = (prefix: string, text: string): MdInline[] => {
    if (!prefix) return inl(text);
    const segs = split(prefix + text);
    const first = segs[0];
    if (!first || first.kind !== "text" || first.text.indexOf(prefix) !== 0) return inl(text);
    const n = prefix.length;
    const shifted: InlineSegment[] = [];
    for (let k = 0; k < segs.length; k++) {
      const sg = segs[k];
      if (k === 0) {
        const rest = (sg as { text: string }).text.slice(n);
        if (rest) shifted.push({ kind: "text", text: rest });
      } else if (sg.kind === "tag") {
        shifted.push({ kind: "tag", occ: { ...sg.occ, start: sg.occ.start - n, end: sg.occ.end - n } });
      } else shifted.push(sg);
    }
    return parseInline(shifted);
  };
  const blocks: MdBlock[] = [];
  let para: string[] | null = null;
  let quote: [string, string][] | null = null; // [被剝掉的 `>` 與一格空白, 內文]
  let lst: ListState | null = null;

  const flushPara = (): void => {
    if (para) {
      blocks.push({ type: "paragraph", lines: para.map(inl) });
      para = null;
    }
  };
  const flushQuote = (): void => {
    if (quote) {
      blocks.push({ type: "quote", lines: quote.map((q) => inlWith(q[0], q[1])) });
      quote = null;
    }
  };
  const flushList = (): void => {
    if (lst) {
      blocks.push(lst.root);
      lst = null;
    }
  };
  const flushAll = (): void => {
    flushPara();
    flushQuote();
    flushList();
  };
  const newList = (ordered: boolean, start: number, item: MdListItem): MdListBlock => ({
    type: "list",
    ordered,
    start: ordered ? start : 1,
    items: [item],
  });

  /** rel＝這一行的縮排寬度；num＝有序項的號碼（無序＝1） */
  const addItem = (rel: number, ordered: boolean, num: number, text: string, prefix: string): void => {
    const item: MdListItem = { inline: inlWith(prefix, text), children: [] };
    if (!lst) {
      const root = newList(ordered, num, item);
      lst = { root, base: rel, stack: [{ d: 0, list: root, holder: null }] };
      return;
    }
    const st = lst.stack;
    // 每 2 格一層、最多 3 層（d 0..2）；比上一列深＝子清單，淺＝回上層
    const d = Math.max(0, Math.min(2, Math.floor((rel - lst.base) / 2)));
    // 回淺：框記的是「這一行實際縮多深」（見下 push），所以只在「再下一層的框也夠淺」時才彈——
    // 跳兩層開的子清單（d=2）之後來一行 d=1，仍留在那個子清單，不另開第二個
    while (st.length > 1 && st[st.length - 1].d > d && st[st.length - 2].d >= d) st.pop();
    let top = st[st.length - 1];
    if (d > top.d && top.list.items.length) {
      // P7：一次跳兩層以上也只深一層
      const holder = top.list.items[top.list.items.length - 1];
      const child = newList(ordered, num, item);
      child.items = [];
      holder.children.push(child);
      // 框的深度記這一行實際的 d（不是 top.d + 1）：4 格縮排的同層下一行 d 仍是 2，才會進同一個清單而不是疊成樓梯
      st.push({ d, list: child, holder });
      top = st[st.length - 1];
    }
    if (top.list.ordered !== ordered) {
      // P7：同一層有序／無序混用 ⇒ 結束這個清單、另開兄弟清單
      const sib = newList(ordered, num, item);
      sib.items = [];
      if (!top.holder) {
        flushList();
        lst = { root: sib, base: rel, stack: [{ d: 0, list: sib, holder: null }] };
        top = lst.stack[0];
      } else {
        top.holder.children.push(sib);
        top.list = sib;
      }
    }
    top.list.items.push(item);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;

    // 圍欄：收到同種類、長度 ≥ 開欄的那一行為止（沒收到＝到檔尾）；中間原樣
    if ((m = RE_FENCE.exec(line))) {
      flushAll();
      const mark = m[1];
      const lang = m[2].trim() || null;
      const buf: string[] = [];
      for (i = i + 1; i < lines.length; i++) {
        const fm = RE_FENCE_CLOSE.exec(lines[i]);
        if (fm && fm[1].charAt(0) === mark.charAt(0) && fm[1].length >= mark.length) break;
        buf.push(lines[i]);
      }
      blocks.push({ type: "code", text: buf.join("\n"), lang });
      continue;
    }

    const t = line.replace(/[ \t　]+$/, "");
    if (!t.replace(/^[ \t　]+/, "")) {
      flushAll();
      continue;
    }
    if ((m = RE_HEAD.exec(t))) {
      flushAll();
      blocks.push({ type: "heading", level: Math.min(3, m[1].length) as 1 | 2 | 3, inline: inl(m[2]) });
      continue;
    }
    if (RE_HR.test(t)) {
      flushAll();
      blocks.push({ type: "hr" });
      continue;
    }
    if ((m = RE_QUOTE.exec(t))) {
      flushPara();
      flushList();
      (quote = quote || []).push([t.slice(0, t.length - m[1].length), m[1]]);
      continue;
    }
    const s = t.replace(/^[ \t　]+/, "");
    const ind = indentOf(t);
    if (RE_BULLET_SPACED.test(s) || RE_BULLET_GLYPH.test(s)) {
      flushPara();
      flushQuote();
      const body = s.replace(RE_BULLET_SPACED, "").replace(RE_BULLET_GLYPH, "");
      addItem(ind, false, 1, body, s.slice(0, s.length - body.length));
      continue;
    }
    if ((m = RE_ORDERED.exec(s))) {
      flushPara();
      flushQuote();
      addItem(ind, true, toInt(m[1]), s.slice(m[0].length), "");
      continue;
    }
    flushList();
    flushQuote();
    (para = para || []).push(s);
  }
  flushAll();
  return blocks;
}

/* ═══ 純文字（測試與摘要用） ═══ */

/** 行內片段的純文字：tag＝`#原字`、code＝去反引號、url／link＝字面、strong／em＝子節點 */
export function inlinePlainText(nodes: readonly MdInline[]): string {
  let s = "";
  for (const n of nodes) {
    switch (n.kind) {
      case "text":
      case "url":
        s += n.text;
        break;
      case "code":
        s += n.text.replace(/^(`+)([\s\S]*)\1$/, "$2");
        break;
      case "tag":
        s += "#" + n.occ.raw;
        break;
      case "link":
        s += n.text;
        break;
      case "strong":
      case "em":
        s += inlinePlainText(n.children);
        break;
    }
  }
  return s;
}

/** 標題區塊的純文字；不是標題＝空字串 */
export function headingText(block: MdBlock): string {
  return block.type === "heading" ? inlinePlainText(block.inline) : "";
}

function listPlainLines(b: MdListBlock, depth: number, out: string[]): void {
  let n = b.start;
  for (const it of b.items) {
    out.push("  ".repeat(depth) + (b.ordered ? n++ + ". " : "- ") + inlinePlainText(it.inline));
    for (const c of it.children) if (c.type === "list") listPlainLines(c, depth + 1, out);
  }
}

/** 整份去符號的純文字（區塊以換行相接）。字數統計不用它——字數仍數 `body` */
export function mdPlainText(blocks: readonly MdBlock[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case "heading":
        out.push(inlinePlainText(b.inline));
        break;
      case "paragraph":
      case "quote":
        for (const l of b.lines) out.push(inlinePlainText(l));
        break;
      case "list":
        listPlainLines(b, 0, out);
        break;
      case "code":
        out.push(b.text);
        break;
      case "hr":
        break;
    }
  }
  return out.join("\n");
}
