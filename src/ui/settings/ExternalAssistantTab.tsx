/**
 * ExternalAssistantTab——設定頁第五籤〈外部助理〉（MCP 接口班；契約 §1、§5，D-主-95～97）。
 *
 * 視覺真相＝`prototypes/MCP-外部助理設定.html` 方案 C（使用者 10-25 選定，D-主-97）；文案逐字照原型。
 * 版面（由上而下）：
 *   ① 讓助理用哪些＝五列（名稱＋別名＋「看／改各能做什麼」），右邊一組三段「關｜只看｜可改」（共用 `Segmented` compact）。
 *   ② 連線＝網址、連線金鑰（只露末 4 碼；複製／重新產生——先確認，舊的立刻失效）、兩顆「複製設定」鈕；
 *      端點沒聽起來（`listening=false`）或 Rust 回了 `error` 時，這一段多一行赭字（Rust 給的那句）。
 *   ③ 最近紀錄＝Rust 記憶體裡的最近幾筆；被擋下（blocked）與出錯（error）用赭。開著這一籤時每 5 秒刷一次，關籤就停。
 * 複製鈕按下字換「已複製」1.6 秒（不另開 toast）；複製不了才 toast。
 * 資料流：本檔只經 `src/mcp/client.ts`，不直接 invoke；開關即按即存（Rust 寫 `mcp.json`），失敗就退回原值並說一聲。
 * 形狀零發明：清單／時刻／路徑／動作列／撕線分段全借 settings.css 的備份與同步籤語彙；本籤自己的排版在 `externalAssistant.css`。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useUiStore } from "../../store/uiStore";
import { Segmented, type SegmentedOption } from "../common/Segmented";
import {
  mcpRecent,
  mcpRotateToken,
  mcpSetAccess,
  mcpStatus,
  claudeCodeCommand,
  claudeDesktopConfig,
  maskToken,
  type McpRecent,
  type McpStatus,
} from "../../mcp/client";
import { MCP_MODULES, MCP_MODULE_LABEL, type McpAccess, type McpModule } from "../../mcp/types";
import "./settings.css";
import "./externalAssistant.css";

/** 每個功能「看／改各能做什麼」（原型 FEATS 逐字；名稱取 MCP_MODULE_LABEL，與 Rust 擋下時的字同一份） */
const FEATURE_TEXT: Record<McpModule, { alias?: string; see: string; edit: string }> = {
  tasks: { alias: "路線與車票", see: "今天與路線", edit: "建票、改日期、蓋済" },
  timetable: { alias: "時間塊", see: "時間塊", edit: "補記、改時間" },
  notes: { see: "搜尋、讀筆記", edit: "寫新的、加荷札" },
  diary: { see: "讀某一天", edit: "續寫" },
  ledger: { alias: "售票口", see: "收支", edit: "記一筆" },
};

const ACCESS_OPTIONS: SegmentedOption<McpAccess>[] = [
  { value: "off", label: "關" },
  { value: "read", label: "只看" },
  { value: "write", label: "可改" },
];

const RECENT_POLL_MS = 5_000;
const COPIED_MS = 1_600;

/** 紀錄時刻：今天只寫 HH:MM；不是今天的加月／日 */
function fmtAt(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at;
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function ExternalAssistantTab() {
  const askConfirm = useUiStore((s) => s.askConfirm);
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [recent, setRecent] = useState<McpRecent[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refreshRecent = useCallback(async () => {
    try {
      setRecent(await mcpRecent());
    } catch {
      // 紀錄刷不到不打擾（狀態那一格已經會說讀不到）
    }
  }, []);

  // 開籤：狀態＋紀錄各問一次；之後每 5 秒刷紀錄，關籤（元件卸載）就停。
  // 收官磨光 A2：連線還沒開好（沒在聽、也沒有錯）時狀態也一起重問——不然開籤那一刻的「正在開啟」會一直掛著
  /** 狀態已定（在聽，或已確定失敗）＝不必重問；還沒拿到第一份狀態時交給上面那一趟 */
  const settledRef = useRef(true);
  settledRef.current = !status || status.listening || !!status.error;
  useEffect(() => {
    let alive = true;
    mcpStatus()
      .then((s) => alive && setStatus(s))
      .catch((e) => alive && setLoadError(errText(e)));
    void refreshRecent();
    const id = window.setInterval(() => {
      void refreshRecent();
      if (!settledRef.current) {
        mcpStatus()
          .then((s) => alive && setStatus(s))
          .catch(() => {
            /* 重問失敗不打擾：下一輪再問 */
          });
      }
    }, RECENT_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [refreshRecent]);

  const setAccess = async (module: McpModule, access: McpAccess) => {
    if (!status) return;
    const prev = status;
    setActionError(null);
    setStatus({ ...status, access: { ...status.access, [module]: access } });
    try {
      setStatus(await mcpSetAccess(module, access));
    } catch (e) {
      setStatus(prev);
      setActionError(`沒有存到：${errText(e)}`);
    }
  };

  const rotate = () =>
    askConfirm({
      title: "重新產生連線金鑰？",
      body: "舊的金鑰會立刻失效，助理那邊要重新貼一次。",
      confirmLabel: "重新產生",
      danger: true,
      onConfirm: () => {
        setActionError(null);
        mcpRotateToken()
          .then(setStatus)
          .catch((e) => setActionError(`金鑰沒有換成：${errText(e)}`));
      },
    });

  if (loadError) {
    return (
      <div className="ns-ai">
        <p className="ns-note is-fail" role="alert">
          讀不到外部助理的狀態（{loadError}）
        </p>
      </div>
    );
  }
  if (!status) {
    return (
      <div className="ns-ai">
        <p className="ns-note">讀取中…</p>
      </div>
    );
  }

  return (
    <div className="ns-ai">
      <section>
        <span className="techo-label block">讓助理用哪些</span>
        <ul className="ns-ai-list">
          {MCP_MODULES.map((m) => {
            const f = FEATURE_TEXT[m];
            const name = MCP_MODULE_LABEL[m];
            return (
              <li key={m} className="ns-ai-row">
                <div className="ns-ai-txt">
                  <span className="ns-ai-name">{name}</span>
                  {f.alias && <span className="ns-ai-alias">{f.alias}</span>}
                  <span className="ns-ai-can">
                    <b>看</b>　{f.see}　<b>改</b>　{f.edit}
                  </span>
                </div>
                <div className="ns-ai-ctl">
                  <Segmented
                    options={ACCESS_OPTIONS}
                    value={status.access[m] ?? "off"}
                    onChange={(v) => void setAccess(m, v)}
                    compact
                    aria-label={name}
                  />
                </div>
              </li>
            );
          })}
        </ul>
        {actionError && (
          <p className="ns-bk-err" role="alert">
            {actionError}
          </p>
        )}
      </section>

      <section className="ns-sy-pair">
        <span className="techo-label block mb-1">連線</span>
        <p className="ns-note">只在這台電腦、App 開著時有效（縮到系統匣也算）。</p>
        {/* Rust 的 error 是給人看的一句（埠被占用、設定檔讀寫失敗）；聽著但有錯（設定檔）也要說。
            收官磨光 A2：沒在聽、也還沒有錯＝Rust 還在等埠空出來（自我重啟時舊行程剛放手，最多重試約 10 秒）——
            寫「正在開啟」淡字，不再預設成紅字的「被占用」；狀態每 5 秒跟著紀錄一起重問，開好或確定失敗就換掉 */}
        {status.error ? (
          <p className="ns-bk-err" role="alert">
            {status.error}
          </p>
        ) : (
          !status.listening && <p className="ns-note">正在開啟外部助理的連線…</p>
        )}
        <div className="ns-ai-kv">
          <span className="techo-label">網址</span>
          <span className="ns-bk-path" title={status.url}>
            {status.url}
          </span>
          <span />
          <span className="techo-label">連線金鑰</span>
          <span className="ns-ai-key">{maskToken(status.token)}</span>
          <span className="ns-bk-actions">
            <CopyButton label="複製" text={status.token} small />
            <button
              type="button"
              className="btn-ghost ns-btn ns-btn--sm"
              title="舊的金鑰會立刻失效，助理那邊要重新貼一次"
              onClick={rotate}
            >
              重新產生
            </button>
          </span>
        </div>
        <div className="ns-bk-actions">
          <CopyButton label="複製 Claude Code 指令" text={claudeCodeCommand(status)} />
          <CopyButton label="複製 Claude Desktop 設定" text={claudeDesktopConfig(status)} />
        </div>
      </section>

      <section className="ns-sy-pair">
        <span className="techo-label block">最近紀錄</span>
        {recent.length === 0 ? (
          <p className="ns-note ns-ai-log-empty">還沒有紀錄。</p>
        ) : (
          <ul className="ns-bk-list ns-ai-log">
            {recent.map((r, i) => (
              <li key={`${r.at}-${i}`} className={r.kind === "write" ? undefined : "is-denied"}>
                <span className="ns-bk-time" title={new Date(r.at).toLocaleString()}>
                  {fmtAt(r.at)}
                </span>
                <span className="ns-ai-log-t">{r.summary}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** 複製鈕：按下字換「已複製」1.6 秒；複製不了才 toast */
function CopyButton({ label, text, small = false }: { label: string; text: string; small?: boolean }) {
  const showToast = useUiStore((s) => s.showToast);
  const [done, setDone] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      window.clearTimeout(timer.current);
      setDone(true);
      timer.current = window.setTimeout(() => setDone(false), COPIED_MS);
    } catch {
      showToast({ message: "複製不了，請再試一次" });
    }
  };

  const cls = ["btn-ghost", "ns-btn", small ? "ns-btn--sm" : "", done ? "is-done" : ""].filter(Boolean).join(" ");
  return (
    // 兩個字疊在同一格、只切可見度：鈕寬固定在較長那個字，換字時旁邊的鈕不會跟著跳
    <button type="button" className={cls} onClick={() => void copy()} aria-label={done ? "已複製" : label}>
      <span className="ns-ai-copy" aria-hidden="true">
        <span className={done ? "is-off" : undefined}>{label}</span>
        <span className={done ? undefined : "is-off"}>已複製</span>
      </span>
    </button>
  );
}
