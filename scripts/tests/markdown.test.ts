// 旅客筆記・Markdown 解析單元測試（車次④契約 §4.4；§0-0 的 P1／P3／P6／P7／P8 與主對話安全條件）
// 跑法：node --test scripts/tests/markdown.test.ts（node 24 直接剝除型別；不進 tsc——tsconfig 只 include src）
//
// 行內切段用真的 `inlineSegments`（tags.ts，零 import、node 可直接載）當 `split`，所以荷札判定與 ③ 存檔一致。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  headingText,
  inlinePlainText,
  isSafeHref,
  mdPlainText,
  parseInline,
  parseMarkdown,
  urlSegHref,
  type MdBlock,
  type MdInline,
} from "../../src/domain/markdown.ts";
import { inlineSegments, parseTags } from "../../src/domain/tags.ts";

const parse = (body: string): MdBlock[] => parseMarkdown(body, inlineSegments);
const inl = (line: string): MdInline[] => parseInline(inlineSegments(line));
const kinds = (xs: MdInline[]): string[] => xs.map((x) => x.kind);
const types = (bs: MdBlock[]): string[] => bs.map((b) => b.type);

/** 清單區塊的簡寫：[文字, 子清單…] 遞迴 */
type Sketch = string | [string, ...Sketch[]];
function sketchList(b: MdBlock): Sketch[] {
  assert.equal(b.type, "list");
  if (b.type !== "list") return [];
  return b.items.map((it) => {
    const t = inlinePlainText(it.inline);
    const kids = it.children.flatMap((c) => sketchList(c));
    return kids.length ? ([t, ...kids] as Sketch) : t;
  });
}

/* ═══ 區塊 ═══ */

test("標題：# ## ### 三級", () => {
  const b = parse("# 一\n## 二\n### 三");
  assert.deepEqual(
    b.map((x) => (x.type === "heading" ? [x.level, headingText(x)] : null)),
    [[1, "一"], [2, "二"], [3, "三"]],
  );
});

test("標題：#### 以上當第三級（P3）", () => {
  const b = parse("#### 四\n###### 六");
  assert.deepEqual(
    b.map((x) => (x.type === "heading" ? x.level : 0)),
    [3, 3],
  );
  // 七個井號不是標題
  assert.deepEqual(types(parse("####### 七")), ["paragraph"]);
});

test("標題：#標題（無空白）不是標題而是荷札；# 今天 #靈感 的 #靈感 是小牌", () => {
  const b = parse("#標題");
  assert.equal(b[0].type, "paragraph");
  if (b[0].type === "paragraph") assert.deepEqual(kinds(b[0].lines[0]), ["tag"]);
  const h = parse("# 今天 #靈感");
  assert.equal(h[0].type, "heading");
  if (h[0].type === "heading") assert.deepEqual(kinds(h[0].inline), ["text", "tag"]);
});

test("無序清單：- * + 三種符號（含全形與圓點）", () => {
  const b = parse("- 甲\n* 乙\n+ 丙\n・丁");
  assert.deepEqual(types(b), ["list"]);
  assert.deepEqual(sketchList(b[0]), ["甲", "乙", "丙", "丁"]);
  assert.equal(b[0].type === "list" && b[0].ordered, false);
});

test("有序清單：半形與全形數字、start 取第一項（P6）", () => {
  const a = parse("1. 一\n2. 二");
  assert.equal(a[0].type === "list" && a[0].ordered, true);
  assert.equal(a[0].type === "list" && a[0].start, 1);
  const f = parse("３） 三\n４） 四");
  assert.equal(f[0].type === "list" && f[0].start, 3);
  assert.deepEqual(sketchList(f[0]), ["三", "四"]);
});

test("有序清單被程式碼區塊隔開：第二段的 start 不重編（P6）", () => {
  const b = parse("1. 步驟\n\n```\ncode\n```\n\n2. 步驟二");
  assert.deepEqual(types(b), ["list", "code", "list"]);
  assert.equal(b[2].type === "list" && b[2].start, 2);
});

test("P8：符號後沒空白不算有序清單（１．一、3、4 月）", () => {
  assert.deepEqual(types(parse("１．一")), ["paragraph"]);
  assert.deepEqual(types(parse("3、4 月去京都")), ["paragraph"]);
  assert.deepEqual(types(parse("1.5 倍速")), ["paragraph"]);
});

test("巢狀：兩層與三層；第四層壓回三", () => {
  assert.deepEqual(sketchList(parse("- a\n  - b\n- c")[0]), [["a", "b"], "c"]);
  assert.deepEqual(sketchList(parse("- a\n  - b\n    - c")[0]), [["a", ["b", "c"]]]);
  // 第四層（縮 6 格）仍留在第三層
  const four = parse("- a\n  - b\n    - c\n      - d")[0];
  assert.deepEqual(sketchList(four), [["a", ["b", "c", "d"]]]);
});

test("巢狀：縮進淺了回上層；Tab 算一層", () => {
  assert.deepEqual(sketchList(parse("- a\n  - b\n    - c\n  - d\n- e")[0]), [["a", ["b", "c"], "d"], "e"]);
  assert.deepEqual(sketchList(parse("- a\n\t- b")[0]), [["a", "b"]]);
});

test("P7：縮排一次跳兩層以上只深一層；有序無序混用另開兄弟清單", () => {
  assert.deepEqual(sketchList(parse("- a\n      - b")[0]), [["a", "b"]]);
  // 根層混用 ⇒ 兩個清單
  const mix = parse("- a\n1. b");
  assert.deepEqual(types(mix), ["list", "list"]);
  assert.equal(mix[0].type === "list" && mix[0].ordered, false);
  assert.equal(mix[1].type === "list" && mix[1].ordered, true);
  // 子層混用 ⇒ 同一個項目底下兩個兄弟清單
  const sub = parse("- a\n  - b\n  1. c");
  const item = sub[0].type === "list" ? sub[0].items[0] : null;
  assert.equal(item?.children.length, 2);
});

test("P7 補：4 格縮排的同層項目是兄弟，不疊成樓梯", () => {
  assert.deepEqual(sketchList(parse("- a\n    - b\n    - c\n- d")[0]), [["a", "b", "c"], "d"]);
  // 更深（6 格）同理；跳兩層之後回到中間縮排，仍留在同一個子清單
  assert.deepEqual(sketchList(parse("- a\n      - b\n      - c")[0]), [["a", "b", "c"]]);
  assert.deepEqual(sketchList(parse("- a\n      - b\n  - c")[0]), [["a", "b", "c"]]);
  // 回到根層再開新子清單：各自一組
  assert.deepEqual(sketchList(parse("- a\n    - b\n    - c\n- d\n    - e")[0]), [["a", "b", "c"], ["d", "e"]]);
});

/** 區塊樹裡所有 tag 段的 raw 名（照出現順序） */
function renderedTags(bs: MdBlock[]): string[] {
  const out: string[] = [];
  const walk = (xs: MdInline[]): void => {
    for (const x of xs) {
      if (x.kind === "tag") out.push(x.occ.raw);
      else if (x.kind === "strong" || x.kind === "em") walk(x.children);
    }
  };
  const block = (b: MdBlock): void => {
    if (b.type === "heading") walk(b.inline);
    else if (b.type === "paragraph" || b.type === "quote") b.lines.forEach(walk);
    else if (b.type === "list")
      b.items.forEach((it) => {
        walk(it.inline);
        it.children.forEach(block);
      });
  };
  bs.forEach(block);
  return out;
}

test("閱讀態的小牌與 ③ 存檔判定（parseTags）一致：符號貼著 # 的 `>#x`、`・#x` 不是荷札", () => {
  const cases = [
    ">#靈感",
    "> #靈感",
    "・#靈感",
    "・ #靈感",
    "- #靈感",
    "1. #靈感",
    "# 標題 #靈感",
    "段落 #靈感 與 #另一個",
    "- a\n  >#x\n  ・#y",
    ">・#z",
  ];
  for (const body of cases) {
    assert.deepEqual(
      renderedTags(parse(body)),
      parseTags(body).map((o) => o.raw),
      JSON.stringify(body),
    );
  }
  // 明確鎖住兩端：貼著符號的不是、隔了空白的才是
  assert.deepEqual(renderedTags(parse(">#x")), []);
  assert.deepEqual(renderedTags(parse("・#x")), []);
  assert.deepEqual(renderedTags(parse("> #x")), ["x"]);
  assert.deepEqual(renderedTags(parse("・ #x")), ["x"]);
});

test("符號後的行內照常：引用與圓點條列裡的粗體、連結、行內程式碼不受前綴影響", () => {
  const q = parse(">**粗** 與 `c` 與 [字](https://x.com)");
  assert.equal(q[0].type, "quote");
  if (q[0].type === "quote") assert.deepEqual(kinds(q[0].lines[0]), ["strong", "text", "code", "text", "link"]);
  const l = parse("・[字](https://x.com) 後");
  assert.deepEqual(sketchList(l[0]), ["字 後"]);
});

test("清單：- [ ] 與 - [x] 的方括號留在文字裡", () => {
  const b = parse("- [ ] 買牛奶\n- [x] 寄信");
  assert.deepEqual(sketchList(b[0]), ["[ ] 買牛奶", "[x] 寄信"]);
});

test("引用：連續行合一塊；引用後接段落", () => {
  const b = parse("> 甲\n> 乙\n接著說");
  assert.deepEqual(types(b), ["quote", "paragraph"]);
  assert.equal(b[0].type === "quote" && b[0].lines.length, 2);
});

test("hr：--- *** ___ 三種；--- 不是條列", () => {
  assert.deepEqual(types(parse("---\n***\n___")), ["hr", "hr", "hr"]);
  assert.deepEqual(types(parse("- a\n---\n- b")), ["list", "hr", "list"]);
});

test("圍欄：``` 與 ~~~、語言字、原樣（不切段）", () => {
  const a = parse("```js\nlet a = 1 #x\n\n**y**\n```");
  assert.deepEqual(a, [{ type: "code", text: "let a = 1 #x\n\n**y**", lang: "js" }]);
  const b = parse("~~~\nplain\n~~~");
  assert.deepEqual(b, [{ type: "code", text: "plain", lang: null }]);
});

test("圍欄：收尾要同種類且不短於開欄；內文含較短的欄不收", () => {
  const b = parse("````\n```\ninner\n```\n````\n後面");
  assert.equal(b[0].type === "code" && b[0].text, "```\ninner\n```");
  assert.equal(b[1].type, "paragraph");
});

test("圍欄：未閉合到檔尾", () => {
  const b = parse("前\n\n```\n沒收尾\n第二行");
  assert.deepEqual(types(b), ["paragraph", "code"]);
  assert.equal(b[1].type === "code" && b[1].text, "沒收尾\n第二行");
});

test("空行切段；段內換行保留成多行", () => {
  const b = parse("甲\n乙\n\n丙");
  assert.deepEqual(types(b), ["paragraph", "paragraph"]);
  assert.equal(b[0].type === "paragraph" && b[0].lines.length, 2);
});

test("Windows 換行與舊 Mac 換行", () => {
  assert.deepEqual(types(parse("# 標\r\n\r\n- a\r\n- b")), ["heading", "list"]);
  assert.deepEqual(types(parse("甲\r乙")), ["paragraph"]);
});

test("空字串與只有空白", () => {
  assert.deepEqual(parse(""), []);
  assert.deepEqual(parse("  \n\t\n　"), []);
});

/* ═══ 行內 ═══ */

test("**「重點」**後面 → strong（全形標點貼著星號）", () => {
  const x = inl("**「重點」**後面");
  assert.deepEqual(kinds(x), ["strong", "text"]);
  assert.equal(inlinePlainText(x), "「重點」後面");
});

test("**粗**#標籤：#標籤 不是小牌（與 ③ 存檔判定一致）", () => {
  const x = inl("**粗**#標籤");
  assert.equal(x.some((n) => n.kind === "tag"), false);
  assert.equal(x[0].kind, "strong");
});

test("**粗** 與 *斜*", () => {
  assert.deepEqual(kinds(inl("a **粗** b")), ["text", "strong", "text"]);
  assert.deepEqual(kinds(inl("a *斜* b")), ["text", "em", "text"]);
});

test("***粗斜*** → strong 含 em", () => {
  const x = inl("***粗斜***");
  assert.equal(x.length, 1);
  assert.equal(x[0].kind, "strong");
  if (x[0].kind === "strong") assert.equal(x[0].children[0].kind, "em");
});

test("不配對的星號原樣；兩側有空白的星號不成斜體", () => {
  assert.equal(inlinePlainText(inl("**沒收尾")), "**沒收尾");
  assert.equal(inlinePlainText(inl("a * b * c")), "a * b * c");
  assert.deepEqual(kinds(inl("a * b * c")), ["text"]);
});

test("5*3*2：首尾非空白就算斜體（鎖住）", () => {
  assert.deepEqual(kinds(inl("5*3*2")), ["text", "em", "text"]);
});

test("[字](https://x) → link；後面的中文不被網址吃掉（P1）", () => {
  const a = inl("看 [字](https://x.com/a) 吧");
  assert.deepEqual(kinds(a), ["text", "link", "text"]);
  const l = a[1];
  assert.equal(l.kind === "link" && l.href, "https://x.com/a");
  assert.equal(l.kind === "link" && l.text, "字");
  // 右括號後面緊接中文：網址段把「)的說明」一起吃進去，要從第一個 ) 切開
  const b = inl("[字](https://x.com/a)的說明");
  assert.deepEqual(kinds(b), ["link", "text"]);
  assert.equal(inlinePlainText(b), "字的說明");
});

test("不安全的連結退成原字：javascript:／相對路徑／mailto:／file:／data:", () => {
  for (const href of ["javascript:alert(1)", "x", "mailto:a@b.co", "file:///c/x", "data:text/html,1", "/a/b", "ftp://x.com/y"]) {
    const x = inl(`[字](${href})`);
    assert.equal(x.some((n) => n.kind === "link"), false, href);
    assert.equal(inlinePlainText(x), `[字](${href})`, href);
  }
});

test("isSafeHref 只放 http／https（不分大小寫）", () => {
  assert.equal(isSafeHref("https://a.com"), true);
  assert.equal(isSafeHref("HTTP://a.com"), true);
  for (const bad of ["mailto:a@b.co", "javascript:alert(1)", "file:///x", "data:text/plain,1", "//a.com", "a.com", "", " https://a.com"]) {
    assert.equal(isSafeHref(bad), false, bad);
  }
});

test("urlSegHref：http(s) 照用、www. 補 https、其餘 null", () => {
  assert.equal(urlSegHref("https://a.com/x"), "https://a.com/x");
  assert.equal(urlSegHref("www.a.com"), "https://www.a.com");
  assert.equal(urlSegHref("javascript:1"), null);
});

test("行內程式碼裡的 **x** 原樣；#a/b* 的荷札尾巴；網址內的 *y* 不切", () => {
  const c = inl("`**x**`");
  assert.deepEqual(kinds(c), ["code"]);
  const t = inl("#a/b*");
  assert.equal(t[0].kind, "tag");
  const u = inl("https://x.com/*y*");
  assert.deepEqual(kinds(u), ["url"]);
});

test("`#tag` 在行內程式碼裡不是小牌；真荷札與粗體同行", () => {
  assert.equal(inl("用 `#define`").some((n) => n.kind === "tag"), false);
  assert.deepEqual(kinds(inl("**粗** #讀書/日文")), ["strong", "text", "tag"]);
});

test("空字串與只有空白", () => {
  assert.deepEqual(inl(""), []);
  assert.deepEqual(kinds(inl("   ")), ["text"]);
});

/* ═══ 純文字 ═══ */

test("mdPlainText：去符號、有序清單用 start 編號、圍欄原樣", () => {
  const t = mdPlainText(parse("# 標題\n\n**粗** 與 [字](https://x.com)\n\n3. 三\n4. 四\n\n```\n#不是荷札\n```"));
  assert.equal(t, "標題\n粗 與 字\n3. 三\n4. 四\n#不是荷札");
});

test("圍欄裡的 #tag／**x**／空行原樣；圍欄後面照常解析", () => {
  const b = parse("```\n#不是荷札\n**不是粗體**\n\n```\n# 後面");
  assert.deepEqual(types(b), ["code", "heading"]);
  assert.equal(b[0].type === "code" && b[0].text, "#不是荷札\n**不是粗體**\n");
});

/* ═══ 增補（資料層 agent）：安全反例、區塊邊角、行內邊角 ═══ */

/** 走遍 AST，收集所有行內節點（含 strong／em 的子節點、清單項、清單巢狀） */
function allInline(blocks: MdBlock[]): MdInline[] {
  const out: MdInline[] = [];
  const walkInl = (xs: MdInline[]): void => {
    for (const x of xs) {
      out.push(x);
      if (x.kind === "strong" || x.kind === "em") walkInl(x.children);
    }
  };
  const walkBlock = (b: MdBlock): void => {
    if (b.type === "heading") walkInl(b.inline);
    else if (b.type === "paragraph" || b.type === "quote") b.lines.forEach(walkInl);
    else if (b.type === "list") {
      for (const it of b.items) {
        walkInl(it.inline);
        it.children.forEach(walkBlock);
      }
    }
  };
  blocks.forEach(walkBlock);
  return out;
}

/* ─── 安全（主對話放行條件 4：連結只放行 http／https；其他一律當純文字） ─── */

test("安全：[字](javascript:…) 不成連結，原字保留（含大寫與前導空白）", () => {
  for (const href of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", " javascript:alert(1)", "JaVaScRiPt:void(0)"]) {
    const x = inl(`[字](${href})`);
    assert.equal(x.some((n) => n.kind === "link"), false, href);
    assert.equal(inlinePlainText(x), `[字](${href})`, href);
  }
});

test("安全：[字](file:///…) 不成連結", () => {
  const x = inl("[字](file:///C:/Windows/system.ini)");
  assert.equal(x.some((n) => n.kind === "link"), false);
  assert.equal(inlinePlainText(x), "[字](file:///C:/Windows/system.ini)");
});

test("安全：[字](data:…) 不成連結", () => {
  const x = inl("[字](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)");
  assert.equal(x.some((n) => n.kind === "link"), false);
});

test("安全：[字](mailto:…) 不成連結（0-6 修訂：拿掉 mailto）", () => {
  const x = inl("[信](mailto:a@b.co)");
  assert.equal(x.some((n) => n.kind === "link"), false);
  assert.equal(inlinePlainText(x), "[信](mailto:a@b.co)");
});

test("安全：相對路徑與協定相對網址不成連結", () => {
  for (const href of ["page.html", "./a", "../a", "/etc/passwd", "//evil.example/x", "#top", "?q=1"]) {
    const x = inl(`[字](${href})`);
    assert.equal(x.some((n) => n.kind === "link"), false, href);
    assert.equal(inlinePlainText(x), `[字](${href})`, href);
  }
});

test("安全：裸的 javascript:／data:／file: 字串只是文字（不會變成 url 段）", () => {
  for (const raw of ["javascript:alert(1)", "data:text/html,1", "file:///x", "vbscript:msgbox(1)"]) {
    const x = inl(raw);
    assert.deepEqual(kinds(x), ["text"], raw);
    assert.equal(urlSegHref(raw), null, raw);
  }
});

test("安全：HTML 與 script 標籤只是文字，AST 裡沒有它們的節點", () => {
  const b = parse("<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n- <b>粗</b>");
  const flat = allInline(b);
  assert.equal(flat.every((n) => ["text", "tag", "code", "url", "strong", "em", "link"].includes(n.kind)), true);
  assert.match(inlinePlainText(flat), /<script>alert\(1\)<\/script>/);
});

test("安全：整份敵意內文走完 AST，所有 link 的 href 都過 isSafeHref、所有 url 段都是 http／https／www", () => {
  const hostile = [
    "[a](javascript:alert(1)) [b](https://ok.example/x) [c](data:text/html,1) [d](mailto:x@y.z)",
    "# [標題](file:///x)\n> [引用](JAVASCRIPT:1)\n- [項目](//evil)\n  - [子項](https://ok.example/y)",
    "```\n[程式碼](javascript:alert(1))\n```",
    "https://ok.example/a javascript:alert(1) www.ok.example",
  ].join("\n\n");
  const flat = allInline(parse(hostile));
  for (const n of flat) {
    if (n.kind === "link") assert.equal(isSafeHref(n.href), true, n.href);
    if (n.kind === "url") assert.notEqual(urlSegHref(n.text), null, n.text);
  }
  // 兩個放行的連結都在
  assert.equal(flat.filter((n) => n.kind === "link").length, 2);
});

test("安全：圍欄裡的連結語法原樣、不解析", () => {
  const b = parse("```\n[程式碼](https://x.com)\n```");
  assert.deepEqual(b, [{ type: "code", text: "[程式碼](https://x.com)", lang: null }]);
});

/* ─── 區塊邊角 ─── */

test("標題行內：粗體、斜體、行內程式碼都能用", () => {
  const b = parse("## **粗** 與 *斜* 與 `碼`");
  assert.equal(b[0].type, "heading");
  if (b[0].type === "heading") assert.deepEqual(kinds(b[0].inline), ["strong", "text", "em", "text", "code"]);
});

test("標題：只有井號（沒有字）不是標題", () => {
  assert.deepEqual(types(parse("#")), ["paragraph"]);
  assert.deepEqual(types(parse("## ")), ["paragraph"]);
});

test("標題：全形空白也能分隔；標題打斷段落、不需要空行", () => {
  const h = parse("#　全形空白");
  assert.equal(h[0].type, "heading");
  assert.deepEqual(types(parse("前一段\n# 標題\n後一段")), ["paragraph", "heading", "paragraph"]);
});

test("條列打斷段落、段落接在條列後面另成一段（續行不併入項目）", () => {
  assert.deepEqual(types(parse("段\n- 條列\n後段")), ["paragraph", "list", "paragraph"]);
  assert.deepEqual(types(parse("- a\n延續")), ["list", "paragraph"]);
});

test("條列：空行把清單切成兩個", () => {
  assert.deepEqual(types(parse("- a\n\n- b")), ["list", "list"]);
});

test("條列：-a（沒空白）與 －（全形無空白）不是條列；－ 加空白是", () => {
  assert.deepEqual(types(parse("-a")), ["paragraph"]);
  assert.deepEqual(types(parse("－全形")), ["paragraph"]);
  assert.deepEqual(sketchList(parse("－ 甲\n＊ 乙")[0]), ["甲", "乙"]);
});

test("條列：只有符號的行（- ）不是空項目，而是普通文字", () => {
  assert.deepEqual(types(parse("- ")), ["paragraph"]);
});

test("條列項目的行內：粗體、荷札、連結都解析", () => {
  const b = parse("- **粗** #讀書/日文 [說明](https://x.com/a)");
  assert.equal(b[0].type, "list");
  if (b[0].type === "list") assert.deepEqual(kinds(b[0].items[0].inline), ["strong", "text", "tag", "text", "link"]);
});

test("有序：1) 與 1、（後接空白）都算；序號不連續也不重編（以第一項為 start）", () => {
  assert.equal(parse("1) 甲\n2) 乙")[0].type, "list");
  assert.equal(parse("1、 甲")[0].type, "list");
  assert.equal(parse("1、甲")[0].type, "paragraph"); // P8：符號後沒空白不算
  const b = parse("9. 甲\n10. 乙\n2. 丙");
  assert.equal(b[0].type === "list" && b[0].start, 9);
  assert.deepEqual(sketchList(b[0]), ["甲", "乙", "丙"]);
});

test("有序：子層無序、無序下的有序子層各自成立", () => {
  const a = parse("1. 甲\n   - 子一\n   - 子二\n2. 乙")[0];
  assert.deepEqual(sketchList(a), [["甲", "子一", "子二"], "乙"]);
  const b = parse("- 甲\n  1. 子一\n  2. 子二")[0];
  assert.equal(b.type === "list" && b.items[0].children[0].type === "list" && b.items[0].children[0].ordered, true);
});

test("縮排開頭的第一項就是基準層，之後同寬＝同層", () => {
  assert.deepEqual(sketchList(parse("  - 甲\n- 乙")[0]), ["甲", "乙"]);
});

test("引用：> 後沒空白也行；空引用行 > 保留成空行；空行把引用切成兩塊", () => {
  const a = parse(">緊貼");
  assert.equal(a[0].type === "quote" && inlinePlainText(a[0].lines[0]), "緊貼");
  const b = parse("> 甲\n>\n> 乙");
  assert.equal(b[0].type === "quote" && b[0].lines.length, 3);
  assert.deepEqual(types(parse("> 甲\n\n> 乙")), ["quote", "quote"]);
});

test("引用裡的 - 不再解析成條列（引用只收行內）；引用內的荷札與粗體照常", () => {
  const b = parse("> - 項目 **粗** #靈感");
  assert.deepEqual(types(b), ["quote"]);
  if (b[0].type === "quote") assert.deepEqual(kinds(b[0].lines[0]), ["text", "strong", "text", "tag"]);
});

test("hr：四個以上也算；兩個不算；hr 打斷段落（不支援 Setext 標題）", () => {
  assert.deepEqual(types(parse("----")), ["hr"]);
  assert.deepEqual(types(parse("--")), ["paragraph"]);
  assert.deepEqual(types(parse("標題\n---")), ["paragraph", "hr"]);
});

test("圍欄：行首縮排 3 格仍是圍欄，4 格不是（變成含行內程式碼的段落）", () => {
  assert.deepEqual(types(parse("   ```\nx\n   ```")), ["code"]);
  assert.equal(types(parse("    ```\nx\n    ```")).includes("code"), false);
});

test("圍欄：語言字可含空白、收尾行可帶尾端空白、空圍欄＝空字串", () => {
  assert.deepEqual(parse("```js title\nx\n```  "), [{ type: "code", text: "x", lang: "js title" }]);
  assert.deepEqual(parse("```\n```"), [{ type: "code", text: "", lang: null }]);
});

test("圍欄：內文的縮排與 --- 原樣保留；圍欄打斷段落", () => {
  const b = parse("段\n```\n  縮排\n---\n```");
  assert.deepEqual(types(b), ["paragraph", "code"]);
  assert.equal(b[1].type === "code" && b[1].text, "  縮排\n---");
});

test("段落：行首行尾空白修掉、全形空白也修；多行保持逐行", () => {
  const b = parse("  甲  \n　乙　");
  assert.equal(b[0].type === "paragraph" && b[0].lines.map(inlinePlainText).join("|"), "甲|乙");
});

test("大量輸入不卡：5000 行條列＋段落 < 1 秒", () => {
  const body = Array.from({ length: 5000 }, (_, i) => (i % 3 === 0 ? `- 項目 ${i} **粗** #標籤${i}` : `段落 ${i} 的內容`)).join("\n");
  const t0 = Date.now();
  const b = parse(body);
  assert.ok(b.length > 0);
  assert.ok(Date.now() - t0 < 1000);
});

/* ─── 行內邊角 ─── */

test("連結：同一行兩個；連結後面的標點與中文留作文字", () => {
  const x = inl("[a](https://x.com/1) 和 [b](https://y.com/2)，完");
  assert.deepEqual(kinds(x), ["link", "text", "link", "text"]);
  assert.equal(inlinePlainText(x), "a 和 b，完");
});

test("連結：scheme 大小寫不拘；網址含空白的標題寫法不成連結（原字保留）", () => {
  assert.equal(inl("[字](HTTPS://X.COM)")[0].kind, "link");
  const x = inl('[字](https://x.com/a "標題")');
  assert.equal(x.some((n) => n.kind === "link"), false);
  assert.equal(inlinePlainText(x), '[字](https://x.com/a "標題")');
});

test("連結：字空白、網址前有空白都不成連結", () => {
  assert.equal(inl("[](https://x.com)").some((n) => n.kind === "link"), false);
  assert.equal(inl("[字]( https://x.com)").some((n) => n.kind === "link"), false);
});

test("連結：行尾的連結；連結的字裡的星號原樣", () => {
  const a = inl("見 [說明](https://x.com/doc)");
  assert.deepEqual(kinds(a), ["text", "link"]);
  const b = inl("[**字**](https://x.com)");
  assert.equal(b[0].kind === "link" && b[0].text, "**字**");
});

test("裸網址：www. 開頭是 url 段；句尾的中文句號不被吃進網址", () => {
  const a = inl("看 www.a.com 吧");
  assert.deepEqual(kinds(a), ["text", "url", "text"]);
  const b = inl("https://a.com/x。後面");
  assert.equal(b[0].kind === "url" && b[0].text, "https://a.com/x");
});

test("[字](www.x.com) 與裸網址同口徑：補 https:// 成連結；其他 scheme 仍是原字", () => {
  const a = inl("看[說明](www.x.com)吧");
  const link = a.find((x) => x.kind === "link");
  assert.ok(link && link.kind === "link" && link.href === "https://www.x.com" && link.text === "說明");
  assert.ok(!inl("[字](ftp://x.com)").some((x) => x.kind === "link"));
});

test("粗體裡含斜體；詞中的 ** 也成立（中文不用空白分詞）", () => {
  const a = inl("**粗 *斜* 粗**");
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, "strong");
  if (a[0].kind === "strong") assert.deepEqual(kinds(a[0].children), ["text", "em", "text"]);
  assert.deepEqual(kinds(inl("甲**乙**丙")), ["text", "strong", "text"]);
});

test("星號鎖住的邊角：**** 與 ** 空白 ** 與 * 空白* 都是原字；__底線__ 不是粗體", () => {
  assert.deepEqual(kinds(inl("****")), ["text"]);
  assert.deepEqual(kinds(inl("** 不粗 **")), ["text"]);
  assert.deepEqual(kinds(inl("* a*")), ["text"]);
  assert.deepEqual(kinds(inl("__粗__")), ["text"]);
});

test("粗體不跨荷札小牌：星號被小牌隔開就原樣（與 ③ 切段一致）", () => {
  const x = inl("**粗 #標籤 粗**");
  assert.equal(x.some((n) => n.kind === "strong"), false);
  assert.equal(x.some((n) => n.kind === "tag"), true);
});

test("行內程式碼：反引號內的連結與星號都原樣", () => {
  const x = inl("`[a](https://x.com)` 與 `*b*`");
  assert.deepEqual(kinds(x), ["code", "text", "code"]);
});

test("inlinePlainText：荷札還原成 #原字、行內程式碼去反引號、連結留字", () => {
  const x = inl("**粗** #讀書/日文 `碼` [字](https://x.com)");
  assert.equal(inlinePlainText(x), "粗 #讀書/日文 碼 字");
});

test("headingText：不是標題＝空字串；mdPlainText：空內文、hr、巢狀縮排", () => {
  const b = parse("甲");
  assert.equal(headingText(b[0]), "");
  assert.equal(mdPlainText(parse("")), "");
  assert.equal(mdPlainText(parse("- a\n  - b\n---\n> 引")), "- a\n  - b\n引");
});
