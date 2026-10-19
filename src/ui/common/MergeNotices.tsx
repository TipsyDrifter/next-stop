/**
 * MergeNotices——同步頁「最近兩台撞到的」一區（主線車次③；契約 §4.1；兩殼共用同一個元件，前例＝CloudSnapshots／D-2）。
 *
 * 拍板：D-主-16（同步頁一區清單：哪一筆、何時、怎麼撞的，按「知道了」清；兩殼同形；不在那筆身上掛記號）、
 *       D-主-17（方向句分「你在這台刪過」「另一台刪過」）、D-主-18（兩類分開標示、「刪了又回來」排前）、
 *       D-主-19（「知道了」＝整張清光）、D-主-20（「兩邊都改了」印兩邊的值、各截 24 字）。
 *
 * 版面：標題「最近兩台撞到的」＋右側「知道了」→ 一句說明 → 「刪了又回來」組 → 「兩邊都改了、後改的留下」組；
 *   列＝時刻＋名字＋方向句。清單空 ⇒ 整區不出現（沿 `skipped_missing_total > 0 才出現` 的慣例）。
 *   桌機三段同一行（窄了折行）；手機時刻與名字同一行、方向句第二行（merge-notices.css 的 `[data-shell="mobile"]` 覆寫）。
 *
 * 名字：`resolveMergeLabel`（store 層，只解名字）在 effect 裡解；解完前先印泛稱、解到再換字。
 * 跳轉：**由本元件組**（store 層不得 import 元件，§0-1 第 9 條）——三線插槽給的 `open` 直接用；核心 nodes 在桌機
 *   先關設定面板（modal，不關看不到跳轉結果）再 `jumpToNode`；手機核心列本班不可點（手機沒有「跳到某張票」入口，偏差已記）。
 *   點了**不**自動「知道了」（主人回來還看得到清單）。
 * 掛著＝看過：掛載期間 `registerMergesOnScreen()`（新批不彈 toast）；清單非空時叫 `markMergesSeen()`（同一批回前景不再 toast，§0-1 第 3 條）；兩殼都是條件渲染，掛載＝頁真的在畫面上。
 */
import { useEffect, useMemo, useState } from "react";
import type { MergeNotice } from "../../data/syncRepository";
import { MERGE_TEXT, describeMerge, fallbackLabel, groupMerges, mergeSubject, nounOf } from "../../domain/syncMerge";
import { coreCols, resolveMergeLabel, type ResolvedMergeLabel } from "../../store/syncMergeLabels";
import { fmtSyncStamp, registerMergesOnScreen, useSyncStore, type SyncShell } from "../../store/syncStore";
import { useUiStore } from "../../store/uiStore";
import { jumpToNode } from "./QuickJump";
import "./merge-notices.css";

/** 穩定的空陣列：selector 每次回新 `[]` 會讓 zustand 判成狀態一直在變 */
const EMPTY: readonly MergeNotice[] = [];

type Resolved = ResolvedMergeLabel | null | "fallback";

/** 一筆通知的身分（同一筆同欄撞第二次會換 at／hlc ⇒ 換 key、重解） */
function noticeKey(n: MergeNotice): string {
  return `${n.kind}|${n.tbl}|${n.row_id}|${n.col ?? ""}|${n.at}|${n.hlc}`;
}

export function MergeNotices({ shell }: { shell: SyncShell }) {
  const notices = useSyncStore((s) => s.status?.notices ?? EMPTY);
  const ackMerges = useSyncStore((s) => s.ackMerges);
  const markMergesSeen = useSyncStore((s) => s.markMergesSeen);
  const [labels, setLabels] = useState<Record<string, Resolved>>({});
  const [acking, setAcking] = useState(false);

  const sig = useMemo(() => notices.map(noticeKey).join("\n"), [notices]);

  // 掛載期間＝清單就在眼前：syncStore 的 toast 看到這個旗標就不為新批彈「看看」（否則按了只是落在本來就在的這一頁）
  useEffect(() => registerMergesOnScreen(), []);

  // 清單內容變了（at 序列變）⇒ 記「看過」＋重解名字（≤20 列、本機 SQL）
  useEffect(() => {
    if (notices.length === 0) return;
    markMergesSeen();
    let alive = true;
    void Promise.all(notices.map(async (n) => [noticeKey(n), await resolveMergeLabel(n, shell)] as const)).then((pairs) => {
      if (alive) setLabels(Object.fromEntries(pairs));
    });
    return () => {
      alive = false;
    };
    // sig 已涵蓋 notices 的內容；不以陣列參照為依賴（status 每趟都是新物件，60 秒一趟不該重解）
  }, [sig, shell, markMergesSeen]);

  const groups = useMemo(() => groupMerges(notices), [notices]);
  if (groups.revived.length === 0 && groups.overwritten.length === 0) return null;

  const onAck = async () => {
    if (acking) return;
    setAcking(true);
    try {
      await ackMerges(); // 成功 ⇒ status.notices 變空 ⇒ 整區卸載
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      useUiStore.getState().showToast({ message: MERGE_TEXT.ackFailed(msg) });
    } finally {
      setAcking(false);
    }
  };

  const renderRow = (n: MergeNotice) => {
    const key = noticeKey(n);
    const r = labels[key];
    let label: string;
    let cols: Readonly<Record<string, string>> | undefined = coreCols(n.tbl);
    let open: (() => void | Promise<void>) | undefined;
    if (r === undefined || r === "fallback") label = fallbackLabel(n);
    else if (r === null) label = `${nounOf(n.tbl)}${MERGE_TEXT.gone}`;
    else {
      label = r.label;
      cols = r.cols ?? cols;
      const node = r.node;
      open =
        r.open ??
        (shell === "desktop" && node
          ? () => {
              useUiStore.getState().setSettingsOpen(false);
              return jumpToNode(node);
            }
          : undefined);
    }
    const subject = n.kind === "overwritten" ? mergeSubject(label, n, cols) : label;
    const body = (
      <>
        <time className="ns-mg-when" dateTime={n.at}>
          {fmtSyncStamp(n.at)}
        </time>
        <span className="ns-mg-label">{subject}</span>
        <span className="ns-mg-what">{describeMerge(n)}</span>
      </>
    );
    return (
      <li key={key} className={`ns-mg-row is-${n.kind}${open ? " is-open" : ""}`}>
        {open ? (
          <button
            type="button"
            className="ns-mg-open"
            onClick={() => {
              void Promise.resolve()
                .then(open)
                .catch((e) => console.warn("[next-stop] 同步清單列跳轉失敗：", e));
            }}
          >
            {body}
          </button>
        ) : (
          <div className="ns-mg-static">{body}</div>
        )}
      </li>
    );
  };

  return (
    <section className="ns-mg" aria-labelledby={`ns-mg-title-${shell}`}>
      <div className="ns-mg-head">
        <h3 id={`ns-mg-title-${shell}`} className="ns-mg-title">
          {MERGE_TEXT.title}
        </h3>
        <button type="button" className="btn-ghost ns-btn ns-btn--sm ns-mg-ack" disabled={acking} onClick={() => void onAck()}>
          {MERGE_TEXT.ack}
        </button>
      </div>
      <p className="ns-note ns-mg-intro">{MERGE_TEXT.intro}</p>
      {groups.revived.length > 0 && (
        <>
          <h4 className="ns-mg-group">{MERGE_TEXT.groupRevived}</h4>
          <ul className="ns-mg-list">{groups.revived.map(renderRow)}</ul>
        </>
      )}
      {groups.overwritten.length > 0 && (
        <>
          <h4 className="ns-mg-group">{MERGE_TEXT.groupOverwritten}</h4>
          <ul className="ns-mg-list">{groups.overwritten.map(renderRow)}</ul>
        </>
      )}
    </section>
  );
}
