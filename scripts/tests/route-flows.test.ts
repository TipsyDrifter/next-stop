/**
 * 手機殼班第四輪（D-主-84）：幹線／路線管理兩殼共用流程的純規則——src/ui/panel/routeFlowRules.ts。
 * 桌機 RouteDialog／RoutePanel／StationList 與手機路線圖、路線詳情頁都吃這一份；文案是桌機原本的字，這裡把它釘住（改了＝兩殼一起變）。
 * 跑法：`node --test scripts/tests/route-flows.test.ts`（node 24 型別剝除；本檔只載 routeFlowRules.ts，零依賴）。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  childRouteCount,
  codeInput,
  codeTaken,
  codeTakenByOther,
  codeTakenNote,
  codeValue,
  defaultRouteColorIndex,
  lineDeleteConfirm,
  lineDeleteNote,
  lineDeletedToast,
  lineHasCurrent,
  nextRouteAfterDelete,
  routeDeleteConfirm,
  routeDeletedToast,
  stationDeletedToast,
  type RouteLike,
} from "../../src/ui/panel/routeFlowRules.ts";

const routes: RouteLike[] = [
  { id: "r1", name: "日文", line_id: "L1", code: "J" },
  { id: "r2", name: "全端開發", line_id: "L1", code: "e1" },
  { id: "r3", name: "體能", line_id: "L3", code: null },
];

describe("新增路線表單", () => {
  test("預設色前三格輪流、不給第 4 格", () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5].map(defaultRouteColorIndex), [1, 2, 3, 1, 2, 3]);
  });

  test("代碼：打字轉大寫、最多 4 字；送出去空白、空＝null", () => {
    assert.equal(codeInput("phot9"), "PHOT");
    assert.equal(codeInput("e1"), "E1");
    assert.equal(codeValue("  ab "), "AB");
    assert.equal(codeValue("   "), null);
    assert.equal(codeValue(""), null);
  });

  test("代碼重複：不分大小寫、空字串不算；提示句帶大寫代碼", () => {
    assert.equal(codeTaken(routes, "j"), true);
    assert.equal(codeTaken(routes, "E1"), true);
    assert.equal(codeTaken(routes, "L2"), false);
    assert.equal(codeTaken(routes, "  "), false);
    assert.equal(codeTakenNote("j"), "已有其他路線使用「J」——仍可儲存，只是圖示會重複。");
  });
});

describe("編輯路線代碼（詳情頁／側板）", () => {
  test("撞到自己不算重複，撞到別條才提示", () => {
    assert.equal(codeTakenByOther(routes, "r1", "j"), false);
    assert.equal(codeTakenByOther(routes, "r1", "E1"), true);
    assert.equal(codeTakenByOther(routes, "r3", "J"), true);
    assert.equal(codeTakenByOther(routes, "r3", ""), false);
  });
});

describe("刪除幹線", () => {
  test("有路線：確認框寫明幾條、danger 鈕字「刪除」", () => {
    const n = childRouteCount(routes, "L1");
    assert.equal(n, 2);
    assert.deepEqual(lineDeleteConfirm({ id: "L1", name: "學習" }, n), {
      title: "刪除幹線「學習」？",
      body: "底下的 2 條路線與所有支線、列車、車廂、車票會一起刪除；6 秒內可復原。",
      confirmLabel: "刪除",
    });
    assert.equal(lineDeleteNote(n), "連同底下 2 條路線一起刪除；6 秒內可復原。");
  });

  test("空幹線：換一句", () => {
    assert.equal(childRouteCount(routes, "L2"), 0);
    assert.equal(lineDeleteConfirm({ id: "L2", name: "興趣" }, 0).body, "底下的所有內容會一起刪除；6 秒內可復原。");
    assert.equal(lineDeleteNote(0), "刪除這條幹線；6 秒內可復原。");
  });

  test("目前路線在這條幹線底下才要切走", () => {
    assert.equal(lineHasCurrent(routes, "L1", "r2"), true);
    assert.equal(lineHasCurrent(routes, "L3", "r2"), false);
    assert.equal(lineHasCurrent(routes, "L1", null), false);
  });

  test("toast", () => {
    assert.equal(lineDeletedToast("興趣二"), "已刪除幹線「興趣二」");
  });
});

describe("刪除路線", () => {
  test("確認框與 toast", () => {
    assert.deepEqual(routeDeleteConfirm({ id: "r9", name: "攝影" }), {
      title: "刪除路線「攝影」？",
      body: "底下的支線、列車、車票與車站會一起刪掉（6 秒內可復原）。",
      confirmLabel: "刪除路線",
    });
    assert.equal(routeDeletedToast("攝影"), "已刪除路線「攝影」");
  });

  test("刪完切到剩下的第一條，排除剛刪的那條；一條都不剩＝null", () => {
    assert.equal(nextRouteAfterDelete(routes, "r1"), "r2");
    assert.equal(nextRouteAfterDelete(routes, "r2"), "r1");
    assert.equal(nextRouteAfterDelete(routes, null), "r1");
    assert.equal(nextRouteAfterDelete([routes[0]], "r1"), null);
    assert.equal(nextRouteAfterDelete([], null), null);
  });
});

test("車站刪除 toast", () => {
  assert.equal(stationDeletedToast("第二站"), "已刪除車站「第二站」");
});
