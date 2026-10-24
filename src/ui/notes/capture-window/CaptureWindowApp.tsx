/**
 * CaptureWindowApp——捕捉小窗（階段⑤）的根元件（契約 §4.3；§0-0 定案 0-1／0-2／0-5 覆蓋原文）。
 *
 * 小窗是另一個 JS context：store 各自一份，所以這裡自己載它要的東西（0-11）——設定（主題、日界線）、路線清單、荷札 index；
 * 別線的票根靠 `lines/mounts` 求值時的 `installLineMounts`（跟主視窗同一份掛點表）。DB 走 `getDb()` 的附著分支（db.ts，不 load）。
 * 不做：useGlobalHotkeys、sync／backup boot、SkyLayer、側欄、任何頁。不包 StrictMode（main.tsx）。
 *
 * 畫面＝`NotesDesktopOverlay`（CaptureOverlay／TodoPreviewDialog，一個字不改）＋`Toast`，暗幕與定位由 capture-window.css 拿掉。
 * UI 丙-6 C5：兩個框都是共用 DialogShell（不 portal，仍在 stage 裡，量得到）——DOM 是 stage > .techo-veil > .ns-dialog，
 *   凍票／對焦不再認「stage 的直接子元素」，改認活的那張卡 `.ns-dialog[role="dialog"]`（凍住的複本拿掉了 role，不會被認成活的）。
 * 存檔一律由 CaptureOverlay／TodoPreviewDialog 自己呼叫 store；本元件只看 store 的開合，決定小窗怎麼收：
 *
 * - **Enter 存好（或預覽框建立好）**（D-筆-61）：`capture_hide("saved")`＝Rust 先把前景還給原本的 App、小窗變成不可聚焦＋點擊穿透
 *   （章播放期間鍵盤一律落在原 App）；存好的那張票凍住（DOM 複本）、蓋一枚受付章（App 內同一款 mini fresh），
 *   `CAPTURE_STAMP_MS` 後 `capture_hide("hide")`，再換一張空白新票。`notes:captured` 在存好的當下就發（主視窗馬上重讀）。
 *   **還前景在 Enter 的當下**（`tracked` 包的 saveCapture／confirmPreview 一進來就送，不等 DB 寫完）：寫入加 IPC 要 65–125ms，
 *   這段期間鍵盤還在小窗手上，Enter 後馬上打的字會掉。字在寫入成功前一個都不動（票留在 store、畫面上）；
 *   寫入沒成功（失敗、其實是空的、轉成預覽框）⇒ `capture_hide("revive")` 把小窗叫回來、焦點放回打字區，字都在。
 * - **Esc 放棄（或預覽框取消）**：`capture_hide("esc")`＝還前景再 hide；換新票。
 * - **失焦**（別的視窗拿走焦點、Alt+F4 被 Rust 攔成 hide 之後）：`capture_hide("hide")`，**字留著**（0-1 甲）。章播放期間的失焦是我們自己還前景造成的，忽略。
 * - **被叫出來**（熱鍵／系統匣，`notes:capture-show`）：章若還在播就立刻收掉；重讀設定／路線／荷札；票是空的就換一張新票（票號與時刻重算），
 *   有字就留著、焦點放回打字區（再按一次熱鍵不收，§5.2）。
 * - **長高**（0-13；0-5 甲）：量 `.ns-notes-capwin-stage`（票／預覽框／toast）與浮出去的荷札建議、掛到哪挑選器，`capture_fit`，去抖 50ms。
 * - **存失敗**：store 的 failToast 照舊（小窗不收、toast 排在票下面）；plugin-sql 的「not loaded」換成「主視窗還在啟動，請再按一次 Enter」（0-10）。
 *
 * 「存檔正在飛」怎麼知道：在小窗這個 context 把 store 的 `saveCapture`／`confirmPreview` 包一層計數（只在這裡、卸載還原；notesStore.ts 不動）。
 * store 只在寫入成功後才把 capture／preview 設成 null（失敗留著），所以「飛行中收起」＝存成功（`captureWindowTransition`）。
 *
 * 瀏覽器預覽（`?mock=1&window=capture`，沒有 Tauri）：Rust 那一半都是 no-op——Enter 照樣蓋章、換新票；Esc 換新票；失焦不做事。
 */
import { useEffect, useRef, useState } from "react";
import "../../../lines/mounts"; // 求值時 installLineMounts：別線登記的票根（售票口「記一筆」等）在小窗也在（0-11）
import { captureWindowReleaseEarly, captureWindowToastText, captureWindowTransition } from "../../../domain/notes";
import { todayKey } from "../../../lib/date";
import { useNodeStore } from "../../../store/nodeStore";
import { useNotesStore } from "../../../store/notesStore";
import { useTagStore } from "../../../store/tagStore";
import { useUiStore } from "../../../store/uiStore";
import { Toast } from "../../common/Toast";
import { ensureStampDefs } from "../../stamps/defs";
import { NotesDesktopOverlay } from "../NotesDesktopOverlay";
import { UketsukeSeal } from "../UketsukeSeal";
import { CAPTURE_STAMP_MS, emitCaptured, fitCapture, hideCapture, onCaptureShow } from "./shell";
import "./capture-window.css";

/** 浮出 stage 之外、也要算進視窗高度的東西：荷札建議（portal 到 body、fixed）、預覽框「掛到哪」挑選器（absolute）、
 *  預覽框執行日 chip 開的日期小卡（DateChip→DatePicker anchored，portal 到 body；UI 丙-6 P5） */
const FLOATERS = ".ns-notes-sug.body, .ns-notes-capwin-stage .ns-notes-pop.float, .ns-datepick.anchored";
/** 正在畫的那張卡（捕捉票或預覽框；殼的 .ns-dialog）。凍住的複本拿掉了 role，不會選到 */
const LIVE_CARD = '.ns-dialog[role="dialog"]';

function warn(what: string) {
  return (e: unknown) => console.warn(`[capture] ${what} 失敗`, e);
}

export function CaptureWindowApp() {
  /** 換一張新票就 +1：NotesDesktopOverlay 以它當 key 重掛，CaptureOverlay 的票號與時刻重算 */
  const [ticketGen, setTicketGen] = useState(0);
  /** 受付章（0＝沒在蓋；值當 key，每次重播） */
  const [stamp, setStamp] = useState(0);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const stageRef = useRef<HTMLDivElement>(null);
  const frozenRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctl = {
      /** saveCapture／confirmPreview 正在飛的數量 */
      saving: 0,
      /** 換新票（closeCapture→openCapture）時不算「收起」 */
      quiet: false,
      /** 章播放中：失焦要忽略 */
      stamping: false,
      /** Enter 當下已經把前景還給原 App、還在等存檔結果（成功 ⇒ onSaved 接手播章；沒成功 ⇒ revive）。這段期間的失焦要忽略 */
      released: false,
      /** 那一趟 `capture_hide("saved")`（章的計時器要等它回來；revive 也要排在它後面） */
      releasing: undefined as Promise<void> | undefined,
      /** revive 前後一小段時間內的失焦也忽略（前一次還前景造成的 blur 事件可能遲到） */
      blurQuietUntil: 0,
      /** 存好收起了：store 在存檔尾巴才 toast（「已放進收件匣」＋復原），等那一趟回來就收掉——小窗已經不可點、馬上收 */
      swallowToast: false,
      /** 章的世代：被叫出來時取消，舊的計時器到點就不做事 */
      stampGen: 0,
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
    };
    const root = document.documentElement;
    const prevWindowAttr = root.dataset.window;
    root.dataset.window = "capture";
    ensureStampDefs(); // 受付章的墨暈 filter（#inkbleed-fine）；App 內同一份

    /* ── 票的換新、凍住、焦點 ── */
    const resetTicket = () => {
      ctl.quiet = true;
      try {
        const s = useNotesStore.getState();
        s.closeCapture();
        s.cancelPreview();
        s.openCapture();
      } finally {
        ctl.quiet = false;
      }
      setTicketGen((g) => g + 1);
    };
    /** 把正在畫的票（或預覽框）複製一份留在畫面上：store 收起後 React 會把它拆掉，章要蓋在「剛存好的那張」上 */
    const freeze = () => {
      const stage = stageRef.current;
      const holder = frozenRef.current;
      if (!stage || !holder) return;
      const live = stage.querySelector<HTMLElement>(LIVE_CARD);
      if (!live) return;
      const copy = live.cloneNode(true) as HTMLElement;
      copy.removeAttribute("role");
      copy.removeAttribute("aria-modal");
      copy.removeAttribute("aria-labelledby");
      // cloneNode 不帶 textarea 的現值（React 寫的是 value 屬性，不是子節點）
      const src = live.querySelectorAll("textarea");
      copy.querySelectorAll("textarea").forEach((t, i) => {
        t.value = src[i]?.value ?? "";
        t.tabIndex = -1;
      });
      holder.replaceChildren(copy);
    };
    const unfreeze = () => frozenRef.current?.replaceChildren();
    const focusTyping = () =>
      requestAnimationFrame(() =>
        stageRef.current
          ?.querySelector<HTMLTextAreaElement>(`${LIVE_CARD} .ns-notes-capwrap textarea.ns-notes-capta`)
          ?.focus({ preventScroll: true }),
      );

    /* ── 章 ── */
    const endStamp = () => {
      ctl.stampGen++;
      if (ctl.timer !== undefined) clearTimeout(ctl.timer);
      ctl.timer = undefined;
      ctl.stamping = false;
      setStamp(0);
      unfreeze();
      useUiStore.getState().hideToast(); // 存檔成功的 toast（帶「復原」）在小窗沒有用（存檔尾巴比章晚回來的，由 swallowToast 收）
      resetTicket();
    };

    /* ── 收起的兩條路（store 的開合 → 小窗）── */
    /** Enter 的當下就還前景（見檔頭）。先立旗再叫 Rust：還前景時小窗會收到 blur */
    const releaseNow = () => {
      ctl.released = true;
      ctl.releasing = hideCapture("saved").catch(warn("capture_hide(saved)"));
    };
    /** 還了前景但存檔沒成功：把小窗叫回來。票（字）一直都在 store 裡，這裡一個字都不動 */
    const revive = async () => {
      ctl.blurQuietUntil = Date.now() + 400;
      await ctl.releasing; // 排在「還前景」那趟後面，不然兩趟 IPC 可能顛倒
      ctl.released = false;
      await hideCapture("revive").catch(warn("capture_hide(revive)"));
      ctl.blurQuietUntil = Date.now() + 250;
      focusTyping();
    };
    const onSaved = () => {
      ctl.swallowToast = true;
      freeze();
      ctl.stamping = true; // 先立旗再叫 Rust：還前景時小窗會收到 blur
      const early = ctl.released; // Enter 當下已經還過前景了 ⇒ 不再叫第二次
      ctl.released = false;
      const gen = ++ctl.stampGen;
      setStamp(Date.now());
      void emitCaptured().catch(warn("emit notes:captured"));
      const released = early && ctl.releasing ? ctl.releasing : hideCapture("saved").catch(warn("capture_hide(saved)"));
      ctl.timer = setTimeout(async () => {
        await released;
        if (gen !== ctl.stampGen) return; // 播到一半被叫出來了
        await hideCapture("hide").catch(warn("capture_hide(hide)"));
        if (gen !== ctl.stampGen) return;
        endStamp();
      }, CAPTURE_STAMP_MS);
    };
    const onEscaped = () => {
      freeze(); // 收起前不讓小窗先閃成一張空白紙／縮到最矮
      void hideCapture("esc")
        .catch(warn("capture_hide(esc)"))
        .finally(() => {
          unfreeze();
          resetTicket();
        });
    };

    // 「存檔正在飛」的計數：只在小窗這個 context 包一層（卸載還原）
    const orig = {
      saveCapture: useNotesStore.getState().saveCapture,
      confirmPreview: useNotesStore.getState().confirmPreview,
    };
    const tracked =
      <A extends unknown[], R>(kind: "save" | "confirm", fn: (...a: A) => Promise<R>) =>
      async (...a: A): Promise<R> => {
        // 同步在這裡（Enter 的 keydown 同一輪）就送出還前景，之後才 await 寫入
        if (ctl.saving === 0 && !ctl.released && !ctl.stamping && captureWindowReleaseEarly(useNotesStore.getState(), kind)) {
          releaseNow();
        }
        ctl.saving++;
        try {
          return await fn(...a);
        } finally {
          ctl.saving--;
          if (ctl.saving === 0) {
            // 還了前景卻沒走到 onSaved（寫入失敗、其實是空的、轉成預覽框）⇒ 叫回來
            if (ctl.released) void revive();
            if (ctl.swallowToast) {
              ctl.swallowToast = false;
              useUiStore.getState().hideToast();
            }
          }
        }
      };
    useNotesStore.setState({
      saveCapture: tracked("save", orig.saveCapture),
      confirmPreview: tracked("confirm", orig.confirmPreview),
    });

    const unsubNotes = useNotesStore.subscribe((s, prev) => {
      if (ctl.quiet) return;
      const kind = captureWindowTransition(
        { capture: prev.capture !== null, preview: prev.preview !== null },
        { capture: s.capture !== null, preview: s.preview !== null },
        ctl.saving > 0,
      );
      if (kind === "saved") onSaved();
      else if (kind === "esc") onEscaped();
    });

    // 0-10：DB 還沒被主視窗 load 好 ⇒ 換成看得懂的一句
    const unsubToast = useUiStore.subscribe((s, prev) => {
      if (!s.toast || s.toast === prev.toast) return;
      const text = captureWindowToastText(s.toast.message);
      if (text) useUiStore.getState().showToast({ message: text });
    });

    /* ── 失焦＝收起、字留著（0-1 甲）── */
    const onBlur = (e: FocusEvent) => {
      if (e.target !== window || ctl.stamping || ctl.released || Date.now() < ctl.blurQuietUntil) return;
      void hideCapture("hide").catch(warn("capture_hide(blur)"));
    };
    window.addEventListener("blur", onBlur);

    /* ── 被叫出來 ── */
    const reloadContext = () => {
      // 小窗在啟動時就建好，那時主視窗可能還沒 load DB（讀失敗＝預設值）；設定與路線也可能在主視窗改過——每次叫出來都重讀
      void useUiStore.getState().loadSettings();
      void useNodeStore.getState().loadSidebar();
      const tags = useTagStore.getState();
      if (tags.index) void tags.loadIndex(); // 沒載過的話，打 # 時 useInlineTagSuggest 自己會載
    };
    let alive = true;
    let unlistenShow: (() => void) | null = null;
    void onCaptureShow(() => {
      if (ctl.stamping) endStamp(); // 章播到一半又按熱鍵：章收掉、直接給新票（Rust 的 show 已把不可聚焦／穿透還原）
      useUiStore.getState().hideToast();
      reloadContext();
      const s = useNotesStore.getState();
      if (!s.preview && !s.capture?.text.trim()) resetTicket();
      focusTyping();
    })
      .then((un) => {
        if (alive) unlistenShow = un;
        else un();
      })
      .catch(warn("listen notes:capture-show"));

    /* ── 長高 ── */
    let fitTimer: ReturnType<typeof setTimeout> | undefined;
    let lastH = 0;
    const measure = () => {
      const stage = stageRef.current;
      if (!stage) return;
      const r = stage.getBoundingClientRect();
      let bottom = r.bottom;
      document.querySelectorAll<HTMLElement>(FLOATERS).forEach((el) => {
        bottom = Math.max(bottom, el.getBoundingClientRect().bottom);
      });
      const h = Math.ceil(bottom - r.top);
      if (h === lastH) return;
      lastH = h;
      void fitCapture(h).catch(warn("capture_fit"));
    };
    const scheduleFit = () => {
      if (fitTimer !== undefined) clearTimeout(fitTimer);
      fitTimer = setTimeout(measure, 50);
    };
    const ro = new ResizeObserver(scheduleFit);
    if (stageRef.current) ro.observe(stageRef.current);
    // 浮出去的東西（portal 到 body 的荷札建議、預覽框的挑選器）出現／消失／換內容
    const mo = new MutationObserver(scheduleFit);
    mo.observe(document.body, { childList: true, subtree: true });

    /* ── 掛上 ── */
    reloadContext();
    resetTicket(); // 預開一張空票（小窗沒有設定／確認等疊層，openCapture 的互斥檢查恆過）

    return () => {
      alive = false;
      unlistenShow?.();
      unsubNotes();
      unsubToast();
      window.removeEventListener("blur", onBlur);
      ro.disconnect();
      mo.disconnect();
      if (fitTimer !== undefined) clearTimeout(fitTimer);
      if (ctl.timer !== undefined) clearTimeout(ctl.timer);
      useNotesStore.setState(orig);
      if (prevWindowAttr === undefined) delete root.dataset.window;
      else root.dataset.window = prevWindowAttr;
    };
  }, []);

  return (
    <div data-shell="desktop" data-window="capture" className="ns-notes-capwin">
      <div ref={stageRef} className="ns-notes-capwin-stage">
        <NotesDesktopOverlay key={ticketGen} />
        <div ref={frozenRef} className="ns-notes-capwin-frozen" inert aria-hidden="true" />
        {stamp ? (
          <div key={stamp} className="ns-notes-sealflash" aria-hidden>
            <UketsukeSeal day={todayKey(dayStartHour)} size={42} fresh />
          </div>
        ) : (
          <Toast />
        )}
      </div>
    </div>
  );
}
