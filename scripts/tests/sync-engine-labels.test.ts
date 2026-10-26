/**
 * 同步引擎班 G 席——提示面的純函式與 HLC 種子：
 *   #96 目標分類（time_goals.scope）兩台互蓋時，toast／清單句帶「被蓋掉的那邊多了／少了哪些」；
 *   B2-6 `seedHlc` 的形狀驗證與漂移上限（超過 now+24h 的種子不吃）；
 *   售票口定期帳（tk_repeats）的清單列名、欄名與 `skipped_days` 的人話；TBL_NOUN 補 tk_repeats。
 * 跑法：`node --test scripts/tests/sync-engine-labels.test.ts`（node 24，型別剝除預設開；零依賴）。
 * `syncRepository.ts` 會碰 Tauri：`@tauri-apps/api/core` 與 `../lib/db` 換替身（只為了載得進來，seedHlc／nextHlc 是純記憶體狀態）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const dataUrl = (src: string) => "data:text/javascript," + encodeURIComponent(src);
registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL;
    if (parent !== undefined && parent.includes("/src/")) {
      if (specifier === "@tauri-apps/api/core") return { url: dataUrl(`export async function invoke() { throw new Error("測試不呼叫 Rust"); }`), shortCircuit: true };
      if (specifier === "../lib/db") return { url: dataUrl(`export function getDb() { throw new Error("測試不開庫"); } export function nowUtcIso() { return new Date().toISOString(); }`), shortCircuit: true };
      if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
        try {
          return nextResolve(specifier + ".ts", context);
        } catch {
          return nextResolve(specifier + "/index.ts", context);
        }
      }
    }
    return nextResolve(specifier, context);
  },
});

const { describeMerge, mergeSetDiff, mergeToastText, setDiffText, TBL_NOUN, countNoun } = await import("../../src/domain/syncMerge.ts");
const { seedHlc, nextHlc, HLC_MAX_DRIFT_MS } = await import("../../src/data/syncRepository.ts");
const { repeatSyncLabel, skippedDaysText, repeatLabel } = await import("../../src/lines/ticketSyncLabel.ts");
type MergeNotice = import("../../src/data/syncRepository.ts").MergeNotice;

function mk(p: Partial<MergeNotice> = {}): MergeNotice {
  return {
    kind: "overwritten",
    tbl: "time_goals",
    row_id: "9c1e0000-0000-4000-8000-00000000a1b2",
    col: "scope",
    mine: null,
    theirs: null,
    winner: "theirs",
    their_device: "edcf0000",
    by_me: true,
    hlc: "17607720000000003-edcf0000",
    at: "2026-10-26T06:32:10.004Z",
    ...p,
  };
}

/* ───────── #96 目標分類的差 ───────── */

const CAT: Record<string, string> = { c1: "日文", c2: "英文", c3: "運動", c4: "閱讀", c5: "寫作" };
/** ＝時刻表 `scopeNames` 的行為：分類名以「・」串、全找不到＝（沒有分類） */
const fmt = (col: string, v: unknown): string | null => {
  if (col !== "scope" || typeof v !== "string") return null;
  const o = JSON.parse(v) as { v?: number; cats?: string[]; categories?: string[] };
  const ids = "v" in o ? (o.v === 2 ? o.cats : null) : o.categories;
  if (!Array.isArray(ids)) return null;
  const names = ids.map((id) => CAT[id]).filter(Boolean);
  return names.length ? names.join("・") : "（沒有分類）";
};
const v1 = (...ids: string[]) => JSON.stringify({ categories: ids });
const v2 = (...ids: string[]) => JSON.stringify({ v: 2, cats: ids });
const COLS = { scope: "分類" };

describe("#96 目標分類：被蓋掉的那邊差了什麼", () => {
  test("這台被蓋（winner=theirs、by_me）：這台原本多／少；v1 與 v2 混著也認", () => {
    const n = mk({ mine: v1("c1", "c2"), theirs: v2("c1", "c3") });
    assert.deepEqual(mergeSetDiff(n, fmt), { who: "這台", extra: ["英文"], missing: ["運動"] });
    assert.equal(
      mergeToastText([n], "目標「讀書」", COLS, undefined, undefined, fmt),
      "目標「讀書」的分類兩台都改過，留下後改的（這台原本多：英文／少：運動）",
    );
  });

  test("這台贏（winner=mine）：說另一台原本多／少；第三台的（!by_me）不指認這台", () => {
    const n = mk({ mine: v1("c1"), theirs: v1("c1", "c4"), winner: "mine" });
    assert.deepEqual(mergeSetDiff(n, fmt), { who: "另一台", extra: ["閱讀"], missing: [] });
    const third = mk({ mine: v1("c1", "c4"), theirs: v1("c1"), by_me: false });
    assert.equal(mergeSetDiff(third, fmt)?.who, "被蓋掉的那台");
    assert.equal(
      mergeToastText([third], "目標「讀書」", COLS, undefined, undefined, fmt),
      "目標「讀書」的分類兩台都改過，留下後改的（被蓋掉的那台原本多：閱讀）", // 第三台的本來就不說留下哪台
    );
  });

  test("toast 兩行放不下：少列名字 → 只說數量 → 不補（回原句）", () => {
    const n = mk({ mine: v1("c1", "c2", "c3", "c4"), theirs: v1("c5") });
    const short = mk({ mine: v1("c1", "c2"), theirs: v1("c1", "c3") });
    assert.equal(
      mergeToastText([short], "目標「讀書」", COLS, undefined, undefined, fmt),
      "目標「讀書」的分類兩台都改過，留下後改的（這台原本多：英文／少：運動）",
      "放得下就列名字（每邊最多 2 個）",
    );
    assert.equal(
      mergeToastText([n], "目標「讀書」", COLS, undefined, undefined, fmt),
      "目標「讀書」的分類兩台都改過，留下後改的（這台原本多：日文等 4 個／少：寫作）",
      "兩個名字放不下 ⇒ 每邊一個",
    );
    assert.equal(
      mergeToastText([n], "目標「讀書每週」", COLS, undefined, undefined, fmt),
      "目標「讀書每週」的分類兩台都改過，留下後改的（這台原本多 4 個、少 1 個）",
      "一個名字也放不下 ⇒ 只說數量",
    );
    assert.equal(
      mergeToastText([n], "目標「讀書時數每週目標」", COLS, undefined, undefined, fmt),
      "目標「讀書時數每週目標」的分類兩台都改過，留下另一台後改的",
      "數量也放不下 ⇒ 原句一字不動",
    );
    for (const label of ["目標「讀書」", "目標「讀書每週」"]) {
      assert.ok(Array.from(mergeToastText([n], label, COLS, undefined, undefined, fmt)).length <= 40, label);
    }
  });

  test("setDiffText：名字上限與「等 N 個」、數量版", () => {
    const d = { who: "這台", extra: ["日文", "英文", "運動"], missing: ["閱讀"] };
    assert.equal(setDiffText(d, 2), "（這台原本多：日文、英文等 3 個／少：閱讀）");
    assert.equal(setDiffText(d, 0), "（這台原本多 3 個、少 1 個）");
    assert.equal(setDiffText({ who: "另一台", extra: [], missing: ["閱讀"] }, 3), "（另一台原本少：閱讀）");
  });

  test("清單句：原句後接差異句（每邊 3 個）；note 接在最後；不給 fmt／不是集合欄／沒差 ⇒ 逐字不變", () => {
    const n = mk({ mine: v1("c1", "c2"), theirs: v1("c1", "c3") });
    assert.equal(describeMerge(n, fmt), "這台改成「日文・英文」、另一台改成「日文・運動」——留下另一台後改的（這台原本多：英文／少：運動）");
    assert.equal(
      describeMerge(n, fmt, undefined, "補一句"),
      "這台改成「日文・英文」、另一台改成「日文・運動」——留下另一台後改的（這台原本多：英文／少：運動）（補一句）",
    );
    assert.ok(!describeMerge(n).includes("原本"), "不給 fmt 不補");
    assert.equal(mergeToastText([n], "目標「讀書」", COLS), "目標「讀書」的分類兩台都改過，留下另一台後改的", "toast 不給 fmt 逐字不變");
    const other = mk({ tbl: "time_goals", col: "name", mine: "甲", theirs: "乙" });
    assert.equal(describeMerge(other, fmt), "這台改成「甲」、另一台改成「乙」——留下另一台後改的");
    const same = mk({ mine: v1("c1", "c2"), theirs: v2("c2", "c1") }); // 只是 v1→v2 形狀換了、順序換了
    assert.equal(mergeSetDiff(same, fmt), null);
    // 後來又被整理過 ⇒ 不補（留下的已經不是那個值）
    assert.ok(!describeMerge(n, fmt, { changed: true, now: v1("c5") }).includes("原本"));
    assert.ok(!mergeToastText([n], "目標「讀書」", COLS, undefined, new Set([`time_goals\u0000${n.row_id}\u0000scope`]), fmt).includes("原本"));
  });

  test("分類已刪（fmt 問不出名字）的元素略過；全部問不出 ⇒ 不補", () => {
    const n = mk({ mine: v1("c1", "gone"), theirs: v1("c1") });
    assert.equal(mergeSetDiff(n, fmt), null, "只差一個已刪分類＝沒有可講的");
    const n2 = mk({ mine: v1("c1", "gone", "c2"), theirs: v1("c1") });
    assert.deepEqual(mergeSetDiff(n2, fmt)?.extra, ["英文"]);
  });
});

/* ───────── B2-6 seedHlc ───────── */

describe("B2-6 seedHlc：形狀與漂移上限", () => {
  const NOW = 1_800_000_000_000; // 遠在其他測試可能餵過的種子之後
  const h = (ms: number, count = 0, tail = "-abcdef12") => String(ms).padStart(13, "0") + count.toString(16).padStart(4, "0") + tail;
  const msOf = (s: string) => Number(s.slice(0, 13));

  test("上限與 Rust 同值（一天）", () => {
    assert.equal(HLC_MAX_DRIFT_MS, 24 * 60 * 60 * 1000);
  });

  test("一天內的未來種子照吃：之後產生的比它大", () => {
    const seed = h(NOW + 60 * 60 * 1000, 5);
    seedHlc(seed, NOW);
    const next = nextHlc(NOW);
    assert.ok(next > seed.slice(0, 17), `${next} 要大於 ${seed}`);
  });

  test("超過 now+24h 的種子不吃（不讓時鐘被拖到未來）；前 17 碼的寫法同樣擋", () => {
    const before = msOf(nextHlc(NOW + 1));
    seedHlc(h(NOW + HLC_MAX_DRIFT_MS + 10 * 60 * 1000), NOW + 1);
    seedHlc(h(NOW + 3 * HLC_MAX_DRIFT_MS, 0, ""), NOW + 1);
    const after = msOf(nextHlc(NOW + 2));
    assert.ok(after <= Math.max(before, NOW + 2), `時鐘不該被拉到未來：${after}`);
  });

  test("剛好 now+24h 還算數", () => {
    const edge = NOW + 10 * HLC_MAX_DRIFT_MS; // 跟前面的種子拉開
    seedHlc(h(edge + HLC_MAX_DRIFT_MS, 1), edge);
    assert.equal(msOf(nextHlc(edge)), edge + HLC_MAX_DRIFT_MS);
  });

  test("形狀不對不吃：長度夠但有非數字、大寫 hex、少了 '-'", () => {
    const base = NOW + 100 * HLC_MAX_DRIFT_MS;
    const before = msOf(nextHlc(base));
    for (const bad of [
      "17x0000000000000a-abcdef12",
      String(base + 1000).padStart(13, "0") + "000A-abcdef12",
      String(base + 1000).padStart(13, "0") + "0000xabcdef12",
      String(base + 1000).padStart(13, "0") + "000",
      null,
      undefined,
      "",
    ]) {
      seedHlc(bad, base);
    }
    assert.ok(msOf(nextHlc(base)) <= Math.max(before, base), "壞種子一顆都沒吃");
  });
});

/* ───────── 售票口定期帳 ───────── */

describe("tk_repeats：清單列與 skipped_days 講人話", () => {
  const look = { accountName: (id: string) => ({ a1: "郵局" })[id] ?? null, categoryName: (id: string) => ({ k1: "房租" })[id] ?? null };
  const row = {
    id: "r1",
    kind: "expense" as const,
    account_id: "a1",
    to_account_id: null,
    category_id: "k1",
    amount_minor: 1200000,
    currency: "TWD",
    note: "",
    route_id: null,
    rule: "{}",
    hhmm: "09:00",
    next_on: "2026-11-01",
    paused_at: null,
    skipped_days: "[]",
    position: 0,
    import_id: null,
    import_source: null,
    import_utime: null,
    device_id: null,
    created_at: "x",
    updated_at: "x",
    synced_at: null,
    deleted_at: null,
  };

  test("TBL_NOUN 補了定期帳（不再印「一筆資料」）", () => {
    assert.deepEqual(TBL_NOUN.tk_repeats, { noun: "定期帳", unit: "條" });
    assert.equal(countNoun("tk_repeats", 2), "2 條定期帳");
  });

  test("列名：備註＞分類＞帳戶", () => {
    assert.equal(repeatLabel({ ...row, note: "  每月房租 " }, look), "定期帳「每月房租」");
    assert.equal(repeatLabel(row, look), "定期帳「房租」");
    assert.equal(repeatLabel({ ...row, category_id: null }, look), "定期帳「郵局」");
    assert.equal(repeatLabel({ ...row, category_id: "zz", account_id: "zz" }, look), "定期帳「沒有名字」");
  });

  test("skipped_days：日期 M/D、超過 3 天說「等 N 天」、空＝（沒有）、壞值 ⇒ null", () => {
    assert.equal(skippedDaysText('["2026-10-19","2026-10-20"]'), "10/19、10/20");
    assert.equal(skippedDaysText('["2026-10-01","2026-10-02","2026-10-03","2026-10-04","2026-10-05"]'), "10/1、10/2、10/3 等 5 天");
    assert.equal(skippedDaysText("[]"), "（沒有）");
    assert.equal(skippedDaysText("not json"), null);
    assert.equal(skippedDaysText(3), null);
  });

  test("欄名與 fmt 接進清單句", () => {
    const lab = repeatSyncLabel(row as never, look);
    assert.equal(lab.cols?.skipped_days, "刪掉的班次");
    const n = mk({ tbl: "tk_repeats", col: "skipped_days", mine: '["2026-10-19"]', theirs: '["2026-10-20"]' });
    assert.equal(describeMerge(n, lab.fmt), "這台改成「10/19」、另一台改成「10/20」——留下另一台後改的");
    assert.equal(lab.fmt?.("category_id", null), "未分類");
    assert.equal(lab.fmt?.("account_id", "gone"), "已刪除的帳戶");
    assert.equal(lab.fmt?.("paused_at", "2026-10-01T00:00:00Z"), "暫停");
    assert.equal(lab.fmt?.("amount_minor", 5), null, "不認得的欄退回核心格式");
  });
});

/* ───────── 沙盒 F-4：#101 整組寫的通知句 ───────── */

describe("F-4 排序通知：講結果不印原始數字", () => {
  const pos = (id: string, p: Partial<MergeNotice> = {}) =>
    mk({ tbl: "tk_accounts", row_id: id, col: "position", mine: 5, theirs: 0, ...p });
  test("清單句：position 不印「這台改成「5」」", () => {
    assert.equal(describeMerge(pos("a1")), "兩台都排過順序——留下另一台排的");
    assert.equal(describeMerge(pos("a2", { winner: "mine" })), "兩台都排過順序——留下這台排的");
    assert.equal(describeMerge(pos("a3", { by_me: false })), "兩台都排過順序——留下後排的那份");
    // 沙盒 F-4′：一次手勢多批整組寫 ⇒ 現值≠通知記的中間值，也不接「後來又被整理成「1」」
    assert.equal(describeMerge(pos("a4"), undefined, { changed: true, now: 1 }), "兩台都排過順序——留下另一台排的");
    assert.equal(describeMerge(pos("a5"), undefined, { gone: true }), "兩台都排過順序——留下另一台排的（後來又不在了）");
  });
  test("toast：同一表整組 position 當一件事講", () => {
    const list = ["a1", "a2", "a3", "a4"].map((id) => pos(id));
    assert.equal(mergeToastText(list, null), "帳戶的順序兩台都排過，留下後排的那份");
  });
  test("toast：混到別欄就退回逐類句", () => {
    const list = [pos("a1"), mk({ tbl: "tk_accounts", row_id: "a2", col: "name", mine: "甲", theirs: "乙" })];
    assert.equal(mergeToastText(list, null), "有 2 個帳戶兩台都改過，留下後改的");
  });
});
