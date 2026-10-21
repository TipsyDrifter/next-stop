/**
 * TicketDraftRow——今日清單尾端的臨時車票草稿列（M3 ③ WP3；a18–a21／決策 6／M3-6）。
 *
 * 視覺真相＝prototypes/m3-mood-c2-pastel.html **:783-808（4・無路線 臨時車票）逐字**：
 *   .ticket > .stub（.badge.dashed「臨」／.line-name「無路線」／.serial）
 *          ＋ .body（.fare-class「臨時券」／`.title` 標題／.meta）
 *          ＋ .stamp-zone（.stamp > .hint 検印）
 *   標題輸入框只帶 `title`：臨時券標題全 App 黑體（D-筆-32，原本 C2 的手寫 `.hw` 已拿掉），與已建立的臨時券一致。
 *
 * 與已建立的票唯一的差別（原型沒有草稿態）：
 *   - .ticket.draft 虛線邊（沿大綱 DraftRow 語彙，today.css 已有）
 *   - .serial 還沒有票號（建立後才由 repository 給 MMDD-NN）→ 這一格留白，不編假票號
 *   - .meta 末尾一句操作提示（.status.idle 之外的淡字），Esc／建立後即消失
 *
 * 契約（TodayView 照這份呼叫，不要改簽名）：
 *   afterId   插在哪張票之後（null＝清單末尾）；本檔只拿它當 focusKey，版位由 TodayView 決定
 *   onCommit  建票（controller 負責 kind=ticket／parent_id=null／執行日＝今天／連打）
 *   onCancel  Esc／空白提交，收掉草稿
 *   kind      today＝排今天的臨時券（Enter）／inbox＝無日期票（Shift+Enter，建完流入收件匣）
 *             ——只換提示語與 placeholder，建票規則在 controller 那一側
 *   onKindChange（磨光⑤ K3，選填）給了才畫 meta 最右的「無日期」切換
 */
import { InlineInput } from "../outline/InlineInput";

export interface TicketDraftRowProps {
  /** 插在這張票之後；null＝清單末尾 */
  afterId: string | null;
  onCommit(title: string): Promise<void>;
  onCancel(): void;
  /** today＝排今天的臨時券（Enter）／inbox＝無日期票（Shift+Enter，流入收件匣） */
  kind?: "today" | "inbox";
  /**
   * 磨光⑤ K3：給了才畫「無日期」切換（對齊手機輸入列的 .m-nt-toggle）。點一下在 today／inbox 間切，
   * 由呼叫端換掉草稿的 kind（今日頁＝controller.openDraft／createInboxTicket）；輸入框是同一顆、打到一半的字留著。
   * 不給（串流某一天的草稿：日期已經是那一天）＝不畫。
   */
  onKindChange?(kind: "today" | "inbox"): void;
}

export function TicketDraftRow({ afterId, onCommit, onCancel, kind = "today", onKindChange }: TicketDraftRowProps) {
  const inbox = kind === "inbox";
  return (
    <li className="ticket-li">
      <article className="ticket draft">
        {/* 票根（C2 :785-789）：無路線＝虛線「臨」；票號等建立後才有，這裡留白 */}
        <div className="stub" style={{ color: "var(--route-none)" }}>
          <span aria-hidden className="badge dashed">
            臨
          </span>
          <span className="line-name">無路線</span>
        </div>

        {/* 票面（C2 :790-801） */}
        <div className="body">
          <span className="fare-class" aria-hidden>
            臨時券
          </span>

          {/* 標題＝黑體（.title；D-筆-32） */}
          <InlineInput
            placeholder={inbox ? "放進收件匣的一件事…" : "臨時想到的一件事…"}
            ariaLabel={inbox ? "輸入收件匣車票名稱" : "輸入臨時車票名稱"}
            focusKey={`${kind}:${afterId ?? "$end"}`}
            className="title"
            onCommit={(text) => void onCommit(text)}
            onCancel={onCancel}
            onTab={() => onCancel()}
          />

          <div className="meta">
            <span className="status idle">未開始</span>
            <span className="sep">・</span>
            <span>臨時車票</span>
            <span className="sep">・</span>
            <span>{inbox ? "Enter 放進收件匣・Esc 取消" : "Enter 新增・連按繼續加・Esc 取消"}</span>
            {/* 「無日期」切換（磨光⑤ K3）：排在 meta 最右。tabIndex=-1＋mousedown 不搶焦點——焦點一離開輸入框，
                InlineInput 的 blur 就會把打到一半的字提交出去；鍵盤要切用 Shift+Enter 開的那一種就好 */}
            {onKindChange && (
              <button
                type="button"
                role="switch"
                tabIndex={-1}
                aria-checked={inbox}
                aria-label="無日期——建好直接放進收件匣"
                title="不排日期，建好放進收件匣"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onKindChange(inbox ? "today" : "inbox")}
                className={"draft-nodate" + (inbox ? " is-on" : "")}
              >
                無日期
              </button>
            )}
          </div>
        </div>

        {/* 検印欄：草稿還不能蓋章（today.css 已把 .draft .stamp 設成 pointer-events:none） */}
        <div className="stamp-zone">
          <span aria-hidden className="stamp">
            <span className="hint">検印</span>
          </span>
        </div>
      </article>
    </li>
  );
}
