// 自訂快捷鍵的純邏輯（⑧）：哪些鍵能改、按下去算哪一組、撞鍵、設定表進出、覆寫後查表
// 跑法：node --test scripts/tests/hotkey-rebind.test.ts（node 24 直接剝除型別）
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  HOTKEYS,
  formatChord,
  hotkeyById,
  matches,
  resolveHotkey,
  setHotkeyOverrides,
  type Chord,
} from "../../src/ui/shell/hotkeys.ts";
import { rowSlots, rowsFor } from "../../src/ui/shell/hotkeyRows.ts";
import {
  OS_HOTKEY_ID,
  OVERRIDES_KEY,
  allConflictIds,
  chordFromEvent,
  chordProblem,
  chordToAccel,
  conflictsOf,
  isRebindable,
  parseOverrides,
  sameChord,
  serializeOverrides,
  withChord,
} from "../../src/ui/shell/hotkeyRebind.ts";

const ev = (key: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean; code?: string } = {}) => ({
  key,
  code: mods.code,
  ctrlKey: !!mods.ctrl,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
  metaKey: !!mods.meta,
});

const byId = (id: string) => {
  const h = hotkeyById(id);
  assert.ok(h, id);
  return h;
};

afterEach(() => setHotkeyOverrides(new Map()));

test("預設鍵位沒有任何撞鍵（覆寫才會出現赭字）", () => {
  assert.deepEqual(allConflictIds(), []);
});

test("能改的範圍：頁面鍵與全域鍵可改；Esc 與輸入慣例不能改", () => {
  for (const id of ["today.complete", "global.quickjump", "daylist.complete", "notes.capture.global", "ticket.search"]) {
    assert.equal(isRebindable(byId(id)), true, id);
  }
  for (const id of ["notes.diary.save", "today.escape", "calendar.escape", "edit.save", "common.confirm", "search.go", "notes-capture.save", "ticket-entry.save"]) {
    assert.equal(isRebindable(byId(id)), false, id);
  }
  // 全 App 所有 Esc 都不能改
  for (const h of HOTKEYS) if (h.chords.some((c) => c.key === "Escape")) assert.equal(isRebindable(h), false, h.id);
});

test("錄鍵：字母一律小寫、修飾鍵照記；只按修飾鍵＝繼續等", () => {
  assert.deepEqual(chordFromEvent(ev("T", { shift: true })), { key: "t", shift: true });
  assert.deepEqual(chordFromEvent(ev("k", { ctrl: true, alt: true })), { key: "k", ctrl: true, alt: true });
  assert.deepEqual(chordFromEvent(ev("F2")), { key: "F2" });
  assert.equal(chordFromEvent(ev("Shift", { shift: true })), null);
  assert.equal(chordFromEvent(ev("Control", { ctrl: true })), null);
});

test("錄鍵：符號鍵的 Shift 算在字形裡，不另外記", () => {
  assert.deepEqual(chordFromEvent(ev("?", { shift: true })), { key: "?" });
  assert.deepEqual(chordFromEvent(ev("!", { shift: true })), { key: "!" });
  // 比對照樣對得上實際按鍵（?＝Shift+/）
  setHotkeyOverrides(new Map([["global.guide", [{ key: "!" }, { key: "/", ctrl: true }]]]));
  assert.equal(matches(ev("!", { shift: true }), "global.guide"), true);
});

test("錄鍵：中文輸入法開著（Process）字母從實體鍵位認；認不出就等", () => {
  assert.deepEqual(chordFromEvent(ev("Process", { code: "KeyT" })), { key: "t" });
  assert.deepEqual(chordFromEvent(ev("Process", { code: "Digit3", ctrl: true })), { key: "3", ctrl: true });
  assert.equal(chordFromEvent(ev("Process", { code: "Backquote" })), null);
});

test("錄鍵：Windows 的 Win 鍵不收，Mac 的 ⌘ 當 Ctrl", () => {
  assert.equal(chordFromEvent(ev("k", { meta: true })), null);
  assert.deepEqual(chordFromEvent(ev("k", { meta: true }), true), { key: "k", ctrl: true });
});

test("能不能用：全域鍵要帶 Ctrl／Alt（或 F 鍵），打字用的系統鍵不給", () => {
  const quick = byId("global.quickjump");
  assert.match(chordProblem(quick, 0, { key: "k" })!, /Ctrl 或 Alt/);
  assert.match(chordProblem(quick, 0, { key: "c", ctrl: true })!, /打字時要用/);
  assert.equal(chordProblem(quick, 0, { key: "k", ctrl: true }), null);
  assert.equal(chordProblem(quick, 0, { key: "k", alt: true }), null);
  assert.equal(chordProblem(quick, 0, { key: "F9" }), null);
  // 指引鍵的第一條只在沒打字時作用，可以是單鍵；第二條是輸入框裡的備援，要帶修飾鍵
  assert.equal(chordProblem(byId("global.guide"), 0, { key: "h" }), null);
  assert.match(chordProblem(byId("global.guide"), 1, { key: "h" })!, /Ctrl 或 Alt/);
  // 頁面鍵單鍵照用
  assert.equal(chordProblem(byId("today.complete"), 0, { key: "x" }), null);
  assert.match(chordProblem(byId("today.complete"), 0, { key: "F4", alt: true })!, /關閉視窗/);
});

test("能不能用：背景也能用的那組鍵要同時按兩個修飾鍵", () => {
  const os = byId(OS_HOTKEY_ID);
  assert.match(chordProblem(os, 0, { key: "n", ctrl: true })!, /兩個修飾鍵/);
  assert.match(chordProblem(os, 0, { key: "n" })!, /兩個修飾鍵/);
  assert.equal(chordProblem(os, 0, { key: "m", ctrl: true, shift: true }), null);
  assert.equal(chordProblem(os, 0, { key: "F9", alt: true, shift: true }), null);
  // 符號鍵：Rust 認不得 Ctrl+Alt+!，Ctrl+Shift+1 的 Shift 也算進字形了；先說清楚要什麼鍵，不要講成修飾鍵不夠
  assert.match(chordProblem(os, 0, { key: "!", ctrl: true })!, /字母、數字或 F 鍵/);
  assert.match(chordProblem(os, 0, { key: "+", ctrl: true, alt: true })!, /字母、數字或 F 鍵/);
  assert.match(chordProblem(os, 0, { key: "ContextMenu", ctrl: true, alt: true })!, /字母、數字或 F 鍵/);
});

test("撞鍵：同一個情境算、全域對任何情境算、不同頁面不算", () => {
  setHotkeyOverrides(new Map([["today.complete", [{ key: "t" }]]]));
  assert.deepEqual(conflictsOf("today.complete", 0).map((h) => h.id), ["today.schedule.today"]);
  assert.deepEqual(conflictsOf("today.schedule.today", 0).map((h) => h.id), ["today.complete"]);
  // 路線圖也有 T，不同頁不算
  assert.deepEqual(conflictsOf("outline.schedule.today", 0), []);
  assert.deepEqual(allConflictIds().sort(), ["today.complete", "today.schedule.today"]);

  setHotkeyOverrides(new Map([["outline.complete", [{ key: "p", ctrl: true }]]]));
  assert.deepEqual(conflictsOf("outline.complete", 0).map((h) => h.id), ["global.quickjump"]);
  assert.ok(conflictsOf("global.quickjump", 0).some((h) => h.id === "outline.complete"));

  // 串流同時查 daylist 與回今天：撞到要標
  setHotkeyOverrides(new Map([["calendar.today", [{ key: "t" }]]]));
  assert.ok(conflictsOf("calendar.today", 0).some((h) => h.id === "daylist.schedule.today"));
  assert.ok(conflictsOf("daylist.schedule.today", 0).some((h) => h.id === "calendar.today"));
});

test("覆寫後查表跟著換；原本的鍵讓出來；放寬修飾鍵不再套用", () => {
  // Space 放寬 Shift（行為存底）
  assert.equal(matches(ev(" ", { shift: true }), "today.complete"), true);
  setHotkeyOverrides(new Map([["today.complete", [{ key: "x" }]]]));
  assert.equal(resolveHotkey("today", ev("x"))?.id, "today.complete");
  assert.equal(resolveHotkey("today", ev(" ")), null);
  assert.equal(resolveHotkey("today", ev("x", { shift: true })), null);
  assert.deepEqual(byId("today.complete").chords, [{ key: "x" }]);
});

test("顯示列跟著覆寫：鍵帽與每一格對應回哪一筆", () => {
  setHotkeyOverrides(new Map([["today.move.up", [{ key: "k" }]]]));
  const row = rowsFor("today").find((r) => r.id === "today.move.up/down");
  assert.ok(row);
  const slots = rowSlots(row);
  assert.deepEqual(
    slots.map((s) => [s.id, s.index, formatChord(s.chord, false).join("+")]),
    [
      ["today.move.up", 0, "K"],
      ["today.move.down", 0, "↓"],
    ],
  );
  // 同一筆多條路：Enter／Space 各一格
  const open = rowsFor("calendar").find((r) => r.id === "calendar.open");
  assert.deepEqual(rowSlots(open!).map((s) => s.index), [0, 1]);
});

test("鍵帽：符號鍵不顯示 Shift，其他照舊", () => {
  assert.deepEqual(formatChord({ key: "!", shift: true }, false), ["!"]);
  assert.deepEqual(formatChord({ key: "t", shift: true }, false), ["Shift", "T"]);
  assert.deepEqual(formatChord({ key: "?" }, false), ["?"]);
});

test("設定表：壞資料、認不得的 id、不開放改的鍵、組數不對都丟掉", () => {
  assert.equal(parseOverrides(null).size, 0);
  assert.equal(parseOverrides("not json").size, 0);
  assert.equal(parseOverrides("[1,2]").size, 0);
  const parsed = parseOverrides(
    JSON.stringify({
      "today.complete": [{ key: "x" }],
      "no.such.id": [{ key: "x" }],
      "today.escape": [{ key: "x" }],
      "calendar.open": [{ key: "x" }], // 這筆有兩條路，只給一條
      "today.log": [{ key: 1 }],
      "today.delete": [{ key: "d", ctrl: "yes" }],
    }),
  );
  assert.deepEqual([...parsed.keys()], ["today.complete"]);
  assert.equal(serializeOverrides(parsed), '{"today.complete":[{"key":"x"}]}');
});

test("改回跟預設一樣＝不留覆寫（「改過沒」才準）", () => {
  const d = HOTKEYS.find((h) => h.id === "calendar.open")!;
  let m = withChord(new Map(), d, 1, { key: "x" });
  assert.deepEqual(m.get("calendar.open"), [{ key: "Enter" }, { key: "x" }]);
  m = withChord(m, d, 1, { key: " " });
  assert.equal(m.has("calendar.open"), false);
});

test("sameChord：字母不分大小寫、修飾鍵要一致", () => {
  const a: Chord = { key: "T", shift: true };
  assert.equal(sameChord(a, { key: "t", shift: true }), true);
  assert.equal(sameChord(a, { key: "t" }), false);
  assert.equal(sameChord({ key: "?" }, { key: "?", shift: true }), true);
});

test("全域鍵字串：Rust 那邊吃得下的格式", () => {
  assert.equal(chordToAccel({ key: "n", ctrl: true, alt: true }), "Ctrl+Alt+N");
  assert.equal(chordToAccel({ key: " ", ctrl: true, shift: true }), "Ctrl+Shift+Space");
  assert.equal(chordToAccel({ key: "F9", alt: true, shift: true }), "Alt+Shift+F9");
});

test("覆寫不同步：設定鍵不在兩端的同步白名單（D-1.1-3 螢幕偏好不同步）", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const repo = readFileSync(new URL("../../src/data/syncRepository.ts", import.meta.url), "utf8");
  assert.equal(repo.includes(OVERRIDES_KEY), false);
  const dir = new URL("../../src-tauri/src/sync/tables/", import.meta.url);
  for (const f of readdirSync(dir)) {
    assert.equal(readFileSync(new URL(f, dir), "utf8").includes(OVERRIDES_KEY), false, f);
  }
});

test("全域鍵的 id 跟旅客筆記殼層同一筆", async () => {
  const { readFileSync } = await import("node:fs");
  const shell = readFileSync(new URL("../../src/ui/notes/capture-window/shell.ts", import.meta.url), "utf8");
  assert.match(shell, new RegExp(`HOTKEY_ID = "${OS_HOTKEY_ID.replace(/\./g, "\\.")}"`));
});
