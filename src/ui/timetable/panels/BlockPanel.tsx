/**
 * BlockPanel——補記（sheet.kind "fill"）／改一塊（"edit"）面板（車次①a 契約 §5.4；丙席；＝原型 `shared.js` openBlockSheet，
 * 拿掉綁車票與備註）。
 * 副標「HH:MM – HH:MM　・　Xh」；蓋到既有紀錄時赭字 W1；分類格 compact；
 * 「発車」stepper −5／HH:MM／+5＋「接上一塊」；「到着」stepper −5／HH:MM／+5＋「接下一塊」
 * （補記：上下界＝那段空白的兩端；改：上一塊尾／下一塊頭；到着不得晚於現在）；
 * 改的時候多「刪除」「切開」兩顆次鈕；主鈕「補上」／「改好了」。
 *
 * 車次①b（①b①c 契約 §5.2；乙席；長相＝原型 `v-e.js` 情境 4 editBody、D-時-33）：
 * - 貼齊：目標是 null（看的那一天裡沒有上一塊／下一塊）時「接上一塊／接下一塊」不畫（①a 照畫、按了沒反應）。
 *   跨日的貼齊不補（只找看的那一天）——改用「與上一塊合併」，它查 DB、帶 bound。
 * - 合併（只在改一塊）：div.ns-tt-merge 一列「與上一塊合併／與下一塊合併」；掛上時各問一次 store.previewMerge，
 *   null ⇒ 那顆 disabled。按下其中一顆 ⇒ 面板收成「副標＋合併列＋確認框」（分類格、時刻、底部鈕先收起；手機不用捲就
 *   看得到確認鈕），確認框 div.ns-tt-merge-confirm：B2 預覽一行＋說明＋「算了」「確認合併」；軸上那兩塊描金邊
 *   （setMergeMarks）。主鈕「改好了」在確認框開著時不在畫面上（互斥）。
 *   bound：上＝看的那天的起點；下＝min(那天的終點, 現在)。
 *
 * 車次②（② 契約 §5.5；乙席；長相＝原型 `v-f.js` editBody／fillBody）：副標之後一列「連到」（LinkRow）——改一塊預設＝這一塊
 * 目前的連結、補記預設沒連；點了面板換成 LinkPicker 子頁（‹ 回來；選了就回來）。主鈕：補記＝`fill(cat, s, e, link)`；
 * 改好了＝`editBlock(..., link)`，**沒動過連結就傳 undefined**（不動）。沒動過時，面板開著別台改了這一塊的連結 ⇒ 跟著顯示新的。
 *
 * 車次⑥（⑥ 契約 §5.1、0-12；D-時-115、125、127；乙席；長相＝原型 `v-tags.js` blockBody）：「連到」之後一列「荷札」
 * （div.ns-tt-row.ns-tt-tagrow）：分類帶的淡牌（`FixedTagChips`；滑過「來自分類「X」／來自組「X」」；可排除見下；改分類即時換）＋手動的。
 * **手動的是草稿**（D-時-125）：桌機 `EntityTagField` 受控模式（exclude＝分類帶的 key、建議清單往下推開）；手機牌子＋「掛荷札」
 * 開點選器 insert 模式、交回的名稱併進草稿。同一個 key 手動與分類帶的都有 ⇒ 只畫手動那顆（D-時-127）。
 * 按「改好了／補上」才把草稿交給 store：補記＝`fill(..., link, tagNames)`；改一塊＝`editBlock(..., linkPicked, tagNames)`，
 * **沒動過荷札就傳 undefined**（不動）；按「取消」全部放棄。草稿面板裡的牌子不能點（點了會離開面板、草稿就丟了）。
 * 評審後（資料語義第 1 條）：改一塊時記下「面板打開時的手動荷札」（index 載好那一刻的 keysOf），送出只交差集
 * （`blockTagEditOf` → store 逐個 attach／detach；沒變＝不寫），不整份 setTags；index 還沒載好 ⇒ 荷札列只寫「荷札載入中…」、不給編輯。
 * 桌機的荷札欄直接 import tags/EntityTagField（不經 ui/notes/desktop.ts 的 barrel；偏差記錄 10-20）。
 *
 * 磨光③（契約 §2-1、2-8、2-12；D-時-134、136）：
 * - 單塊排除：分類帶的牌子加 ×（桌機滑過才出現、手機常顯），× 了刪除線淡字留原位、↺ 或點牌子還原（原型定案 A1）。
 *   **也是草稿**：按「改好了／補上」才連同手動荷札一起交給 store（`offNames`；沒動過＝undefined 不動），取消全放棄。
 *   面板只改「現在畫出來的那幾顆」的排除：換了分類後看不到的舊排除照留（改分類不裁，D-時-135）。
 * - 手機點選器標題：「荷札・娛樂 23:20」（補記還沒選分類＝「荷札・補記」）。
 * - 荷札 index 載入失敗：「荷札載入中…」換成「荷札沒載入　重試」（重試＝`tagStore.loadIndex()`）。
 *
 * 磨光⑥（契約 §1-1、1-2、1-4、1-5½；D-時-142～147）：
 * - 発車／到着換成可打字的 Stepper（−1h −15 −5 −1｜框｜+1 +5 +15 +1h）；「接上一塊／接下一塊」換到下一行，按了丟掉框裡的草稿。
 *   発車 Enter 確定後焦點跳到着。桌機開補記游標在発車框、連續補換段後在到着框；手機不自動叫鍵盤。
 * - 補記那段一路到現在：到着的快捷叫「接到現在」（貼到面板打開那一刻的現在）。
 * - 「補上／改好了」：失焦那一刻已套用合法草稿；剛打錯的框（`clockDraftsOk`）⇒ 不送出、焦點回框。
 * - 連續補：補上後那段還有剩（`fillContinuation`：後面優先、跳過的前段帶在 cont.rest）⇒ 面板不關、換到剩下那段
 *   （`openSheet({ kind: "fill", ..., cont })`；SheetPanel 用起訖當 key 重掛，分類／連結／荷札草稿都從頭來）；
 *   副標第二行「剩下 X–Y 還沒記」、取消改叫「先這樣」。補滿照舊關。寫入不等（fill 失敗照舊 toast，面板照開）。
 *   換段後面板捲回頂（那一行才看得到）；桌機自動聚焦的到着框若被黏底的按鈕列擋住，再往下捲到剛好露出（評審 #4）。
 *
 * 磨光⑤ §8 甲′（使用者 10-21：補記睡覺 01:30–10:30 變成 33 小時；D-主-64、65）：
 * - 発車／到着框下一律寫日期（usePanelRefDay：參考日＝這一塊開始那天，落在看的那一天裡就是看的那一天）；另一天赭色。
 * - 起訖超過 12 小時（longBlockAsk）⇒ 按鈕列最上面多一行「這一塊有 N 小時 M 分，跨到 {日期}——確定嗎？」＋「確定記這麼長」；
 *   按「補上／改好了」不存、抖一下那一行並把焦點放到確定鈕；按確定鈕才存。12 小時內照舊直接存。
 *   改一塊時只在起訖動過才問（本來就這麼長、只改分類／連結／荷札的不必每次都確認）。
 * - 確認綁在「按下那一刻畫著的起訖」（評審）：框裡沒提交的草稿會在按確定鈕的那一下失焦才提交、句子跟著換——
 *   按下時記起訖（`longSeen`），放開時跟提交後的比，不一樣＝確認的不是這個長度 ⇒ 不存、抖一下讓人重看。
 *
 * 磨光⑤ 收尾：
 * - 走「確定記這麼長」存的塊一併記成已確認（fill／editBlock 的 longOk ⇒ long_run_ack＝1；沙盒 O1：不然軸上照標「待確認」）。
 * - 確認行收起時留同高空白（hold），捲到底的面板內容不往下掉（自測 ②）。
 * - 連續補「剩下 X–Y 還沒記」的端點跟參考日不同天時加日期（沙盒 O6）。
 */
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { MIN, fmtClock, fmtDur, msOf, type BlockLink, type MergePreview } from "../../../domain/timetable";
import { linkOfRow } from "../../../domain/timetableLink";
import { fillContinuation } from "../../../domain/timetableFillCont";
import { clockDateLabel, longBlockAsk } from "../../../domain/timetableClockInput";
import { TT_TEXT, useTimetableStore } from "../../../store/timetableStore";
import { useUiStore } from "../../../store/uiStore";
import { dayWindow } from "../../../lib/date";
import { CategoryGrid } from "../parts/CategoryGrid";
import { LinkPicker, LinkRow } from "../parts/LinkPicker";
import { TT_TAG_BLOCK } from "../../../domain/timetableTags";
import { useTagStore } from "../../../store/tagStore";
import { EntityTagField } from "../../notes/tags/EntityTagField";
import { blockTagEditOf } from "../../../data/timetableTagCarry";
import { useShell } from "../../mobile/useShell";
import { useBackLayer } from "../../mobile/backStack";
import { FixedTagChips, MobileTagDraft, draftKeys, fixedTagsOf, tagNameOf, useTimetableTagMaps } from "../parts/TimetableTagChips";
import {
  Actions,
  Expand,
  Opt,
  Row,
  Stepper,
  Sub,
  clamp,
  clockDraftsOk,
  setMergeMarks,
  useBlock,
  useCoverWarn,
  useNowOnce,
  usePanelRefDay,
  type PanelProps,
} from "./controls";
import type { ClockInputHandle } from "./ClockInput";

type Dir = "prev" | "next";

export function BlockPanel({ onDone }: PanelProps) {
  const now = useNowOnce();
  const sheet = useTimetableStore((s) => s.sheet);
  const mode: "fill" | "edit" = sheet?.kind === "edit" ? "edit" : "fill";
  const blockId = sheet?.kind === "edit" ? sheet.blockId : "";
  const block = useBlock(blockId);
  const dayBlocks = useTimetableStore((s) => s.dayBlocks);
  const fill = useTimetableStore((s) => s.fill);
  const editBlock = useTimetableStore((s) => s.editBlock);
  const deleteBlock = useTimetableStore((s) => s.deleteBlock);
  const openSheet = useTimetableStore((s) => s.openSheet);
  const catById = useTimetableStore((s) => s.catById);
  const dayKey = useTimetableStore((s) => s.dayKey);
  const previewMerge = useTimetableStore((s) => s.previewMerge);
  const mergeBlock = useTimetableStore((s) => s.mergeBlock);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const running = useTimetableStore((s) => s.running);
  const todayBlocks = useTimetableStore((s) => s.todayBlocks);

  // 合併：兩側的預演（undefined＝還在問）；ask＝二次確認開著的那一側
  const dw = dayWindow(dayKey, dayStartHour);
  const boundOf = (d: Dir): number => (d === "prev" ? msOf(dw.start) : Math.min(msOf(dw.end), now));
  const [previews, setPreviews] = useState<{ prev?: MergePreview | null; next?: MergePreview | null }>({});
  const [ask, setAsk] = useState<Dir | null>(null);
  const mergeId = mode === "edit" && block && block.ended_at !== null ? block.id : null;
  const mergeSig = block ? `${block.started_at}|${block.ended_at}|${block.category_id}` : "";
  useEffect(() => {
    if (!mergeId) return;
    let alive = true;
    const ask1 = (d: Dir): Promise<MergePreview | null> => previewMerge(mergeId, d, boundOf(d)).catch(() => null);
    void Promise.all([ask1("prev"), ask1("next")]).then(([prev, next]) => {
      if (alive) setPreviews({ prev, next });
    });
    return () => {
      alive = false;
    };
    // boundOf 隨 dayKey／dayStartHour 變（now 是面板掛上時固定的值）；mergeSig＝這一塊被別台改了就重問
  }, [mergeId, mergeSig, dayKey, dayStartHour, previewMerge]);
  const askPreview = ask ? (previews[ask] ?? null) : null;
  // 軸上描金邊：這一塊＋合併後留下的那一塊
  useEffect(() => {
    if (ask && askPreview && block) setMergeMarks(askPreview.keepId === block.id ? [block.id] : [block.id, askPreview.keepId]);
    else setMergeMarks([]);
  }, [ask, askPreview, block]);
  useEffect(() => () => setMergeMarks([]), []);

  // 磨光⑥ 1-2：補記那段一路到現在？連續補換過來的段照帶來的旗子；軸上點開的：那段的尾就是當時畫面的「現在」（軸的時鐘
  // 不是每毫秒跳，所以比面板的 now 早一點），用「離現在不到 5 分、沒有運行中那班、之後沒有任何一塊」判
  const toNow =
    sheet?.kind === "fill" &&
    (sheet.cont
      ? sheet.cont.toNow
      : sheet.end >= now ||
        (now - sheet.end < 5 * MIN && running === null && ![...dayBlocks, ...todayBlocks].some((b) => msOf(b.started_at) >= sheet.end)));
  const fillEnd = sheet?.kind === "fill" ? (toNow ? now : Math.min(sheet.end, now)) : now;

  // 初值：補記＝那段空白的兩端（一路到現在的貼到現在）；改＝這一塊的起訖
  const init = (() => {
    if (sheet?.kind === "fill") return { start: sheet.start, end: fillEnd, cat: null as string | null };
    if (block) return { start: msOf(block.started_at), end: block.ended_at ? msOf(block.ended_at) : now, cat: block.category_id };
    return { start: now - MIN, end: now, cat: null as string | null };
  })();
  const [start, setStart] = useState(init.start);
  // 磨光⑤ 甲′：兩格共用的參考日（到着初值常在隔天，不能各自算）
  const refDay = usePanelRefDay(init.start);
  // 長塊確認行：按了「補上／改好了」沒確認 ⇒ 抖一下、焦點放到確定鈕
  const [longNudge, setLongNudge] = useState(0);
  const longRowRef = useRef<HTMLDivElement>(null);
  /** 確定鈕按下（pointerdown，早於時刻框失焦提交草稿）那一刻畫著的起訖 */
  const longSeen = useRef<{ start: number; end: number } | null>(null);
  const endClock = useRef<ClockInputHandle | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // 連續補換段（評審 #4）：重掛不會把捲動容器捲回去 ⇒ 「剩下 X–Y 還沒記」會留在畫面外。掛上時捲回頂；桌機到着框已自動
  // 聚焦（子元件的 effect 先跑）：若它因此躲到底部黏住的按鈕列後面，只往下捲到剛好露出框——面板只高出一點時兩行都看得到
  useEffect(() => {
    const root = rootRef.current;
    if (!root || sheet?.kind !== "fill" || !sheet.cont) return;
    const box = root.closest<HTMLElement>(".ns-dialog-body, .ns-tt-sheet");
    if (!box) return;
    box.scrollTop = 0;
    const input = document.activeElement instanceof HTMLInputElement && root.contains(document.activeElement) ? document.activeElement : null;
    if (!input) return;
    const actions = root.querySelector(".ns-tt-actions");
    const floor = Math.min(box.getBoundingClientRect().bottom, actions?.getBoundingClientRect().top ?? Infinity);
    const need = input.getBoundingClientRect().bottom + 6 - floor;
    if (need > 0) box.scrollTop += need;
  }, []);
  const [end, setEnd] = useState(init.end);
  const [cat, setCat] = useState<string | null>(init.cat);
  // ②：連結（undefined＝還沒動過：改一塊跟著這一塊目前的連結、補記＝沒連）；picking＝子頁開著
  const [linkPicked, setLinkPicked] = useState<BlockLink | null | undefined>(undefined);
  const [picking, setPicking] = useState(false);
  // ⑥：荷札草稿（null＝還沒動過：改一塊跟著這一塊目前的手動荷札、補記＝沒有）
  const desk = useShell() === "desktop";
  const categories = useTimetableStore((s) => s.categories);
  const tagMaps = useTimetableTagMaps();
  const tagIndex = useTagStore((s) => s.index);
  // 磨光③ 2-12：載入失敗（重試的那一下 loading 為真，照寫「載入中…」）
  const tagLoadFailed = useTagStore((s) => s.loadError !== null && s.index === null && !s.loading);
  const [tagDraft, setTagDraft] = useState<string[] | null>(null);
  const liveManual = mode === "edit" && block && tagIndex ? useTagStore.getState().keysOf(TT_TAG_BLOCK, block.id).map(tagNameOf) : [];
  const tagNames: string[] = tagDraft ?? liveManual;
  // 評審後：面板打開時的手動荷札（index 載好、這一塊找得到的第一刻記一次）＝送出時算差集的基準
  const [tagInit, setTagInit] = useState<string[] | null>(null);
  // 磨光③ 2-1：排除（keys）的草稿與基準；null＝還沒動過（跟著這一塊目前的排除）
  const [offDraft, setOffDraft] = useState<string[] | null>(null);
  const [offInit, setOffInit] = useState<string[] | null>(null);
  if (mode === "edit" && block && tagIndex && tagInit === null) {
    setTagInit(useTagStore.getState().keysOf(TT_TAG_BLOCK, block.id));
    setOffInit((tagMaps.off[block.id] ?? []).slice());
  }
  const liveOff: readonly string[] = mode === "edit" && block ? (tagMaps.off[block.id] ?? []) : [];
  const offKeys: readonly string[] = offDraft ?? liveOff;
  const toggleOff = (key: string, on: boolean): void =>
    setOffDraft((cur) => {
      const base = cur ?? liveOff.slice();
      return on ? (base.includes(key) ? base : [...base, key]) : base.filter((k) => k !== key);
    });
  // 改一塊要等基準記好才給編輯（index 沒載好時基準是空的，在上面編輯就是在空基準上改）
  const tagReady = mode === "fill" || tagInit !== null;
  const link: BlockLink | null = linkPicked !== undefined ? linkPicked : mode === "edit" && block ? linkOfRow(block) : null;
  // 面板開著時別台改了這一塊（同步拉到 ⇒ block 換新）：主人還沒動過的欄位跟著換成新的值，動過的照留（沙盒 S9）。
  // 不跟的話，「改好了」會把面板上的舊起訖／舊分類整份寫回去，蓋掉別台的修改。
  const [base, setBase] = useState(init);
  if (mode === "edit" && block && (init.start !== base.start || init.end !== base.end || init.cat !== base.cat)) {
    setBase(init);
    if (start === base.start) setStart(init.start);
    if (end === base.end) setEnd(init.end);
    if (cat === base.cat) setCat(init.cat);
  }

  // 「接上一塊／接下一塊」的目標：補記＝空白的兩端；改＝上一塊尾／下一塊頭（看的那一天裡、不含自己）
  let prevEnd: number | null = null;
  let nextStart: number | null = null;
  if (sheet?.kind === "fill") {
    prevEnd = sheet.start;
    nextStart = fillEnd;
  } else if (block) {
    for (const b of dayBlocks) {
      if (b.id === block.id || b.ended_at === null) continue;
      const e = msOf(b.ended_at);
      const s0 = msOf(b.started_at);
      if (e <= init.start && (prevEnd === null || e > prevEnd)) prevEnd = e;
      if (s0 >= init.end && (nextStart === null || s0 < nextStart)) nextStart = s0;
    }
    for (const b of dayBlocks) {
      // 運行中的下一班（例：改的是剛到站的那一塊、接著又發車）
      if (b.id === block.id || b.ended_at !== null) continue;
      const s0 = msOf(b.started_at);
      if (s0 >= init.end && (nextStart === null || s0 < nextStart)) nextStart = s0;
    }
  }

  const exceptId = mode === "edit" && block ? block.id : null;
  const changed = start !== init.start || end !== init.end;
  // 磨光⑤ 甲′：超過 12 小時要確認（補記一律看；改一塊只在起訖動過時看）
  const longAsk = mode === "fill" || changed ? longBlockAsk(start, end) : null;
  // 磨光⑤ 收尾（自測 ②）：面板捲到底時，確認行一收起內容就變矮、捲動被夾回去，整片往下掉一行——連點的下一下會點到
  // 上面那顆鈕（實際踩到「接上一塊」）。收起那一拍在原位留一塊同高的空白（hold），不讓捲動高度變；之後只在「留白不再
  // 需要」時縮（沒捲到底的面板當拍就縮成 0，捲到底的等使用者往上捲才一點一點縮），縮的過程不會讓內容跳。
  const [longShown, setLongShown] = useState(!!longAsk);
  const [hold, setHold] = useState(0);
  /** 確認行上一次畫出來佔的高度（含它跟主鈕之間的列距） */
  const longH = useRef(0);
  if (!!longAsk !== longShown) {
    setLongShown(!!longAsk);
    setHold(longAsk ? 0 : longH.current);
  }
  useLayoutEffect(() => {
    const row = longRowRef.current;
    const bar = row?.parentElement;
    if (!row || !bar) return;
    // 確認行還在、只是句子變短（不再「跨到 …」）也會矮一兩行、同樣把捲到底的內容往下拉——框的高度只增不減（框內置中）
    const box = row.firstElementChild instanceof HTMLElement ? row.firstElementChild : null;
    const h = box?.offsetHeight ?? 0;
    if (box && h > (parseFloat(box.style.minHeight) || 0)) box.style.minHeight = `${h}px`;
    longH.current = row.offsetHeight + (parseFloat(getComputedStyle(bar).rowGap) || 0);
  });
  useLayoutEffect(() => {
    if (!hold) return;
    const box = rootRef.current?.closest<HTMLElement>(".ns-dialog-body, .ns-tt-sheet");
    if (!box) {
      setHold(0);
      return;
    }
    // 拿掉留白後捲動位置還放得下＝不需要；還需要的那一截＝捲過頭的部分
    const fit = (): void => {
      const need = Math.max(0, Math.ceil(box.scrollTop + box.clientHeight - (box.scrollHeight - hold)));
      if (need < hold) setHold(need);
    };
    fit();
    box.addEventListener("scroll", fit, { passive: true });
    return () => box.removeEventListener("scroll", fit);
  }, [hold]);
  // ⑤ 契約 §5.3：補記一開就預演（方眼「更多…」會拿蓋到既有紀錄的選區開；只拿空白開時預演本來就是空的）
  const warn = useCoverWarn(start, end, exceptId, mode === "fill" ? true : changed);
  // 磨光①：手機返回鍵＝連結挑選的「‹」（疊在 timetable.sheet 上；桌機 no-op）
  useBackLayer("timetable.blockLink", picking, () => setPicking(false));

  if (mode === "edit" && !block) {
    return (
      <div className="ns-tt-panel">
        <Sub>這一塊已經不在了</Sub>
        <Actions>
          <button type="button" className="ns-btn btn-ghost" onClick={onDone}>
            關閉
          </button>
        </Actions>
      </div>
    );
  }

  if (picking) {
    return (
      <div className="ns-tt-panel ns-tt-panel-block is-picking">
        <LinkPicker
          value={link}
          onBack={() => setPicking(false)}
          onPick={(l) => {
            setLinkPicked(l);
            setPicking(false);
          }}
        />
      </div>
    );
  }

  const setStartClamped = (v: number): void => setStart(clamp(v, 0, end - MIN));
  const setEndClamped = (v: number): void => setEnd(clamp(v, start + MIN, now));

  const submit = (e: MouseEvent<HTMLButtonElement>, longOk = false): void => {
    if (!clockDraftsOk(e.currentTarget)) return;
    if (!cat) {
      useUiStore.getState().showToast({ message: TT_TEXT.pickCategory });
      return;
    }
    // 磨光⑤ 甲′：長塊沒按「確定記這麼長」就不存（失焦套用的草稿已在這一拍之前重畫進 start／end）
    if (longAsk && !longOk) {
      setLongNudge((n) => n + 1);
      // 焦點放確認行、不放確定鈕：連按兩下 Enter 或長按自動重複，第二下會直接落在確定鈕上存檔（磨光⑤ 評審）
      longRowRef.current?.focus();
      return;
    }
    const offNames = offNamesOf();
    // 磨光⑤ 收尾（沙盒 O1）：走「確定記這麼長」存的長塊＝使用者確認過長度 ⇒ 記成已確認（long_run_ack＝1），
    // 軸上不再標「長時間運行・待確認」、待確認清單也不再問一次。只有這條路；12 小時內直接存的照舊不動 ack
    const ackLong = !!longAsk && longOk;
    if (mode === "fill" && sheet?.kind === "fill") {
      // 連續補（1-4）：先算幾何、不等寫完
      const piece = { start: sheet.start, end: toNow ? now : sheet.end };
      const c = fillContinuation(piece, { start, end }, sheet.cont?.rest ?? [], now);
      if (c.next) openSheet({ kind: "fill", start: c.next.start, end: c.next.end, cont: { rest: c.rest, toNow: toNow && c.next.end >= now } });
      else onDone();
      void fill(cat, start, end, link, tagDraft ?? [], offNames, ackLong);
    } else if (block) {
      onDone();
      // 只交差集（沒動過／動完跟原本一樣 ⇒ undefined＝不寫荷札）
      const tagEdit = tagDraft !== null && tagInit !== null ? (blockTagEditOf(tagInit, tagDraft) ?? undefined) : undefined;
      void editBlock(block.id, cat, start, end, linkPicked, tagEdit, offNames, ackLong);
    }
  };

  // ⑥ 荷札列：分類帶的（跟著面板上選的分類即時換）＋手動的草稿
  const fixedTags = fixedTagsOf(cat, categories, tagMaps);
  const tagEmpty = mode === "fill" && !cat ? TT_TEXT.tags.fillHint : undefined;

  /**
   * 磨光③ 2-1：要交給 store 的排除（顯示名）。沒動過 ⇒ undefined（不動）。
   * 只改畫出來的那幾顆：基準裡現在分類沒帶的 key 照留，畫出來的那幾顆照草稿；改一塊時跟基準一樣 ⇒ undefined。
   * 手動也掛了同名的那顆不畫（hideKeys／shown），所以也不算「畫出來的」——先 × 再手動掛回，排除不會偷偷寫進去（磨光③ 評審）。
   */
  function offNamesOf(): string[] | undefined {
    if (offDraft === null) return undefined;
    const manual = new Set(draftKeys(tagNames));
    const shownKeys = new Set(fixedTags.filter((t) => !manual.has(t.key)).map((t) => t.key));
    const base = offInit ?? [];
    const out: string[] = [];
    for (const k of [...base.filter((k) => !shownKeys.has(k)), ...offDraft.filter((k) => shownKeys.has(k))]) if (!out.includes(k)) out.push(k);
    if (mode === "fill" && !out.length) return undefined;
    if (mode === "edit" && out.length === base.length && out.every((k) => base.includes(k))) return undefined;
    return out.map(tagNameOf);
  }

  // 手機點選器的標題（磨光③ 2-8）：「荷札・娛樂 23:20」；補記還沒選分類＝「荷札・補記」
  const pickTitle = cat ? TT_TEXT.tags.pickerTitle(catById[cat]?.name ?? "？", start, false) : TT_TEXT.tags.pickerFill;
  const tagRow = (
    <div className="ns-tt-row is-top ns-tt-tagrow">
      <span className="ns-tt-row-k">{TT_TEXT.tags.row}</span>
      <span className="ns-tt-row-v">
        {!tagReady ? (
          tagLoadFailed ? (
            <div className={"ns-tt-tagfield" + (desk ? "" : " is-m")}>
              <span className="ns-tt-tagfield-empty">{TT_TEXT.tags.loadFailed}</span>
              <button type="button" className="ns-tt-tagadd ns-tt-tagretry" onClick={() => void useTagStore.getState().loadIndex()}>
                {TT_TEXT.tags.retry}
              </button>
            </div>
          ) : (
            <div className={"ns-tt-tagfield" + (desk ? "" : " is-m")} aria-busy="true">
              <span className="ns-tt-tagfield-empty">{TT_TEXT.tags.loading}</span>
            </div>
          )
        ) : desk ? (
          <div className="ns-tt-tagfield">
            <FixedTagChips tags={fixedTags} hideKeys={draftKeys(tagNames)} off={offKeys} onToggleOff={toggleOff} />
            {tagEmpty && !tagNames.length && <span className="ns-tt-tagfield-empty">{tagEmpty}</span>}
            <EntityTagField
              value={tagNames}
              onChange={setTagDraft}
              exclude={fixedTags.filter((t) => !offKeys.includes(t.key)).map((t) => t.key)}
              suggestInline
              resetKey={blockId || "fill"}
            />
          </div>
        ) : (
          <MobileTagDraft
            fixed={fixedTags}
            value={tagNames}
            onChange={setTagDraft}
            empty={tagEmpty}
            title={pickTitle}
            off={offKeys}
            onToggleOff={toggleOff}
          />
        )}
      </span>
    </div>
  );

  const catName = (id: string): string => catById[id]?.name ?? "？";
  const snapPrev = prevEnd;
  const snapNext = nextStart;

  /* 合併列（改一塊才有；運行中的塊不會開這個面板，repository 仍會擋） */
  const mergeRow =
    mergeId && block ? (
      <div className="ns-tt-merge">
        <Row k="合併" top>
          <span className="ns-tt-opts">
            {(["prev", "next"] as const).map((d) => {
              const p = previews[d];
              return (
                <button
                  key={d}
                  type="button"
                  className={"ns-tt-opt is-solid" + (ask === d ? " is-on" : "")}
                  aria-pressed={ask === d}
                  disabled={!p}
                  onClick={() => setAsk(ask === d ? null : d)}
                >
                  {d === "prev" ? "與上一塊合併" : "與下一塊合併"}
                </button>
              );
            })}
          </span>
        </Row>
        {ask && askPreview && (
          <Expand className="ns-tt-merge-confirm">
            <p className="ns-tt-merge-preview">
              {TT_TEXT.mergePreview(catName(askPreview.categoryId), askPreview.start, askPreview.end, askPreview.gapMs)}
            </p>
            <p className="ns-tt-merge-note">
              {askPreview.keepId === block.id
                ? `鄰居是未記錄：這一塊延伸蓋住那段空白（同「${ask === "prev" ? "接上一塊" : "接下一塊"}」）。`
                : `這一塊（${catName(block.category_id)} ${fmtClock(init.start)}–${fmtClock(init.end)}）會刪掉，時間併進「${catName(askPreview.categoryId)}」。`}
            </p>
            <div className="ns-tt-merge-btns">
              <button type="button" className="ns-btn btn-ghost ns-btn--sm" onClick={() => setAsk(null)}>
                算了
              </button>
              <button
                type="button"
                className="ns-btn btn-seal ns-btn--sm"
                onClick={() => {
                  const d = ask;
                  onDone();
                  void mergeBlock(block.id, d, boundOf(d));
                }}
              >
                確認合併
              </button>
            </div>
          </Expand>
        )}
      </div>
    ) : null;

  // 二次確認：面板收成「副標＋合併列＋確認框」（D-時-33）
  if (ask && askPreview && block) {
    return (
      <div className="ns-tt-panel ns-tt-panel-block is-merging">
        <Sub num>
          {catName(block.category_id)}　{fmtClock(init.start)} – {fmtClock(init.end)}　・　{fmtDur(init.end - init.start)}
        </Sub>
        {mergeRow}
      </div>
    );
  }

  const cont = sheet?.kind === "fill" ? sheet.cont : undefined;
  // 磨光⑤ 收尾（沙盒 O6）：「剩下 X–Y 還沒記」的端點跟面板參考日不同天 ⇒ 時刻前面加日期（同時刻框下的日期標籤，
  // D-主-65 那一套；這行本來就是赭色，日期加粗）。只寫時刻會把隔天 06:00 看成當天 06:00
  const contClock = (ms: number) => {
    const d = clockDateLabel(ms, refDay);
    return d.other ? (
      <>
        <b className="ns-tt-fill-cont-date">{d.text}</b>
        {fmtClock(ms)}
      </>
    ) : (
      fmtClock(ms)
    );
  };
  return (
    <div className="ns-tt-panel ns-tt-panel-block" ref={rootRef}>
      <Sub num>
        {fmtClock(start)} – {fmtClock(end)}　・　{fmtDur(end - start)}
      </Sub>
      {cont && sheet?.kind === "fill" && (
        <p className="ns-tt-fill-cont">
          剩下{" "}
          <span className="ns-tt-num">
            {contClock(sheet.start)}–{contClock(fillEnd)}
          </span>{" "}
          還沒記
        </p>
      )}
      {warn && <Sub warn>{warn}</Sub>}
      <LinkRow value={link} onOpen={() => setPicking(true)} />
      {tagRow}
      <CategoryGrid selected={cat} onPick={setCat} compact />
      <Row k="発車" time>
        <Stepper
          value={start}
          lo={0}
          hi={end - MIN}
          onChange={setStartClamped}
          refDay={refDay}
          label="発車時刻"
          onEnter={() => endClock.current?.focus()}
          enterKeyHint="next"
          autoFocus={desk && mode === "fill" && !cont}
        />
        {snapPrev !== null && (
          <Opt solid dropDraft on={start === snapPrev} onClick={() => setStartClamped(snapPrev)}>
            接上一塊
          </Opt>
        )}
      </Row>
      <Row k="到着" time>
        <Stepper
          value={end}
          lo={start + MIN}
          hi={now}
          onChange={setEndClamped}
          refDay={refDay}
          label="到着時刻"
          handleRef={endClock}
          autoFocus={desk && !!cont}
        />
        {snapNext !== null && (
          <Opt solid dropDraft on={end === snapNext} onClick={() => setEndClamped(snapNext)}>
            {toNow ? "接到現在" : "接下一塊"}
          </Opt>
        )}
      </Row>
      {mergeRow}
      <Actions>
        {longAsk && (
          // 外層只管出現時淡入；抖動放內層（同一個元素換 animation 會在抖完後把淡入再播一次）
          <div className="ns-tt-longask" role="group" aria-label={longAsk} ref={longRowRef} tabIndex={-1}>
            <div className={"ns-tt-longask-in" + (longNudge ? " is-nudge" : "")} onAnimationEnd={() => setLongNudge(0)}>
              {/* 不放 aria-live：步進每一下句子都變；擋下時焦點放到這一組，報讀器會念這一組的名字 */}
              <span className="ns-tt-longask-t">
                {/* 日期整串不拆行（手機窄面板會在「（」前斷開） */}
                {longAsk.split(/(\d+\/\d+（.）)/).map((part, i) => (i % 2 ? <b key={i}>{part}</b> : part))}
              </span>
              <button
                type="button"
                className="ns-btn btn-ghost ns-btn--sm"
                onPointerDown={() => {
                  longSeen.current = { start, end };
                }}
                onClick={(e) => {
                  const seen = longSeen.current;
                  longSeen.current = null;
                  // 鍵盤按（detail 0）沒有「按下才失焦」這一段：焦點早就在鈕上，畫著的就是要存的
                  const sameAsSeen = e.detail === 0 || (seen !== null && seen.start === start && seen.end === end);
                  submit(e, sameAsSeen);
                }}
              >
                確定記這麼長
              </button>
            </div>
          </div>
        )}
        {!longAsk && hold > 0 && <div className="ns-tt-longask-hold" style={{ height: hold }} aria-hidden />}
        {mode === "edit" && block && (
          <>
            <button
              type="button"
              className="ns-btn btn-ghost is-aux"
              onClick={() => {
                onDone();
                void deleteBlock(block.id);
              }}
            >
              刪除
            </button>
            <button type="button" className="ns-btn btn-ghost is-aux" onClick={() => openSheet({ kind: "split", blockId: block.id })}>
              切開
            </button>
          </>
        )}
        <button type="button" className="ns-btn btn-ghost" onClick={onDone}>
          {cont ? "先這樣" : "取消"}
        </button>
        <button type="button" className="ns-btn btn-seal" onClick={submit}>
          {mode === "fill" ? "補上" : "改好了"}
        </button>
      </Actions>
    </div>
  );
}
