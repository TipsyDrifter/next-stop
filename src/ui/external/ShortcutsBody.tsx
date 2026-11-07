/**
 * ShortcutsBody——「捷徑與小工具」的本體（⑬ 外部入口；契約 開頭、第五節；長相＝prototypes/外部入口.html 第 4 節）。
 * 兩殼同一份：桌機設定同名一籤（SettingsPanel）、手機「更多 › 捷徑與小工具」（MobileMore）。
 *
 * 內容看**真實平台**（小窗只有桌機、小工具與貼紙只有手機；拉窄的桌機視窗還是桌機），排版看 `data-shell`（CSS 自己認）。
 * `?mock=1` 沒有 Android：手機殼寬度就畫手機那一份，桌機瀏覽器才看得到。
 * 即選即存，沒有主鈕；唯一的主鈕是手機的「寫入貼紙」（視覺規範 §2.3）。列的排版借提醒頁的 `.ns-rm-row*`。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { MOCK_MODE } from "../../data";
import { arriveLink, categoryLink, todayLink } from "../../domain/externalLink";
import { leafCategories, type TimeCategoryRow } from "../../domain/timetable";
import { isMobileShell } from "../../lib/shell";
import { useTimetableStore } from "../../store/timetableStore";
import { useUiStore } from "../../store/uiStore";
import { MSheet } from "../common/MSheet";
import { Toggle } from "../common/Toggle";
import { CategoryBadge } from "../timetable/CategoryBadge";
import { onAndroid } from "../timetable/ttNoticeBridge";
import {
  externalScheme,
  nfcCancel,
  nfcOpenSettings,
  nfcStatus,
  nfcWrite,
  onPinVisibility,
  pinSetOnTop,
  pinSetVisible,
  pinStatus,
  widgetPin,
  widgetStatus,
  type NfcStatus,
  type NfcWriteError,
  type PinStatus,
  type WidgetStatus,
} from "./externalBridge";
import "../reminders/reminders.css";
import "./external.css";

const COPIED_MS = 1_600;
/** 手機寫貼紙用：貼紙會帶到別台手機碰，連結固定正式版的 scheme（手機本來就只有這一個） */
const STICKER_SCHEME = "nextstop";

const NFC_ERROR_TEXT: Record<Exclude<NfcWriteError, "cancelled">, string> = {
  readonly: "這張貼紙不能寫入",
  too_small: "這張貼紙容量不夠",
  not_ndef: "這張貼紙的格式不能寫",
  io: "沒寫好，再靠近一次",
  no_nfc: "這支手機沒有 NFC",
};

function Row({ title, sub, children }: { title: React.ReactNode; sub?: string; children?: React.ReactNode }) {
  return (
    <div className="ns-rm-row">
      <span className="ns-rm-row-tx">
        <span className="ns-rm-row-t">{title}</span>
        {sub && <small className="ns-rm-row-w">{sub}</small>}
      </span>
      {children && <span className="ns-sc-act">{children}</span>}
    </div>
  );
}

function Group({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <section className="ns-sc-grp" aria-label={name}>
      <span className="techo-label ns-sc-grp-k" aria-hidden="true">
        {name}
      </span>
      <div className="ns-sc-rows">{children}</div>
    </section>
  );
}

/** 複製鈕：按下字換「已複製」1.6 秒（同〈外部助理〉籤，不另開 toast）；複製不了才 toast */
function CopyButton({ link, label, disabled }: { link: (scheme: string) => string | null; label: string; disabled?: boolean }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = async () => {
    try {
      const url = link(await externalScheme());
      if (url === null) return;
      await navigator.clipboard.writeText(url);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPIED_MS);
    } catch (e) {
      console.warn("[external] 複製連結失敗：", e);
      useUiStore.getState().showToast({ message: "複製不了" });
    }
  };
  return (
    <button type="button" className="btn-ghost ns-btn ns-btn--sm" aria-label={label} disabled={disabled} onClick={() => void copy()}>
      {copied ? "已複製" : "複製"}
    </button>
  );
}

function CategoryPick({ cats, value, onChange }: { cats: readonly TimeCategoryRow[]; value: TimeCategoryRow | null; onChange(id: string): void }) {
  if (value === null) return <span className="ns-note">還沒有分類</span>;
  return (
    <span className="ns-sc-pick">
      <CategoryBadge cat={value} size="sm" />
      <span className="ns-select-wrap ns-rm-numwrap">
        <select className="techo-input ns-rm-num" aria-label="分類" value={value.id} onChange={(e) => onChange(e.target.value)}>
          {cats.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </span>
    </span>
  );
}

/** 分類下拉（發車連結與貼紙共用同一個選擇）：選的分類被刪了就退回第一個 */
function useCategoryPick(): { cats: TimeCategoryRow[]; cat: TimeCategoryRow | null; setId(id: string): void } {
  const categories = useTimetableStore((s) => s.categories);
  const cats = useMemo(() => leafCategories(categories), [categories]);
  const [id, setId] = useState<string | null>(null);
  return { cats, cat: cats.find((c) => c.id === id) ?? cats[0] ?? null, setId };
}

/* ───────── 連結（兩端一樣） ───────── */

function LinkRows({ pick, cat, cats, setId }: { pick: boolean; cat: TimeCategoryRow | null; cats: readonly TimeCategoryRow[]; setId(id: string): void }) {
  return (
    <Group name="連結">
      <Row title="発車連結" sub="可以放進捷徑或別的工具">
        {pick && <CategoryPick cats={cats} value={cat} onChange={setId} />}
        <CopyButton label="複製発車連結" disabled={cat === null} link={(s) => (cat ? categoryLink(s, cat.id, cat.name) : null)} />
      </Row>
      <Row title="到着連結">
        <CopyButton label="複製到着連結" link={arriveLink} />
      </Row>
      <Row title="今日連結">
        <CopyButton label="複製今日連結" link={todayLink} />
      </Row>
    </Group>
  );
}

/* ───────── 桌機 ───────── */

function DesktopBody() {
  const [status, setStatus] = useState<PinStatus>({ visible: false, onTop: true });
  const { cats, cat, setId } = useCategoryPick();

  useEffect(() => {
    let alive = true;
    void pinStatus().then(
      (s) => {
        if (alive) setStatus(s);
      },
      (e: unknown) => console.warn("[external] 問小窗狀態失敗：", e),
    );
    let unlisten: (() => void) | null = null;
    void onPinVisibility((s) => setStatus(s)).then((un) => {
      if (alive) unlisten = un;
      else un();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  const apply = (p: Promise<PinStatus>) =>
    void p.then(setStatus, (e: unknown) => {
      console.warn("[external] 小窗沒動：", e);
      useUiStore.getState().showToast({ message: "桌面小窗打不開" });
    });

  return (
    <>
      <Group name="桌面小窗">
        <Row title="顯示桌面小窗" sub="位置會記住，下次開機照舊">
          <Toggle on={status.visible} onFlip={() => apply(pinSetVisible(!status.visible))} label="顯示桌面小窗" />
        </Row>
        <Row title="永遠在最上層">
          <Toggle on={status.onTop} onFlip={() => apply(pinSetOnTop(!status.onTop))} label="永遠在最上層" />
        </Row>
      </Group>
      <LinkRows pick cat={cat} cats={cats} setId={setId} />
      <Group name="NFC 貼紙">
        <Row title="只有手機能碰；桌機請用連結" />
      </Group>
    </>
  );
}

/* ───────── 手機 ───────── */

/** 問一次，回前景再問一次：使用者可能剛從系統設定回來、或剛在桌面加了小工具 */
function useForegroundValue<T>(read: () => Promise<T>): T | null {
  const [value, setValue] = useState<T | null>(null);
  const readRef = useRef(read);
  readRef.current = read;
  useEffect(() => {
    let alive = true;
    const check = () => {
      if (document.visibilityState === "hidden") return;
      void readRef.current().then((v) => {
        if (alive) setValue(v);
      });
    };
    check();
    document.addEventListener("visibilitychange", check);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", check);
    };
  }, []);
  return value;
}

function WidgetRow() {
  const status: WidgetStatus | null = useForegroundValue(widgetStatus);
  const add = async () => {
    try {
      if (!(await widgetPin())) useUiStore.getState().showToast({ message: "從桌面長按加入" });
    } catch (e) {
      console.warn("[external] 加小工具失敗：", e);
      useUiStore.getState().showToast({ message: "從桌面長按加入" });
    }
  };
  if (status === null) return <Row title="加到主畫面" />;
  if (!status.supported) return <Row title="加到主畫面" sub="從桌面長按加入" />;
  return (
    <Row title="加到主畫面" sub={status.installed > 0 ? `已經加了 ${status.installed} 個` : "也可以從桌面長按加入"}>
      <button type="button" className="btn-ghost ns-btn ns-btn--sm" onClick={() => void add()}>
        加入
      </button>
    </Row>
  );
}

/** 開著就在等貼紙：一次寫入一次嘗試，失敗留在這裡讓人再試 */
function NfcWriteSheet({ cat, onClose }: { cat: TimeCategoryRow; onClose(): void }) {
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<Exclude<NfcWriteError, "cancelled"> | null>(null);

  useEffect(() => {
    let active = true;
    let waiting = false;
    // 晚一拍才開始：StrictMode 的掛→清→掛不會讓 Kotlin 開兩次 reader mode
    const t = setTimeout(() => {
      waiting = true;
      nfcWrite(categoryLink(STICKER_SCHEME, cat.id, cat.name)).then(
        () => {
          waiting = false;
          if (!active) return;
          useUiStore.getState().showToast({ message: `寫好了：${cat.name}` });
          onClose();
        },
        (code: NfcWriteError) => {
          waiting = false;
          if (active && code !== "cancelled") setError(code);
        },
      );
    }, 0);
    return () => {
      active = false;
      clearTimeout(t);
      if (waiting) void nfcCancel();
    };
    // attempt：再試一次＝重跑這段；onClose 每次 render 都是新的，不該讓它重開一次寫入
  }, [attempt, cat.id, cat.name]);

  // 退背景時 Kotlin 把 reader mode 收掉了（NsNfc 的註解有為什麼）：回前景要重開，畫面寫「靠近貼紙」才是真的在等。
  // 有錯誤時不重開：畫面在講上一次為什麼失敗，由「再試一次」決定
  useEffect(() => {
    if (error) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") setAttempt((n) => n + 1);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [error]);

  return (
    <MSheet
      title={error ? NFC_ERROR_TEXT[error] : "把手機靠近貼紙"}
      onClose={onClose}
      foot={
        <>
          <button type="button" className="btn-ghost ns-btn" onClick={onClose}>
            取消
          </button>
          {error && error !== "no_nfc" && (
            <button
              type="button"
              className="btn-seal ns-btn"
              onClick={() => {
                setError(null);
                setAttempt((n) => n + 1);
              }}
            >
              再試一次
            </button>
          )}
        </>
      }
    >
      <div className="ns-sc-nfc">
        <span className={"ns-sc-nfc-ic" + (error ? " is-err" : "")} aria-hidden="true">
          ⌁
        </span>
        <p className="ns-note">寫入「{cat.name}」発車</p>
      </div>
    </MSheet>
  );
}

function PhoneBody() {
  const { cats, cat, setId } = useCategoryPick();
  const nfc: NfcStatus | null = useForegroundValue(nfcStatus);
  const [writing, setWriting] = useState(false);
  const canWrite = nfc !== null && nfc.hardware && nfc.enabled;

  return (
    <>
      <Group name="主畫面小工具">
        <WidgetRow />
      </Group>
      <Group name="NFC 貼紙">
        {nfc === null ? (
          <Row title="NFC 貼紙" />
        ) : !nfc.hardware ? (
          <Row title="這支手機沒有 NFC" sub="可以用連結" />
        ) : !nfc.enabled ? (
          <Row title="NFC 關著">
            <button type="button" className="btn-ghost ns-btn ns-btn--sm" onClick={() => void nfcOpenSettings()}>
              開 NFC 設定
            </button>
          </Row>
        ) : (
          <Row title={<CategoryPick cats={cats} value={cat} onChange={setId} />} sub="碰一下発車，再碰一下到着">
            <button type="button" className="btn-seal ns-btn ns-btn--sm" disabled={cat === null} onClick={() => setWriting(true)}>
              寫入貼紙
            </button>
          </Row>
        )}
      </Group>
      {/* 貼紙那一列沒有下拉時（沒有 NFC），分類改選在連結這裡 */}
      <LinkRows pick={!canWrite} cat={cat} cats={cats} setId={setId} />
      {writing && cat && <NfcWriteSheet cat={cat} onClose={() => setWriting(false)} />}
    </>
  );
}

export function ShortcutsBody() {
  const phone = onAndroid() || (MOCK_MODE && isMobileShell());
  // 分類表在時刻表 store：代理一開 App 就 init，這裡只是保險（直接開設定、代理還沒跑完）
  useEffect(() => {
    void useTimetableStore
      .getState()
      .init(isMobileShell() ? "mobile" : "desktop")
      .catch((e: unknown) => console.warn("[external] 讀分類失敗：", e));
  }, []);
  return <div className="ns-rm ns-sc">{phone ? <PhoneBody /> : <DesktopBody />}</div>;
}
