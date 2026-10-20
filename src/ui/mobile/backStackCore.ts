/**
 * backStackCore——手機返回堆疊的純邏輯（磨光① A3；契約 `docs/research/2026-10-20-主線-磨光①手機殼-契約.md` §1、§9.1）。
 * 不 import React、store、Tauri：node test 直接載入（scripts/tests/back-stack.test.ts）。React 鉤子與原生橋接在 backStack.ts。
 *
 * 規則：
 *   - 返回鍵＝關掉最上面那一層；「最上面」先比種類權重（dialog ＞ full ＞ sheet ＞ page），同種類才比開啟先後。
 *     只比開啟先後會翻車：React 的 effect 子先父後，同一個 commit 開的兩層順序不可靠（反駁 A-1）。
 *   - 同 id 用 refcount：好幾個鉤子實例登記同一個 id ⇒ 合併成一層、保留最早序號，全部放掉才移除（反駁 A-2；
 *     時刻表兩個 SheetHost 換手時，面板不會拿到新序號跑到疊在它上面的挑選器之上）。onBack 用最後登記的那一個。
 *   - tab 層不是一層：堆疊空時才看 `tabRule`（不在今日 tab ⇒ 回今日／「更多」回前一格），見 `BackBridge`。
 *   - 寬限：最後一個動作（關層或回今日）之後 `graceMs` 內，堆疊空了也先吞掉返回鍵；過了才把監聽還給 Android（＝退到背景）。
 */

export type BackKind = "page" | "sheet" | "full" | "dialog";

const WEIGHT: Record<BackKind, number> = { page: 0, sheet: 1, full: 2, dialog: 3 };

/** 返回鍵的防連按寬限（ms）：Android 判定連點的門檻 `ViewConfiguration.getDoubleTapTimeout()`＝300ms，加 50ms 餘量（D-主-50） */
export const BACK_GRACE_MS = 350;

interface Entry {
  id: string;
  kind: BackKind;
  seq: number;
  /** 登記者 token → onBack；呼叫最後登記的那一個 */
  handlers: Map<number, () => void>;
}

export interface BackLayerView {
  id: string;
  kind: BackKind;
}

export class BackStack {
  private entries = new Map<string, Entry>();
  private seq = 0;
  private token = 0;
  private subs = new Set<() => void>();

  /** 登記一層；回傳放掉的函式。同 id 再登記＝refcount（種類以第一次為準） */
  push(id: string, kind: BackKind, onBack: () => void): () => void {
    const t = ++this.token;
    let e = this.entries.get(id);
    if (!e) {
      e = { id, kind, seq: ++this.seq, handlers: new Map() };
      this.entries.set(id, e);
    }
    e.handlers.set(t, onBack);
    this.emit();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const cur = this.entries.get(id);
      if (!cur) return;
      cur.handlers.delete(t);
      if (cur.handlers.size === 0) this.entries.delete(id);
      this.emit();
    };
  }

  get size(): number {
    return this.entries.size;
  }

  top(): BackLayerView | null {
    let best: Entry | null = null;
    for (const e of this.entries.values()) {
      if (!best || WEIGHT[e.kind] > WEIGHT[best.kind] || (WEIGHT[e.kind] === WEIGHT[best.kind] && e.seq > best.seq)) best = e;
    }
    return best ? { id: best.id, kind: best.kind } : null;
  }

  /** 叫最上面那層的 onBack；回那層的 id（堆疊空＝null） */
  popTop(): string | null {
    const top = this.top();
    if (!top) return null;
    const e = this.entries.get(top.id)!;
    const last = [...e.handlers.values()].pop();
    last?.();
    return top.id;
  }

  /** 由下往上列出（除錯／測試用） */
  list(): BackLayerView[] {
    return [...this.entries.values()]
      .sort((a, b) => WEIGHT[a.kind] - WEIGHT[b.kind] || a.seq - b.seq)
      .map((e) => ({ id: e.id, kind: e.kind }));
  }

  subscribe(fn: () => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  private emit() {
    for (const fn of this.subs) fn();
  }
}

/* ───────────────────── 原生橋接（可注入，測試用假的） ───────────────────── */

/** 一次掛上的監聽；拆只拆自己這個物件（反駁 A-3） */
export interface BackListener {
  unregister(): Promise<void> | void;
}

export interface BackBridgeDeps {
  /** 掛原生返回鍵監聽（Tauri `onBackButtonPress`）；沒有原生端＝回一個什麼都不做的監聽 */
  register(handler: () => void): Promise<BackListener>;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
}

/** 這一下返回做了什麼（mock 的 `__nsBack()` 回傳、測試斷言用） */
export type BackResult = `layer:${string}` | "tab" | "swallow";

export class BackBridge {
  private listener: BackListener | null = null;
  private pending: Promise<BackListener> | null = null;
  private timer: unknown = null;
  private lastAction = -Infinity;
  private tabRule: (() => (() => void) | null) | null = null;
  // 一般欄位、不用建構子參數屬性：node 的 strip-only 模式不收參數屬性，node test 要能直接 import 這支
  private stack: BackStack;
  private deps: BackBridgeDeps;
  private graceMs: number;

  constructor(stack: BackStack, deps: BackBridgeDeps, graceMs: number = BACK_GRACE_MS) {
    this.stack = stack;
    this.deps = deps;
    this.graceMs = graceMs;
  }

  /** 殼層的派生規則：堆疊空時要不要（以及怎麼）回今日；null＝已在今日 */
  setTabRule(rule: (() => (() => void) | null) | null) {
    this.tabRule = rule;
    this.reconcile();
  }

  /** 原生事件進來 */
  handle = (): BackResult => {
    const t = this.deps.now();
    let res: BackResult;
    if (this.stack.size > 0) {
      // 先記 lastAction 再叫 onBack：onBack 若同步放掉自己那層，popTop 裡就會 emit → reconcile，寬限要從這一下算
      this.lastAction = t;
      res = `layer:${this.stack.popTop()!}`;
    } else {
      const goTab = this.tabRule?.() ?? null;
      if (goTab) {
        this.lastAction = t;
        goTab();
        res = "tab";
      } else {
        res = "swallow"; // 堆疊空、在今日，卻還收到事件＝寬限期間（監聽還沒拆）
      }
    }
    this.reconcile();
    return res;
  };

  /** 是否還有事要做（有層，或不在今日 tab） */
  private wanted(): boolean {
    return this.stack.size > 0 || (this.tabRule?.() ?? null) !== null;
  }

  /** 堆疊或 tab 變了就叫：要監聽就掛、不要就等寬限過了拆 */
  reconcile = () => {
    if (this.wanted()) {
      if (this.timer !== null) {
        this.deps.clearTimer(this.timer);
        this.timer = null;
      }
      this.ensureRegistered();
      return;
    }
    if (this.timer !== null) return;
    if (!this.listener && !this.pending) return;
    const wait = Math.max(0, this.lastAction + this.graceMs - this.deps.now());
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      if (!this.wanted()) this.dropListener();
    }, wait);
  };

  private ensureRegistered() {
    if (this.listener || this.pending) return;
    const p = this.deps.register(this.handle);
    this.pending = p;
    void p.then(
      (l) => {
        if (this.pending !== p) {
          void l.unregister(); // 掛到一半已經被放棄
          return;
        }
        this.pending = null;
        this.listener = l;
        if (!this.wanted()) this.reconcile();
      },
      () => {
        if (this.pending === p) this.pending = null;
      },
    );
  }

  private dropListener() {
    const l = this.listener;
    this.listener = null;
    if (l) void l.unregister();
    if (this.pending) {
      // 還在掛的那一個：resolve 後看到 pending 已換掉就自己拆
      this.pending = null;
    }
  }

  /** 測試用：監聽是不是掛著（含掛到一半） */
  get listening(): boolean {
    return this.listener !== null || this.pending !== null;
  }
}
