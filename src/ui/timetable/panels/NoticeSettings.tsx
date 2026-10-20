/**
 * NoticeSettings——「分類與設定」面板的〈通知〉節（①b①c 契約 §5.6、D-時-30、D-時-32；①c 丁席）。
 *
 * 長相照原型情境 6（`prototypes/時刻表-src/v-e.js` manageBody 的 is-notice 那一節）：
 *   標題「通知」＋「開關只記在這台電腦／手機；釘選分類兩台一起。」→ 三個開關（各帶一行說明）→ 釘選分類：上排五格＝實際會出現的
 *   常用分類（釘選的帶 ✕、補進來的寫「最近」）、下面一排全部分類可點選釘選（帶序號）、最下面「系統匣『換車 ▸』／
 *   通知上的格子會長這樣」的預覽。手機與桌機文案不同（通知欄 vs 系統匣）。分流看真實平台（`onAndroid()`），不看排版。
 * 資料：三把開關是本地鍵、不同步；釘選分類 10-20 磨光② 起同步（D-主-40；store 的 setNotice*）；格子清單＝`noticeTiles`（與手機通知、系統匣子選單同一支）。
 * 「運行中顯示」關掉 ⇒ 常用分類格與釘選一起變灰（關掉時通知整則收掉／系統匣選單縮回「開啟／結束」，0-16）。
 * Android 另有：沒權限時「需要允許通知」（①a 原樣）、精準鬧鐘沒給時的提醒延遲說明（`ttStatus().exactAlarm`）、鎖屏說明。
 * class 寫在 timetable.css §G。
 */
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { colorSlot, leafCategories } from "../../../domain/timetable";
import { NOTICE_TILES_MAX, noticeTiles } from "../../../domain/timetableNotice";
import { askNotificationPermissionOnce } from "../../../lib/notify";
import { NOTICE_PINS_MAX, useTimetableStore } from "../../../store/timetableStore";
import { CategoryBadge } from "../CategoryBadge";
import { noticePermission, onAndroid, type NoticePermission } from "../notice";
import { ttStatus } from "../ttNoticeBridge";
import { Sub } from "./controls";

function Toggle({ on, onFlip, label, disabled = false }: { on: boolean; onFlip(): void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      className={"ns-tt-toggle" + (on ? " is-on" : "")}
      onClick={onFlip}
    >
      <span className="ns-tt-toggle-knob" aria-hidden="true" />
      <span className="ns-tt-toggle-text">{on ? "開" : "關"}</span>
    </button>
  );
}

function Setting({ title, note, dim = false, children }: { title: string; note: string; dim?: boolean; children: ReactNode }) {
  return (
    <div className={"ns-tt-setting ns-tt-nset" + (dim ? " is-dis" : "")}>
      <span className="ns-tt-nset-k">
        <span className="ns-tt-setting-k">{title}</span>
        <small className="ns-tt-nset-note">{note}</small>
      </span>
      {children}
    </div>
  );
}

export function NoticeSettings() {
  const noticeEnabled = useTimetableStore((s) => s.noticeEnabled);
  const longRunEnabled = useTimetableStore((s) => s.noticeLongRunEnabled);
  const tilesEnabled = useTimetableStore((s) => s.noticeTilesEnabled);
  const pins = useTimetableStore((s) => s.noticePins);
  const categories = useTimetableStore((s) => s.categories);
  const recentIds = useTimetableStore((s) => s.recentCategoryIds);
  const runningCatId = useTimetableStore((s) => (s.running ? s.running.category_id : null));
  const setNoticeEnabled = useTimetableStore((s) => s.setNoticeEnabled);
  const setLongRun = useTimetableStore((s) => s.setNoticeLongRunEnabled);
  const setTiles = useTimetableStore((s) => s.setNoticeTilesEnabled);
  const setPins = useTimetableStore((s) => s.setNoticePins);

  // 真實平台：Android＝OS 常駐通知（要權限、有精準鬧鐘問題）；桌機＝系統匣（不需要通知權限）
  const android = onAndroid();
  const [perm, setPerm] = useState<NoticePermission>("granted");
  const [exactAlarm, setExactAlarm] = useState(true);
  useEffect(() => {
    if (!android) return;
    let alive = true;
    void noticePermission().then((p) => {
      if (alive) setPerm(p);
    });
    void ttStatus().then((st) => {
      if (alive && st) setExactAlarm(st.exactAlarm);
    });
    return () => {
      alive = false;
    };
  }, [android]);

  const tiles = useMemo(() => noticeTiles(categories, recentIds, pins, runningCatId), [categories, recentIds, pins, runningCatId]);
  const pool = useMemo(() => leafCategories(categories), [categories]);
  const pinsOff = !noticeEnabled || !tilesEnabled;
  // 只算還看得到的釘選：封存（或所在組封存）的分類留在 noticePins 裡，但不在格子也不在下排，
  // 若照原始 pins 算「滿了」，就會擋住新的釘、又沒地方取消。動釘選時一併把看不到的濾掉（沒動釘選之前就還原，它照樣回到原來的位置）。
  const livePins = useMemo(() => pins.filter((id) => pool.some((c) => c.id === id)), [pins, pool]);
  const full = livePins.length >= NOTICE_PINS_MAX;

  const togglePin = (id: string) => {
    if (livePins.includes(id)) void setPins(livePins.filter((p) => p !== id));
    else if (!full) void setPins(livePins.concat(id));
  };

  const slots: ReactNode[] = [];
  for (let i = 0; i < NOTICE_TILES_MAX; i++) {
    const c = tiles[i];
    if (!c) {
      slots.push(<span key={"empty-" + i} className="ns-tt-pin is-empty" aria-hidden="true" />);
      continue;
    }
    const pinned = livePins.includes(c.id);
    const live = c.id === runningCatId;
    const inner = (
      <>
        {live && <span className="ns-tt-live-dot" aria-hidden="true" />}
        <CategoryBadge cat={c} size="sm" />
        <span className="ns-tt-pin-name">{c.name}</span>
        <em className="ns-tt-pin-tag">{pinned ? "✕" : "最近"}</em>
      </>
    );
    slots.push(
      pinned ? (
        <button
          key={c.id}
          type="button"
          className={"ns-tt-pin is-pinned" + (live ? " is-live" : "")}
          aria-label={`取消釘選「${c.name}」`}
          onClick={() => togglePin(c.id)}
        >
          {inner}
        </button>
      ) : (
        <span key={c.id} className={"ns-tt-pin" + (live ? " is-live" : "")}>
          {inner}
        </span>
      ),
    );
  }

  return (
    <section className="ns-tt-mgr-settings ns-tt-notice-sec">
      <h4 className="ns-tt-mgr-sec">通知</h4>
      <Sub>開關只記在這台{android ? "手機" : "電腦"}；釘選分類兩台一起。</Sub>

      <Setting
        title={android ? "運行中顯示在通知欄" : "運行中顯示在系統匣"}
        note={android ? "常駐通知：顯示計時、到着、換車；停車中也留著" : "圖示紅點、滑鼠移過看時間、右鍵到着／換車"}
      >
        <Toggle on={noticeEnabled} onFlip={() => void setNoticeEnabled(!noticeEnabled)} label="運行中顯示" />
      </Setting>
      {android && noticeEnabled && perm !== "granted" && (
        <div className="ns-tt-setting is-hint">
          <span className="ns-tt-setting-k is-warn">需要允許通知</span>
          <button
            type="button"
            className="ns-btn btn-ghost ns-btn--sm"
            onClick={() => {
              void askNotificationPermissionOnce().then((r) => {
                if (r === "granted") setPerm("granted");
                else if (r === "denied") setPerm("denied");
              });
            }}
          >
            允許通知
          </button>
        </div>
      )}

      <Setting
        title="跑太久提醒"
        note={
          android
            ? "超過預計時間就跳提醒（App 沒開也會響）"
            : "超過預估或預設長度時，跳一則 Windows 通知（同一班只跳一次；App 要開著）"
        }
      >
        <Toggle on={longRunEnabled} onFlip={() => void setLongRun(!longRunEnabled)} label="跑太久提醒" />
      </Setting>
      {android && longRunEnabled && !exactAlarm && <Sub warn>受系統限制，提醒可能會晚幾分鐘</Sub>}

      <Setting
        title="常用分類"
        note={android ? "通知下方顯示 5 個分類，點一下就換車" : "系統匣「換車 ▸」最上面的 5 個分類"}
        dim={!noticeEnabled}
      >
        <Toggle on={tilesEnabled} onFlip={() => void setTiles(!tilesEnabled)} label="常用分類" disabled={!noticeEnabled} />
      </Setting>

      <div className={"ns-tt-pins" + (pinsOff ? " is-dis" : "")} aria-disabled={pinsOff || undefined}>
        <div className="ns-tt-pins-head">
          <span className="ns-tt-setting-k">釘選分類</span>
          <small className="ns-tt-nset-note">最多 {NOTICE_PINS_MAX} 個；空位會自動放最近用過的</small>
        </div>
        <div className="ns-tt-pin-slots">{slots}</div>
        <div className="ns-tt-pin-pool">
          {pool.map((c) => {
            const idx = livePins.indexOf(c.id);
            const on = idx >= 0;
            return (
              <button
                key={c.id}
                type="button"
                className={"ns-tt-pin-cat" + (on ? " is-on" : "") + (!on && full ? " is-full" : "")}
                aria-pressed={on}
                disabled={pinsOff || (!on && full)}
                onClick={() => togglePin(c.id)}
              >
                <CategoryBadge cat={c} size="sm" />
                {c.name}
                {on && <b className="ns-tt-pin-no">{idx + 1}</b>}
              </button>
            );
          })}
        </div>
        <div className="ns-tt-pin-prev">
          <span className="ns-tt-pin-prev-k">{android ? "通知預覽" : "系統匣「換車 ▸」預覽"}</span>
          {android ? (
            <div className="ns-tt-pin-prev-nt">
              {tiles.map((c) => (
                <span
                  key={c.id}
                  className={c.id === runningCatId ? "is-on" : ""}
                  style={{ "--c": `var(--ns-tt-cat-${colorSlot(c.color_idx)})` } as CSSProperties}
                >
                  <CategoryBadge cat={c} size="sm" />
                  <em>{c.name}</em>
                </span>
              ))}
            </div>
          ) : (
            <div className="ns-tt-pin-prev-menu">
              {tiles.map((c) => (
                <span key={c.id} className={c.id === runningCatId ? "is-on" : ""}>
                  <i aria-hidden="true">{c.id === runningCatId ? "✓" : ""}</i>
                  {c.name}
                </span>
              ))}
              <hr />
              <span>
                <i aria-hidden="true" />
                全部分類 ›
              </span>
            </div>
          )}
        </div>
      </div>

      {android && <Sub>鎖定畫面的顯示內容，依手機通知設定而定</Sub>}
    </section>
  );
}
