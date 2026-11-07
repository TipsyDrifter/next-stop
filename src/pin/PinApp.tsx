/**
 * PinApp——桌面小窗（⑬ 外部入口；契約 第三節；長相＝prototypes/外部入口.html 第 1 節甲「票根卡」）。
 *
 * 小窗只畫快照、只回傳動作：`pin:hello` 要一份、`pin:state` 收快照、`pin:action` 叫主視窗做事（到着発車走 `handleTrayAction`）。
 * 字串與形狀跟 `ui/external/externalBridge.ts` 一致；那支帶 store 不能 import，這裡只拿型別。
 *
 * 效能守則（照 ClaudeUsageMonitor 教訓）：沒有無限動畫、沒有常駐 transition、圓點靜態；
 * 經過時間每分鐘對齊整分更新一次，頁面 hidden 就停、回來補一次。
 *
 * 拖曳：背景掛 `data-tauri-drag-region`。左半邊既能點（開時刻表）也要能拖，內建的拖曳區一按就進系統拖曳、收不到 click，
 * 所以左半邊自己判斷：按下移動超過門檻才 `startDragging`，沒動就算點。
 *
 * 瀏覽器 `pin.html?mock=1&state=run|idle&theme=dark&open=1&tools=1&long=1&empty=1` 用假資料畫（截圖用）、不呼叫 Tauri。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { PinSnapshot, PinTile } from "../domain/pinSnapshot";
import { fmtElapsed, msToNextMinute } from "./pinTime";

type PinAction = { kind: "arrive" } | { kind: "depart"; categoryId: string } | { kind: "openToday" } | { kind: "openTimetable" };

const query = new URLSearchParams(typeof location !== "undefined" ? location.search : "");
const MOCK = query.get("mock") === "1";
const TAURI = !MOCK && typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
if (MOCK) {
  document.documentElement.classList.add("is-pin-mock");
  if (query.get("theme") === "dark") document.documentElement.setAttribute("data-theme", "dark");
}

/** 左半邊：移動超過這麼多才算拖，手抖不會把點擊吃掉 */
const DRAG_PX = 4;

function warn(what: string): (e: unknown) => void {
  return (e) => console.warn(`[pin] ${what}失敗：`, e);
}

/* ───────── 假資料 ───────── */

const MOCK_TILES: PinTile[] = [
  { categoryId: "c2", name: "學習", glyph: "學", colorLight: "#964468", colorDark: "#e6a8c0" },
  { categoryId: "c3", name: "運動", glyph: "運", colorLight: "#326b4b", colorDark: "#a6c9ad" },
  { categoryId: "c4", name: "家事", glyph: "家", colorLight: "#8a5a2b", colorDark: "#d9b98a" },
  { categoryId: "c5", name: "閱讀", glyph: "讀", colorLight: "#2f6f86", colorDark: "#95c6d6" },
];

function mockSnapshot(running: boolean): PinSnapshot {
  return {
    theme: query.get("theme") === "dark" ? "dark" : "light",
    left: Number(query.get("left") ?? 5),
    running: running
      ? {
          name: "創作",
          ticket: query.get("long") === "1" ? "寫第三章大綱，順便把前兩章的伏筆再整理一次" : "寫第三章大綱",
          glyph: "創",
          colorLight: "#4757a6",
          colorDark: "#a9c0ea",
          startedAt: Date.now() - 80 * 60_000,
          startedLabel: "14:35 発",
        }
      : null,
    tiles: MOCK_TILES,
  };
}

/* ───────── 經過時間 ───────── */

function useElapsed(startedAt: number | null): string {
  const [, bump] = useState(0);
  useEffect(() => {
    if (startedAt === null) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stop = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const arm = () => {
      stop();
      timer = setTimeout(() => {
        bump((n) => n + 1);
        arm();
      }, msToNextMinute(Date.now()));
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") stop();
      else {
        bump((n) => n + 1);
        arm();
      }
    };
    if (document.visibilityState !== "hidden") arm();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [startedAt]);
  return startedAt === null ? "" : fmtElapsed(Date.now() - startedAt);
}

/* ───────── 左半邊：能點也能拖 ───────── */

function useTapOrDrag(onTap: () => void) {
  const down = useRef<{ x: number; y: number; id: number } | null>(null);
  const dragged = useRef(false);
  return {
    onPointerDown(e: ReactPointerEvent<HTMLElement>) {
      if (e.button !== 0) return;
      dragged.current = false;
      down.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove(e: ReactPointerEvent<HTMLElement>) {
      const d = down.current;
      if (!d || d.id !== e.pointerId) return;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_PX) return;
      down.current = null;
      dragged.current = true;
      // OS 拖曳會吃掉 pointerup，capture 留著的話下一次點到按鈕也會派給左半邊
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // 已經放掉了（指標不在了）：正是要的結果
      }
      if (TAURI) void getCurrentWindow().startDragging().catch(warn("拖曳"));
    },
    onPointerUp() {
      if (down.current && !dragged.current) onTap();
      down.current = null;
    },
    onPointerCancel() {
      down.current = null;
    },
  };
}

/* ───────── 畫面 ───────── */

function Tile({ tile, theme, small, dot }: { tile: Pick<PinTile, "glyph" | "colorLight" | "colorDark">; theme: "light" | "dark"; small?: boolean; dot?: boolean }) {
  const style: CSSProperties = { background: theme === "dark" ? tile.colorDark : tile.colorLight };
  return (
    <span className={"pin-tile" + (small ? " is-sm" : "")} style={style}>
      {tile.glyph}
      {dot && <i className="pin-dot" />}
    </span>
  );
}

export function PinApp() {
  const [snap, setSnap] = useState<PinSnapshot | null>(() =>
    MOCK && query.get("empty") !== "1" ? mockSnapshot(query.get("state") !== "idle") : null,
  );
  const [open, setOpen] = useState(MOCK && query.get("open") === "1");
  const [onTop, setOnTop] = useState(true);
  const cardRef = useRef<HTMLDivElement>(null);

  const startedAt = snap?.running?.startedAt ?? null;
  const elapsed = useElapsed(startedAt);
  const theme = snap?.theme ?? (document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light");

  // 接主視窗：先登記再要快照，主視窗回得再快也接得到
  useEffect(() => {
    if (!TAURI) return;
    let alive = true;
    const off: (() => void)[] = [];
    const keep = (un: () => void) => (alive ? off.push(un) : un());
    void listen<PinSnapshot>("pin:state", (ev) => setSnap(ev.payload))
      .then((un) => {
        keep(un);
        return emit("pin:hello");
      })
      .catch(warn("接主視窗"));
    void listen<{ visible: boolean; onTop: boolean }>("pin:visibility", (ev) => setOnTop(ev.payload.onTop))
      .then(keep)
      .catch(warn("聽置頂"));
    void invoke<{ onTop: boolean }>("pin_status")
      .then((s) => {
        if (alive) setOnTop(s.onTop);
      })
      .catch(warn("問置頂"));
    return () => {
      alive = false;
      for (const un of off) un();
    };
  }, []);

  // 主題跟快照走（開頁腳本只管第一眼）
  useLayoutEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // 換了班就收起格子：剛按完換車，格子不該還開著
  useEffect(() => {
    if (!MOCK) setOpen(false);
  }, [startedAt]);

  // 視窗高跟著內容（展開常用分類格）；寬是固定的。Rust 夾 [60, 240]
  useEffect(() => {
    const el = cardRef.current;
    if (!el || !TAURI) return;
    let last = 0;
    const fit = () => {
      const h = Math.ceil(el.getBoundingClientRect().height);
      if (h === last) return;
      last = h;
      void invoke("pin_fit", { height: h }).catch(warn("調高度"));
    };
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    fit();
    return () => ro.disconnect();
  }, []);

  const act = useCallback((a: PinAction) => {
    if (TAURI) {
      void emit("pin:action", a).catch(warn("送動作"));
      return;
    }
    // mock：自己把畫面變過去，看得到按下去的結果
    console.info("[pin] action（mock）", a);
    if (a.kind === "arrive") setSnap((s) => (s ? { ...mockSnapshot(false), left: s.left } : s));
    if (a.kind === "depart") setSnap((s) => (s ? { ...mockSnapshot(true), left: s.left } : s));
    if (a.kind === "arrive" || a.kind === "depart") setOpen(false);
  }, []);

  const toggleOnTop = () => {
    const next = !onTop;
    setOnTop(next);
    if (TAURI) void invoke("pin_set_on_top", { onTop: next }).catch(warn("切置頂"));
  };
  const close = () => {
    if (TAURI) void invoke("pin_set_visible", { visible: false }).catch(warn("收起"));
  };

  const running = snap?.running ?? null;
  const left = useTapOrDrag(() => act({ kind: "openTimetable" }));

  return (
    <div
      ref={cardRef}
      className={"pin-card" + (MOCK && query.get("tools") === "1" ? " is-tools" : "")}
      data-tauri-drag-region
    >
      <div className="pin-tools">
        <button type="button" className={"pin-tool" + (onTop ? " is-on" : "")} title={onTop ? "取消置頂" : "置頂"} aria-pressed={onTop} onClick={toggleOnTop}>
          ⚲
        </button>
        <button type="button" className="pin-tool" title="收起" onClick={close}>
          ✕
        </button>
      </div>

      <div className="pin-top" data-tauri-drag-region>
        {snap && (
          <button type="button" className="pin-left" title="開時刻表" {...left}>
            {running ? (
              <>
                <Tile tile={running} theme={theme} dot />
                <span className="pin-main">
                  <span className="pin-l1">
                    {running.name}
                    {running.ticket && <small>・{running.ticket}</small>}
                  </span>
                  <span className="pin-l2">
                    <span>{running.startedLabel}</span>
                    <b>{elapsed}</b>
                  </span>
                </span>
              </>
            ) : (
              <span className="pin-main">
                <span className="pin-l1 is-idle">目前沒有列車在跑</span>
              </span>
            )}
          </button>
        )}
        {snap &&
          (running ? (
            <button type="button" className="pin-btn is-primary" onClick={() => act({ kind: "arrive" })}>
              到着
            </button>
          ) : (
            <button type="button" className="pin-btn is-primary" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              発車 {open ? "▴" : "▾"}
            </button>
          ))}
      </div>

      <div className="pin-foot" data-tauri-drag-region>
        {snap && (
          <button type="button" className="pin-count" title="開今日" onClick={() => act({ kind: "openToday" })}>
            今日還有 <b>{snap.left}</b> 張
          </button>
        )}
        {snap && running && (
          <button type="button" className="pin-btn is-text" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            換車 {open ? "▴" : "▾"}
          </button>
        )}
      </div>

      {snap && open && (
        <div className="pin-tiles" data-tauri-drag-region>
          {snap.tiles.length === 0 ? (
            <button type="button" className="pin-btn is-text" onClick={() => act({ kind: "openTimetable" })}>
              還沒有分類
            </button>
          ) : (
            snap.tiles.map((t) => (
              <button
                key={t.categoryId}
                type="button"
                className="pin-tilebtn"
                title={t.name}
                aria-label={`${running ? "換車" : "発車"}：${t.name}`}
                onClick={() => act({ kind: "depart", categoryId: t.categoryId })}
              >
                <Tile tile={t} theme={theme} small />
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
