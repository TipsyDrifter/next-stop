/**
 * 己-2 A3（D-主-411）：ManagerRow 的 ⋯ 怎麼排——上移／下移從列尾收進來之後的順序、撕線、停用。
 * 跑法：`node --test scripts/tests/manager-row-menu.test.ts`（node 24，型別剝除；零依賴）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { rowMenu } = await import("../../src/ui/common/managerRowMenu.ts");

type Item = Parameters<typeof rowMenu>[0]["menu"][number];
const it = (key: string, extra: Partial<Item> = {}): Item => ({ key, label: key, onSelect: () => undefined, ...extra });
const shape = (xs: readonly Item[]) => xs.map((x) => `${x.cut ? "|" : ""}${x.key}${x.disabled ? "(off)" : ""}`);
const noop = () => undefined;

test("一般動作在前、上移下移在中、收尾動作（第一個帶撕線或赭字的起）在後", () => {
  const menu = [it("addsub"), it("move"), it("archive", { cut: true })];
  assert.deepEqual(shape(rowMenu({ menu, detail: null, onUp: noop, onDown: noop })), ["addsub", "move", "|ns-mgr-up", "ns-mgr-down", "|archive"]);
});

test("有展開區：「更多設定…」永遠第一項；沒有其他一般動作也一樣", () => {
  const detail = it("ns-mgr-detail");
  assert.deepEqual(shape(rowMenu({ menu: [it("archive", { cut: true })], detail, onUp: noop, onDown: noop })), [
    "ns-mgr-detail",
    "|ns-mgr-up",
    "ns-mgr-down",
    "|archive",
  ]);
});

test("排在最前面時不畫撕線；邊界那一項停用並帶原因", () => {
  const out = rowMenu({ menu: [], detail: null, onDown: noop });
  assert.deepEqual(shape(out), ["ns-mgr-up(off)", "ns-mgr-down"]);
  assert.equal(out[0].why, "已經在最上面");
  assert.equal(out[0].caps, "Alt+↑");
  assert.equal(out[1].caps, "Alt+↓");
});

test("兩邊都不給＝這一列不排序（封存、固定在最後、只有一列）：不出上移下移，menu 空就整個空（不畫 ⋯）", () => {
  assert.deepEqual(rowMenu({ menu: [], detail: null }), []);
  assert.deepEqual(shape(rowMenu({ menu: [it("unarchive"), it("delete", { danger: true })], detail: null })), ["unarchive", "delete"]);
});

test("收尾只帶赭字、沒帶撕線 ⇒ 補一道跟排序分開；不改呼叫端的原物件", () => {
  const del = it("delete", { danger: true });
  const out = rowMenu({ menu: [it("use"), del], detail: null, onUp: noop, onDown: noop });
  assert.deepEqual(shape(out), ["use", "|ns-mgr-up", "ns-mgr-down", "|delete"]);
  assert.equal(del.cut, undefined);
});

test("上移下移的 onSelect 呼叫給進來的那一支", () => {
  const calls: string[] = [];
  const out = rowMenu({ menu: [], detail: null, onUp: () => calls.push("up"), onDown: () => calls.push("down") });
  out[0].onSelect();
  out[1].onSelect();
  assert.deepEqual(calls, ["up", "down"]);
});
