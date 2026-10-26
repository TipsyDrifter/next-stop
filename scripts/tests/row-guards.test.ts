/**
 * 路線樹一列的停用理由——桌機大綱 ⋯ 與手機路線圖 ⋯ sheet 同一把尺（手機殼班 D-主-71／72；src/ui/outline/rowGuards.ts）。
 * 跑法：`node --test scripts/tests/row-guards.test.ts`（node 24，型別剝除；只載 rowGuards.ts 與 domain/node.ts，兩檔零 store 依賴）。
 *
 * `siblingsOf`／`adaptKind` 正本在 nodeStore（會連帶載 repository），rowGuards 由呼叫端注入；
 * 這裡照 nodeStore 的寫法放兩支替身（只為了餵 rowGuards，不是要測它們本身）。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  DESKTOP_GUARD_WORDS,
  MOBILE_GUARD_WORDS,
  rowGuards,
  type GuardTree,
  type RowGuardDeps,
} from "../../src/ui/outline/rowGuards.ts";
import { allowedChildKinds, type NodeKind, type NodeRow } from "../../src/domain/node.ts";

const deps: RowGuardDeps = {
  siblingsOf(tree, routeId, id) {
    const node = tree.byId[id];
    if (!node) return { siblings: [], index: -1 };
    const siblings =
      node.parent_id && node.parent_id !== routeId && tree.byId[node.parent_id] ? (tree.childrenOf[node.parent_id] ?? []) : tree.roots;
    return { siblings, index: siblings.indexOf(id) };
  },
  adaptKind(kind, newParentKind) {
    const allowed = allowedChildKinds(newParentKind);
    if (allowed.includes(kind)) return kind;
    if (kind === "car" && allowed.includes("train")) return "train";
    if (kind === "train" && allowed.includes("car")) return "car";
    return null;
  },
};

const R = "route-1";
const node = (id: string, kind: NodeKind, parent: string): NodeRow => ({ id, kind, parent_id: parent }) as unknown as NodeRow;

/**
 * 路線 R：
 *   T1 列車 ⊃ C1 車廂 ⊃ a 車票、b 車票
 *           ⊃ c 車票
 *   B1 支線 ⊃ T2 列車
 *   s 車站
 */
function tree(): GuardTree {
  const rows = [
    node("T1", "train", R),
    node("C1", "car", "T1"),
    node("a", "ticket", "C1"),
    node("b", "ticket", "C1"),
    node("c", "ticket", "T1"),
    node("B1", "branch", R),
    node("T2", "train", "B1"),
    node("s", "station", R),
  ];
  return {
    byId: Object.fromEntries(rows.map((r) => [r.id, r])),
    childrenOf: { T1: ["C1", "c"], C1: ["a", "b"], B1: ["T2"] },
    roots: ["T1", "B1", "s"],
  };
}

const g = (id: string, zoomId: string | null = null, words = MOBILE_GUARD_WORDS) => rowGuards(tree(), R, zoomId, id, deps, words);

describe("降層", () => {
  test("兄弟中第一個：上面沒有可以掛靠的節點", () => {
    assert.equal(g("a")?.indentWhy, "上面沒有可以掛靠的節點");
  });
  test("上一個是車票：車票／車站底下不能掛東西", () => {
    assert.equal(g("b")?.indentWhy, "車票／車站底下不能掛東西");
  });
  test("車票掛到車廂底下可以（c 的上一個是 C1）", () => {
    assert.equal(g("c")?.indentWhy, null);
  });
  test("支線掛到列車底下：種類換不過去", () => {
    assert.equal(g("B1")?.indentWhy, "這種節點不能掛在那裡");
  });
  test("車站上一個是支線：車站掛不進支線", () => {
    assert.equal(g("s")?.indentWhy, "這種節點不能掛在那裡");
  });
});

describe("升層", () => {
  test("路線最上層：兩殼各自的「移動到…」句", () => {
    assert.equal(g("T1")?.outdentWhy, MOBILE_GUARD_WORDS.routeTop);
    assert.equal(g("T1", null, DESKTOP_GUARD_WORDS)?.outdentWhy, "已經在路線最上層——要換路線，用下面的「移動到…」");
  });
  test("聚焦範圍頂層：兩殼各自的退出聚焦句", () => {
    assert.equal(g("a", "C1")?.outdentWhy, MOBILE_GUARD_WORDS.zoomTop);
    assert.equal(g("a", "C1", DESKTOP_GUARD_WORDS)?.outdentWhy, "已到聚焦範圍的頂層——先按 Esc 退出聚焦再升層");
  });
  test("車票從車廂升到列車底下可以；車票升到路線直屬不行", () => {
    assert.equal(g("a")?.outdentWhy, null);
    assert.equal(g("c")?.outdentWhy, "這種節點不能升到那一層");
  });
  test("車廂升到路線直屬：會換成列車（adaptKind）＝可以", () => {
    assert.equal(g("C1")?.outdentWhy, null);
  });
});

describe("新增車票、上移、下移", () => {
  test("列車／車廂／車票可以；支線、車站不行（同一句）", () => {
    assert.equal(g("T1")?.ticketWhy, null);
    assert.equal(g("C1")?.ticketWhy, null);
    assert.equal(g("a")?.ticketWhy, null);
    assert.equal(g("B1")?.ticketWhy, "支線底下不能直接掛車票——先建一班列車");
    assert.equal(g("s")?.ticketWhy, "支線底下不能直接掛車票——先建一班列車");
  });
  test("到頂／到底", () => {
    assert.deepEqual([g("T1")?.upWhy, g("T1")?.downWhy], ["已經在最上面", null]);
    assert.deepEqual([g("s")?.upWhy, g("s")?.downWhy], [null, "已經在最下面"]);
    assert.deepEqual([g("T2")?.upWhy, g("T2")?.downWhy], ["已經在最上面", "已經在最下面"]);
  });
  test("不在樹上＝null", () => {
    assert.equal(g("nope"), null);
  });
});

test("兩殼只差兩句到頂的話", () => {
  const keys = Object.keys(DESKTOP_GUARD_WORDS).sort();
  assert.deepEqual(Object.keys(MOBILE_GUARD_WORDS).sort(), keys);
  for (const k of keys as (keyof typeof DESKTOP_GUARD_WORDS)[]) assert.notEqual(DESKTOP_GUARD_WORDS[k], MOBILE_GUARD_WORDS[k]);
});
