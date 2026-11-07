/**
 * ExternalAgent——⑬ 外部入口的常駐代理（契約 第三、四節）。畫面上什麼都不畫，兩殼都掛（`App.tsx`）。
 *
 * - 兩端：收連結（`useExternalIntake`）。
 * - 桌機：小窗沒有 DB、沒有 store，這裡是它唯一的資料來源——今日張數＋時刻表 store＋主題算成 `PinSnapshot`，內容有變才送。
 *   另一台同步過來、MCP 改的、換日，都經過 store，不必各接一次。小窗沒開時送了也沒人收，成本只是一包小 JSON。
 * - Android：同一份資料算成 `widget_sync` 的 state（Kotlin 不碰 SQLite）。內容有變才送、去抖 1 秒；
 *   離開 App 那一刻補送一次——那正是使用者開始看小工具的時候。
 *
 * 分流看真實平台（`onAndroid()`），不看排版：拉窄的桌機視窗還是桌機。
 */
import { useEffect, useRef, useState } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { nodeRepo, MOCK_MODE } from "../../data";
import { dayCount } from "../../domain/dayCount";
import { buildPinSnapshot, buildWidgetState, type PinSnapshot } from "../../domain/pinSnapshot";
import { linkLabelOf } from "../../domain/timetableLink";
import { addDays, dayWindow } from "../../lib/date";
import { isMobileShell } from "../../lib/shell";
import { lineReportJump } from "../../lines/runtime";
import { useNodeStore } from "../../store/nodeStore";
import { useTimetableStore } from "../../store/timetableStore";
import { useUiStore } from "../../store/uiStore";
import { useTodayCount } from "../common/NavCount";
import { isTauri } from "../notes/capture-window/shell";
import { openReminderTarget } from "../reminders/openReminderTarget";
import { handleTrayAction } from "../timetable/noticeDesktop";
import { onAndroid } from "../timetable/ttNoticeBridge";
import { dayCountItem } from "../today/useTodayController";
import {
  EV_PIN_ACTION,
  EV_PIN_HELLO,
  EV_PIN_STATE,
  PIN_WINDOW,
  externalShowMain,
  noteMockSnapshot,
  widgetSync,
  type PinAction,
} from "./externalBridge";
import { useExternalIntake } from "./useExternalIntake";

const WIDGET_DEBOUNCE_MS = 1_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `<html data-theme>` 才是算好的主題（「跟隨系統」時系統一變它就變，uiStore 的 theme 只是偏好） */
function readTheme(): "light" | "dark" {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

function useResolvedTheme(): "light" | "dark" {
  const [theme, setTheme] = useState(readTheme);
  useEffect(() => {
    const mo = new MutationObserver(() => setTheme(readTheme()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    setTheme(readTheme());
    return () => mo.disconnect();
  }, []);
  return theme;
}

function runPinAction(a: PinAction): void {
  if (a === null || typeof a !== "object") return;
  const shell = isMobileShell() ? "mobile" : "desktop";
  switch (a.kind) {
    case "arrive":
    case "depart":
      handleTrayAction(a);
      return;
    case "openToday":
      void externalShowMain();
      void openReminderTarget({ kind: "today" }, shell);
      return;
    case "openTimetable":
      void externalShowMain();
      lineReportJump("timetable", "home", shell)?.();
      return;
  }
}

function PinAgent() {
  const { left } = useTodayCount();
  const todayLoaded = useNodeStore((s) => s.today.dateKey !== null);
  const ready = useTimetableStore((s) => s.ready);
  const running = useTimetableStore((s) => s.running);
  const linkInfo = useTimetableStore((s) => s.linkInfo);
  const catById = useTimetableStore((s) => s.catById);
  const categories = useTimetableStore((s) => s.categories);
  const recentIds = useTimetableStore((s) => s.recentCategoryIds);
  const pins = useTimetableStore((s) => s.noticePins);
  const theme = useResolvedTheme();
  const last = useRef<{ json: string; snap: PinSnapshot } | null>(null);

  useEffect(() => {
    // 還沒讀好就不送：小窗這時畫空殼，不閃「目前沒有列車在跑」「今日還有 0 張」
    if (!ready || !todayLoaded) return;
    const snap = buildPinSnapshot({
      theme,
      left,
      running,
      linkLabel: running ? linkLabelOf(running, linkInfo) : null,
      catById,
      categories,
      recentIds,
      pins,
    });
    const json = JSON.stringify(snap);
    if (last.current?.json === json) return;
    last.current = { json, snap };
    noteMockSnapshot(snap);
    if (!MOCK_MODE && isTauri()) void emitTo(PIN_WINDOW, EV_PIN_STATE, snap).catch((e: unknown) => console.warn("[external] 送小窗快照失敗：", e));
  }, [ready, todayLoaded, theme, left, running, linkInfo, catById, categories, recentIds, pins]);

  useEffect(() => {
    if (MOCK_MODE || !isTauri()) return;
    let alive = true;
    const off: (() => void)[] = [];
    const keep = (p: Promise<() => void>) =>
      void p.then(
        (un) => (alive ? off.push(un) : un()),
        (e: unknown) => console.warn("[external] 登記小窗事件失敗：", e),
      );
    // 小窗剛掛上：補一份（它可能比主視窗晚開，錯過了上一次送的）
    keep(
      listen(EV_PIN_HELLO, () => {
        if (last.current) void emitTo(PIN_WINDOW, EV_PIN_STATE, last.current.snap);
      }),
    );
    keep(listen<PinAction>(EV_PIN_ACTION, (ev) => runPinAction(ev.payload)));
    return () => {
      alive = false;
      for (const un of off) un();
    };
  }, []);

  return null;
}

/** 今天與明天的張數：過了日界線 App 沒開，小工具自己換成明天的數字（算法同 `mcp/tools/overview.ts`） */
async function countsNow(today: string, left: number, dayStartHour: number): Promise<{ until: number; left: number }[]> {
  const until = Date.parse(dayWindow(today, dayStartHour).end);
  const rows = await nodeRepo.listToday(addDays(today, 1), dayStartHour);
  const tomorrow = dayCount(rows.filter((r) => r.bucket === "today").map(dayCountItem)).left;
  return [
    { until, left },
    { until: until + DAY_MS, left: tomorrow },
  ];
}

function WidgetAgent() {
  const { left } = useTodayCount();
  // 看整份今日切片、不只張數：明天的張數沒有自己的訊號，今日切片重讀（改票、同步）時順便重算
  const today = useNodeStore((s) => s.today);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const ready = useTimetableStore((s) => s.ready);
  const runningCatId = useTimetableStore((s) => s.running?.category_id ?? null);
  const categories = useTimetableStore((s) => s.categories);
  const recentIds = useTimetableStore((s) => s.recentCategoryIds);
  const pins = useTimetableStore((s) => s.noticePins);
  const globalMaxMin = useTimetableStore((s) => s.longRunMaxMin);
  const lastSent = useRef<string | null>(null);

  const sendRef = useRef<() => Promise<void>>(async () => undefined);
  sendRef.current = async () => {
    if (!ready || today.dateKey === null) return;
    try {
      const counts = await countsNow(today.dateKey, left, dayStartHour);
      const state = JSON.stringify(buildWidgetState({ counts, runningCatId, categories, recentIds, pins, globalMaxMin }));
      if (state === lastSent.current) return;
      await widgetSync(state);
      lastSent.current = state;
    } catch (e) {
      console.warn("[external] 同步小工具失敗：", e); // 沒記簽章：下一次變化再試
    }
  };

  useEffect(() => {
    const t = setTimeout(() => void sendRef.current(), WIDGET_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [ready, today, left, dayStartHour, runningCatId, categories, recentIds, pins, globalMaxMin]);

  useEffect(() => {
    const onVisibility = () => void sendRef.current();
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  return null;
}

export function ExternalAgent() {
  useExternalIntake();
  return onAndroid() ? <WidgetAgent /> : <PinAgent />;
}
