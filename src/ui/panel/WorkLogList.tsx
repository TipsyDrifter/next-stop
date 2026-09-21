/**
 * 乘務記錄（工作日誌 · UI Flow 2.1 · 列車／車廂／車票面板內）：開啟時 loadWorkLogs(id)，最新在上；
 * 輸入一行 Enter 即記（addWorkLog）。Esc 在有草稿時先清空、乾淨時放行給面板關閉。
 *
 * 視覺＝**乘務記錄樣式**（M3 ② 主題換裝移植；決策記錄 M3 拍板 2：原件 commit 6a1b98c 的 .log／.time-seal 段，
 * 側板窄幅版取自 prototypes/m3-ext-routemap.html 的側板區）：
 *   每列＝［時刻戳／時刻淡字］＋動作字（.act）＋手寫內文（Iansui，主人筆跡例外）＋日期；樣式在 src/styles/stamps.css。
 *
 * M3 ③ WP4 補完（D-③-5 乙 系統事件）：
 * - `.act` 欄上線＝事件列（WorkLog.event 非 null）印 WORK_LOG_EVENT_LABEL（発券／入鋏／済）；手記列留白。
 * - 小號時刻戳的口徑由「位置猜測（最舊／已完成的最新）」改成**由事件列供給**，照原件檔頭那句
 *   「小號日付印只給旅程兩端（入鋏・済），發券／途中下車／運休只印時刻淡字」：
 *     punched → 時刻戳（+2°，旅程起點）／done → 時刻戳（-3°，旅程終點）／issued 與手記 → 時刻淡字。
 *   反悔（取消完成）時 store 會刪掉那筆 done 事件，済列與它的戳一起消失，不需要本元件再判斷節點狀態。
 * - 事件列 body 一律空字串（domain/node.ts）：內文欄留成空格位（保住四欄對齊），不塞空字串節點撐出空行。
 * - 原型的 log-hint 提示語上線（③ 今日視圖的 `L` 已存在，鐵律解除）。
 * - 重載訊號改看節點的 updated_at（今日索引優先）：系統事件是 store 順手寫的、不會回頭通知本元件，
 *   沒有這條的話側板開著蓋済不會長出「済」列，得關掉重開才看得到。
 *
 * v1.1.2（雙向同步）補一種事件：`conflict`＝競合。
 * - 為什麼印在這裡而不是另開衝突匣（D-1.1-5）：敗方的值是「這張票身上發生過的事」，乘務記錄本來就是
 *   這張票的事件簿；另開一個匣子等於多一個要巡的地方，而主人多半只在打開那張票時才在意。
 * - 只有這一種事件的 body 非空（別種事件 body 一律空字串），且 body 是 **JSON**——
 *   用 `describeConflict()` 轉成一行人話，**印刷體**（不加 `hw`）：`hw` 是主人筆跡專用，
 *   系統講的話不能冒充手寫。左欄印時刻淡字，不蓋戳（戳只給旅程兩端：入鋏／済）。
 *
 * 已知取捨：只能新增、不可編輯／刪除（v0.2 範圍外）；排序在元件端依 logged_at 倒序，不依賴 repository 回傳順序。
 */
import { useEffect, useMemo, useState } from "react";
import { WORK_LOG_EVENT_LABEL, describeConflict } from "../../domain";
import { useNodeStore } from "../../store/nodeStore";
import { TimeSeal } from "../stamps";

export function WorkLogList({ nodeId }: { nodeId: string }) {
  const logs = useNodeStore((s) => s.workLogs[nodeId]);
  const loadWorkLogs = useNodeStore((s) => s.loadWorkLogs);
  const addWorkLog = useNodeStore((s) => s.addWorkLog);
  // 節點被改動的時間戳（今日索引優先，今日列多半不在當前路線樹裡）：系統事件是 store 順手寫的，
  // 不會回頭通知本元件 → 拿 updated_at 當重載訊號，蓋済／反悔時側板開著也跟著長出／收回那一列。
  const stamp = useNodeStore((s) => (s.today.byId[nodeId] ?? s.tree.byId[nodeId])?.updated_at);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadWorkLogs(nodeId);
  }, [nodeId, stamp, loadWorkLogs]);

  const sorted = useMemo(
    () => (logs ? [...logs].sort((a, b) => (a.logged_at < b.logged_at ? 1 : a.logged_at > b.logged_at ? -1 : 0)) : []),
    [logs],
  );

  const submit = async () => {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await addWorkLog(nodeId, body);
      setDraft("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <input
        type="text"
        aria-label="新增乘務記錄"
        placeholder="寫一行剛才做了什麼，Enter 記下"
        value={draft}
        disabled={busy}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter") {
            e.preventDefault();
            void submit();
          } else if (e.key === "Escape" && draft) {
            e.preventDefault();
            e.stopPropagation();
            setDraft("");
          }
        }}
      />
      {logs === undefined ? (
        <p className="empty">讀取中…</p>
      ) : sorted.length === 0 ? (
        <p className="empty">還沒有日誌——做完一段就記一行，累積感從這裡開始。</p>
      ) : (
        <ul className="log">
          {sorted.map((l) => {
            // 旅程兩端才蓋戳：入鋏（起點）＋2°／済（終點）-3°，交錯得像一枚枚蓋下去；其餘印時刻淡字。
            const seal = l.event === "punched" ? 2 : l.event === "done" ? -3 : null;
            // 競合列的 body 是 JSON（Rust 寫的），轉成一行人話；其餘列照原樣
            const conflict = l.event === "conflict";
            const text = conflict ? describeConflict(l.body) : l.body;
            return (
              <li key={l.id} className={l.event ? "evt" : undefined}>
                {seal !== null ? (
                  <TimeSeal at={l.logged_at} rotate={seal} />
                ) : (
                  <span className="tm">{fmtHm(l.logged_at)}</span>
                )}
                <span className="act">{l.event ? WORK_LOG_EVENT_LABEL[l.event] : ""}</span>
                {/* 事件列沒有內文：欄位留空位撐住四欄對齊，不塞內容（無內文不留空行） */}
                {/* 手寫體只給主人的手記；系統寫的競合一行走印刷體 */}
                <span className={l.body && !conflict ? "what hw" : "what"}>{text}</span>
                <time className="no" dateTime={l.logged_at}>
                  {fmtMd(l.logged_at)}
                </time>
              </li>
            );
          })}
        </ul>
      )}
      <p className="log-hint">
        今日視圖選中車票按 <kbd>L</kbd> 行內記一句——寫完就進這裡。
      </p>
    </div>
  );
}

/** UTC ISO → 本地 "HH:mm"（時刻淡字用） */
function fmtHm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** UTC ISO → 本地 "M/D"（原件 .no 欄） */
function fmtMd(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
