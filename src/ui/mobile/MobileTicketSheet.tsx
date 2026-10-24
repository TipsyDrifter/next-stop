/**
 * MobileTicketSheet——手機票卡 ⋯ 的底部 sheet（主線車次①；P11、契約 §4.6）。兩子頁共用：
 *   今日子頁：onDefer ⇒ useMobileToday.defer、onSkip ⇒ useMobileToday.skip
 *   行程表串流：onDefer ⇒ scheduleActions.defer、onSkip ⇒ scheduleActions.suspend
 *
 * 為什麼是底部 sheet 而不是桌機那張 DeferPopover：小卡是 anchor 定位＋日期選擇＋定期券分支的完整浮層，
 *   一張錨在票旁的小卡在 375px 會遮住列；底部 sheet 拇指按得到、暗幕點哪都關得掉。
 *   「取消」是清清楚楚的一格，不只依賴點暗幕——觸控裝置上暗幕關閉是隱性知識。
 *
 * 項目（由上而下；原型 openTicketSheet :1655-1672 的文案）：
 *   定期券且非唯讀 ｜「本班運休」或「取消運休」（card.suspended 決定）＋ aside railDate。不出「編輯規則…」（手機沒有側板）
 *   已交代的非定期券｜一行說明「已蓋済——先取消済章才能推遲」（不可點）
 *   其餘            ｜①推遲到明天／往後推一天／排到明天（sheetDeferItems）②下週一 ③選日期…（共用 MobileDatePicker；丙-3 起可挑過去＝補記）
 *                    ④清除執行日（aside：回到締切 M/D／進收件匣；本來就沒排 ⇒ 不可點的一行）
 * DOM：UI 丙-3 起是共用 `MSheet list`（見檔頭末段〈UI 丙-3〉；v1.1.0～丙-2 是自畫的 `.m-sheet-veil > .m-sheet` 小卡）。
 * 「選日期…」不翻成原型那張月曆 sheet，改開共用的 `MobileDatePicker`（旅客筆記車次② 抽出的共用件；接縫 33）。
 *
 * **主線②（契約 §4.5-3）**：時刻項。
 *   非定期券、未交代｜「選日期…」之後插「幾點…」（aside：`14:00・90 分`／「未排」）→ 開 MobileTimeSheet（rule）
 *   定期券、非唯讀  ｜最上面「本班改時刻…」（aside：覆寫中「本班 09:30」／「本班 不排時刻」，否則「每班 07:00」）→ run；
 *                    「每班時刻…」（aside「07:00」／「未排」）→ rule（原型沒畫，雙端同等補——桌機側板的「幾點」就是每班，✎）
 *   已交代的非定期券、唯讀卡｜不出時刻項（唯讀卡的 ⋯ 本來就 disabled）。
 *   時刻 sheet 與「選日期…」同一種接法：本 sheet 收起、改畫子面板；子面板關了＝整個流程結束。
 *
 * **磨光① 加工單（契約 §2.4、§9.5；D-主-49）**：手機補可點入口。全部只在 `!card.readOnly`（虛班次、歷史班次一項都不出）。
 *   順序（由上而下）：推遲／時刻 → 改名… → 記乘務記錄… → 上移／下移 → 各線附加項 → 刪除（朱字）→ 取消。
 *   改名…／記乘務記錄…＝子面板 MobileTextSheet（同「幾點…」的接法；返回鍵＝整個流程結束，跟按 × 一樣——同一層，由主人登記）。
 *   上移／下移＝`reorder` 有給才出（只有今日子頁、today 分區、沒有時刻的票；行程表串流不給）；到頂／到底那一格不可點。
 *   刪除＝先關本 sheet、再叫 `onDelete`（子項 ≥5 的確認框、toast＋復原都在呼叫端；D-2）。
 *   各線附加項（荷札…）排在刪除之上：刪除固定貼著取消，是整張 sheet 唯一的破壞性動作。
 *
 * **磨光⑤ B1「移動到…」（D-主-49 順序延伸、D-主-55）**：排在「記乘務記錄…」之後、上移／下移之前；`onMove` 有給才出。
 *   按下去＝本 sheet 收起、改畫「掛到哪」挑選器（旅客筆記的 MobileAttachPicker 搬遷模式：藏掉自己與子樹、目前位置不可點）。
 *   返回層：挑選器自己登記（第二層＝「‹ 路線」、第一層＝取消），取消＝整個流程結束（同其他子面板）。
 *   能挑什麼依種類（domain/moveTo）：車票、車廂 → 列車／車廂；列車 → 路線／支線。
 *
 * **UI 丙-3（契約 §1 F3／F5；視覺規範 §2.4「手機底部 sheet」）**：
 *   - 殼換共用 `MSheet list`（拉柄、襯線標題＝票名、52px 列、取消由殼補在最後）；列換 `MSheetItem`（刪除 `danger` 赭字、貼著取消）。
 *     右側小字（M/D、時刻）是 `.m-tks-aside`；不可點的說明列（已蓋済、過去的班次、目前未排）是 `.m-tks-note`；上移／下移一列兩格
 *     `.m-tks-pair`（樣式都在 mobile-polish.css）。各線附加項（荷札…、発車）是別線的元件、自己畫 `MSheetItem`（UI 丙-6／丙-7 起），照原樣插在刪除之上。
 *   - 子面板：幾點…＝MobileTimeSheet、改名…／記乘務記錄…＝MobileTextSheet，兩支也是 `MSheet`；選日期…＝共用 `MobileDatePicker`
 *     （DateChip 手機版同一張，全 App 的日期 sheet 同一種）；移動到…＝旅客筆記的 MobileAttachPicker（自己登記返回層）。
 *   - 返回層：呼叫端用 `backId` 登記整個流程那一層（MobileToday `core.todaySheet`、MobileSchedule `core.scheduleSheet`），
 *     本檔把同一個 id 傳給每一張 MSheet ⇒ backStack refcount 合併成一層，返回鍵按一次就關（不會變兩層，契約 §7-2）。
 *     日期面板也拿同一個 id（UI 丙-4 C6：MobileDatePicker 給了 backId 就換 MSheet 殼、kind 照預設 "sheet"＝呼叫端登記的那種）。
 *   - 選日期…（E20 手機補記）：拿掉 `min＝今天`、快選換「今天／昨天／前天」（`dateQuickSet("backward")`，§2.5 往前那套）；
 *     挑到今天以前＝補記、今天以後＝推遲，分流在呼叫端的 `defer`（今日子頁＝useMobileToday → pickDay.ts；行程表＝scheduleActions）。
 */
import { useState, type ReactNode } from "react";
import { nodeRepo } from "../../data";
import type { NodeKind } from "../../domain";
import { currentDest, moveTargetRule, type MoveDest } from "../../domain/moveTo";
import type { AttachTarget } from "../../domain/notes";
import { useNodeStore } from "../../store/nodeStore";
import { MobileAttachPicker } from "../common/MobileAttachPicker";
import "../common/moveTo.css";
import { MobileDatePicker } from "../common/MobileDatePicker";
import { dateQuickSet } from "../common/DateChip";
import { MSheet, MSheetItem } from "../common/MSheet";
import { useUiStore } from "../../store/uiStore";
import { useMinuteTick } from "../schedule/useMinuteTick";
import { MobileTimeSheet } from "./MobileTimeSheet";
import { MobileTextSheet } from "./MobileTextSheet";
import "./mobile-polish.css";
import { mdw, sheetDeferItems } from "../schedule/streamModel";
import type { TicketCardModel } from "../schedule/ticketCard";
// 各線附加項：查 `lines/runtime`、不 import `lines/mounts`（理由見 runtime.ts 檔頭）
import { lineTicketSheetItems } from "../../lines/runtime";

/** M/D（aside 的「回到締切 M/D」） */
function md(key: string): string {
  return `${Number(key.slice(5, 7))}/${Number(key.slice(8, 10))}`;
}

export interface MobileTicketSheetProps {
  card: TicketCardModel;
  today: string;
  /** null＝清除執行日 */
  onDefer(day: string | null): void;
  /** 定期券版：本班運休（true）／取消運休（false） */
  onSkip(skip: boolean): void;
  /** 每班／單發票的時刻（＋預計）；time=null＝不排時刻；estimateMin 為 undefined＝預計沒變（主線②） */
  onSetTime(time: string | null, estimateMin?: number | null): void;
  /** 定期券這一班的時刻；null＝本班不排時刻 */
  onSetRunTime(time: string | null): void;
  /** 定期券這一班改回每班時刻 */
  onClearRunTime(): void;
  /** 改名（已去空白、非空）；沒給＝不出「改名…」 */
  onRename?(name: string): void;
  /** 記乘務記錄（已去空白、非空）；沒給＝不出「記乘務記錄…」 */
  onLog?(body: string): void;
  /** 移動到挑好的新父節點（磨光⑤ B1；本 sheet 已先關）；沒給＝不出「移動到…」 */
  onMove?(dest: MoveDest): void;
  /** 刪除（本 sheet 已先關）；沒給＝不出「刪除」 */
  onDelete?(): void;
  /** 上移／下移：null／沒給＝不出（行程表串流、誤點區、有時刻的票）；up／down＝那一格可不可點 */
  reorder?: { up: boolean; down: boolean; onMove(delta: -1 | 1): void } | null;
  /** 返回層 id：呼叫端已用同一個 id 登記整個流程（含子面板）那一層；傳給每一張 MSheet，refcount 合併成一層 */
  backId: string;
  onClose(): void;
}

export function MobileTicketSheet({
  card,
  today,
  onDefer,
  onSkip,
  onSetTime,
  onSetRunTime,
  onClearRunTime,
  onRename,
  onLog,
  onMove,
  onDelete,
  reorder,
  backId,
  onClose,
}: MobileTicketSheetProps) {
  /** 「選日期…」按下去：sheet 收起、改開日期面板（面板關了＝整個流程結束） */
  const [picking, setPicking] = useState(false);
  /** 「幾點…」「每班時刻…」（rule）／「本班改時刻…」（run）按下去：改畫時刻 sheet */
  const [timeMode, setTimeMode] = useState<"rule" | "run" | null>(null);
  /** 「改名…」／「記乘務記錄…」按下去：改畫一行輸入子面板 */
  const [textMode, setTextMode] = useState<"rename" | "log" | null>(null);
  /** 「移動到…」按下去：挑選器的 value（目前位置）；null＝沒在挑 */
  const [moveFrom, setMoveFrom] = useState<AttachTarget | null>(null);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const now = useMinuteTick();
  const moveRule = onMove ? moveTargetRule(card.kind) : null;

  /** 先問到父節點的種類才開挑選器（要標「目前位置」）；卡片只帶 nodeId，父節點從 repository 讀 */
  const startMove = async () => {
    const node = await nodeRepo.getNode(card.nodeId);
    if (!node) return onClose();
    let parentKind: NodeKind | null = null;
    if (node.parent_id) {
      parentKind = useNodeStore.getState().routes.some((r) => r.id === node.parent_id)
        ? "route"
        : ((await nodeRepo.getNode(node.parent_id))?.kind ?? null);
    }
    setMoveFrom(currentDest(node.parent_id, parentKind, node.route_id));
  };

  if (moveFrom && moveRule && onMove) {
    return (
      <MobileAttachPicker
        title={moveRule.label}
        depth={moveRule.depth}
        kinds={moveRule.depth === "node" ? moveRule.kinds : undefined}
        routeSelectable={moveRule.routeSelectable}
        value={moveFrom}
        excludeId={card.nodeId}
        currentNote="目前位置"
        onPick={(t) => {
          onClose();
          onMove({ routeId: t.routeId, nodeId: t.nodeId });
        }}
        onClose={onClose}
      />
    );
  }

  if (textMode === "rename" && onRename) {
    return (
      <MobileTextSheet
        title="改名"
        name={card.name}
        initial={card.name}
        submitLabel="改好了"
        inputLabel="車票的新名稱"
        backId={backId}
        onSubmit={(name) => {
          onRename(name);
          onClose();
        }}
        onClose={onClose}
      />
    );
  }

  if (textMode === "log" && onLog) {
    return (
      <MobileTextSheet
        title="記乘務記錄"
        name={card.name}
        initial=""
        placeholder="寫一行剛才做了什麼"
        submitLabel="記下"
        inputLabel="新增工作日誌"
        backId={backId}
        onSubmit={(body) => {
          onLog(body);
          onClose();
        }}
        onClose={onClose}
      />
    );
  }

  if (timeMode) {
    return (
      <MobileTimeSheet
        card={card}
        mode={timeMode}
        today={today}
        dayStartHour={dayStartHour}
        now={now}
        backId={backId}
        onCommit={(time, est) => {
          if (timeMode === "run") onSetRunTime(time);
          else onSetTime(time, est);
          onClose();
        }}
        onClear={() => {
          if (timeMode === "run") onSetRunTime(null);
          else if (card.ruleTime !== null) onSetTime(null);
          onClose();
        }}
        onReset={
          timeMode === "run"
            ? () => {
                onClearRunTime();
                onClose();
              }
            : undefined
        }
        onClose={onClose}
      />
    );
  }

  if (picking) {
    return (
      <MobileDatePicker
        title="選執行日"
        value={card.scheduledOn}
        today={today}
        quick={dateQuickSet("backward", today)}
        onPick={(d) => {
          onClose();
          // 挑回現值不動（呼叫端的分流也會擋；這裡先擋，免得行程表那條路多吐一張收據）
          if (d !== card.scheduledOn) onDefer(d);
        }}
        onClose={onClose}
        backId={backId}
      />
    );
  }

  const settled = card.done || card.suspended;
  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

  /** aside 的時刻字（拉丁數字，.hm） */
  const hm = (t: string) => <b className="hm">{t}</b>;
  const aside = (children: ReactNode) => <span className="m-tks-aside">{children}</span>;
  /** 不可點的說明列（不是按鈕：↑↓ 不停在上面） */
  const note = (text: string) => <p className="m-tks-note">{text}</p>;
  const est = card.estimateMin !== null && card.estimateMin > 0 ? card.estimateMin : null;

  let items: ReactNode;
  if (card.isRepeat && !card.readOnly) {
    items = (
      <>
        {card.railDate && (
          <MSheetItem onClick={() => setTimeMode("run")}>
            本班改時刻…
            {aside(
              card.timeOverridden ? (
                <>本班 {card.time !== null ? hm(card.time) : "不排時刻"}</>
              ) : card.ruleTime !== null ? (
                <>每班 {hm(card.ruleTime)}</>
              ) : (
                "未排"
              ),
            )}
          </MSheetItem>
        )}
        <MSheetItem onClick={() => setTimeMode("rule")}>
          每班時刻…
          {aside(card.ruleTime !== null ? hm(card.ruleTime) : "未排")}
        </MSheetItem>
        <MSheetItem onClick={run(() => onSkip(!card.suspended))}>
          {card.suspended ? "取消運休" : "本班運休"}
          {card.railDate && aside(mdw(card.railDate))}
        </MSheetItem>
      </>
    );
  } else if (card.readOnly) {
    // 最後一道守門：定期券的歷史班次不出單發票那組項目（推遲／幾點…／清除執行日）
    items = note("過去的班次不能改");
  } else if (settled) {
    items = note("已蓋済——先取消済章才能推遲");
  } else {
    const { first, monday } = sheetDeferItems(card.railDate, card.scheduledOn, today);
    items = (
      <>
        <MSheetItem onClick={run(() => onDefer(first.day))}>
          {first.label}
          {aside(mdw(first.day))}
        </MSheetItem>
        <MSheetItem onClick={run(() => onDefer(monday))}>
          下週一
          {aside(mdw(monday))}
        </MSheetItem>
        <MSheetItem onClick={() => setPicking(true)}>選日期…</MSheetItem>
        <MSheetItem onClick={() => setTimeMode("rule")}>
          幾點…
          {aside(
            card.ruleTime !== null ? (
              <>
                {hm(card.ruleTime)}
                {est !== null && `・${est} 分`}
              </>
            ) : (
              "未排"
            ),
          )}
        </MSheetItem>
        {card.scheduledOn === null ? (
          note("清除執行日（目前未排）")
        ) : (
          <MSheetItem onClick={run(() => onDefer(null))}>
            清除執行日
            {aside(card.dueOn ? `回到締切 ${md(card.dueOn)}` : "進收件匣")}
          </MSheetItem>
        )}
      </>
    );
  }

  return (
    <MSheet list title={card.name} backId={backId} onClose={onClose}>
      {items}
      {/* 磨光① 加工單：改名…／記乘務記錄…／上移・下移（唯讀的卡一項都不出，D-1） */}
      {!card.readOnly && onRename && <MSheetItem onClick={() => setTextMode("rename")}>改名…</MSheetItem>}
      {!card.readOnly && onLog && <MSheetItem onClick={() => setTextMode("log")}>記乘務記錄…</MSheetItem>}
      {!card.readOnly && moveRule && <MSheetItem onClick={() => void startMove()}>移動到…</MSheetItem>}
      {!card.readOnly && reorder && (
        <div className="m-tks-pair">
          <MSheetItem disabled={!reorder.up} title={reorder.up ? undefined : "已經在最上面"} onClick={run(() => reorder.onMove(-1))}>
            上移
          </MSheetItem>
          <MSheetItem
            disabled={!reorder.down}
            title={reorder.down ? undefined : "已經在最下面"}
            onClick={run(() => reorder.onMove(1))}
          >
            下移
          </MSheetItem>
        </div>
      )}
      {/* 各線附加項（接縫 #56 後半；旅客筆記：荷札…、時刻表：発車）——別線的元件自己畫 MSheetItem；唯讀的卡（定期券歷史班次）不出 */}
      {!card.readOnly &&
        lineTicketSheetItems().map(({ id, Item }) => <Item key={id} nodeId={card.nodeId} name={card.name} close={onClose} />)}
      {/* 刪除：先關 sheet 再問（D-2）；赭字、最後（貼著殼補的「取消」） */}
      {!card.readOnly && onDelete && (
        <MSheetItem
          danger
          onClick={() => {
            onClose();
            onDelete();
          }}
        >
          刪除
        </MSheetItem>
      )}
    </MSheet>
  );
}
