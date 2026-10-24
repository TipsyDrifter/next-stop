/**
 * TagSheetPanel——運行中那一班的荷札小面板（sheet.kind "tags"；⑥ 契約 §5.2、D-時-116；乙席；長相＝原型 `v-tags.js` tagsBody）。
 * 副標「分類・連到　HH:MM 発　・　手動加的會跟著這一班…」→ 一列「荷札」：分類帶的淡牌（唯讀，點了進荷札頁）＋
 * 桌機 `EntityTagField` 實體模式（`timetable:block`，掛了就寫、toast＋復原；建議清單不列分類已帶的、往下推開）。
 * UI 丙-4 C4：即時存的面板沒有主鈕（規範 §2.3）——原本的「好了」拿掉，關＝×／返回／點暗幕（宿主也不給黏底列）。
 * 運行中這班沒有「取消」（原型定案 2：只有塊面板是草稿）。
 * 手機的運行列不開這個面板（直接開點選器，D-時-126）；萬一開到了，用手機的立刻寫欄。
 * 只對著運行中那一班（⑤ 交接 O1）：store 的 refresh／openSheet 遇到換 id（塗色切開）就換過去、到站就關（`tagSheetFollow`）；
 * 這裡再守一層——對著的塊不在或已經不是運行中 ⇒ 不畫荷札欄（不會對著舊塊寫）。
 * 直接 import common/EntityTagField，不經 ui/notes/desktop.ts（那個 barrel 跟 lines/mounts 成圈，dev 熱更新會 TDZ；偏差記錄 10-20）。
 * 磨光③ 2-1（D-時-136）：桌機分類帶的牌子可以「這一塊不算」——照這個面板的節奏立刻寫（`setBlockOff`，toast＋復原）。
 * 手機不給（手機運行中那班沒有排除入口：要排除就到着後改一塊）。
 */
import { fmtClock, msOf } from "../../../domain/timetable";
import { linkLabelOf } from "../../../domain/timetableLink";
import { TT_TAG_BLOCK } from "../../../domain/timetableTags";
import { TT_TEXT, useTimetableStore } from "../../../store/timetableStore";
import { EntityTagField } from "../../common/EntityTagField";
import { useShell } from "../../mobile/useShell";
import { FixedTagChips, MobileTagEntity, fixedTagsOf, pickerName, setBlockOff, ttBackRef, useTimetableTagMaps } from "../parts/TimetableTagChips";
import { Sub, useBlock, type PanelProps } from "./controls";
import { useTagStore } from "../../../store/tagStore";

export function TagSheetPanel({ onDone }: PanelProps) {
  const sheet = useTimetableStore((s) => s.sheet);
  const categories = useTimetableStore((s) => s.categories);
  const catById = useTimetableStore((s) => s.catById);
  const linkInfo = useTimetableStore((s) => s.linkInfo);
  const blockId = sheet?.kind === "tags" ? sheet.blockId : "";
  const block = useBlock(blockId);
  const m = useTimetableTagMaps();
  const index = useTagStore((s) => s.index);
  const desk = useShell() === "desktop";
  const T = TT_TEXT.tags;

  // UI 丙-4 C4：退路只寫一句，不放「關閉」字鈕（規範 §4：不改東西只是關＝×／返回／點暗幕）
  if (!block || block.ended_at !== null) {
    return (
      <div className="ns-tt-panel">
        <Sub>{T.runGone}</Sub>
      </div>
    );
  }

  const cat = catById[block.category_id]?.name ?? "？";
  const start = msOf(block.started_at);
  const running = block.ended_at === null;
  const label = linkLabelOf(block, linkInfo);
  const fixed = fixedTagsOf(block.category_id, categories, m);
  const manual = index ? useTagStore.getState().keysOf(TT_TAG_BLOCK, block.id) : [];
  const back = () => ttBackRef({ kind: "tags", blockId: block.id });
  const openTag = (key: string): void => {
    onDone();
    void useTagStore.getState().openTagPage(key, back());
  };

  return (
    <div className="ns-tt-panel ns-tt-panel-tags">
      <Sub>
        {cat}
        {label ? `・${label}` : ""}　<span className="ns-tt-num">{T.runStart(fmtClock(start))}</span>
        {running ? `　・　${T.runHint}` : ""}
      </Sub>
      <div className="ns-tt-row is-top ns-tt-tagrow">
        <span className="ns-tt-row-k">{T.row}</span>
        <span className="ns-tt-row-v">
          {desk ? (
            <div className="ns-tt-tagfield">
              <FixedTagChips
                tags={fixed}
                hideKeys={manual}
                onOpen={openTag}
                off={m.off[block.id]}
                onToggleOff={(key, off) => void setBlockOff(block.id, key, off)}
              />
              <EntityTagField
                entityType={TT_TAG_BLOCK}
                entityId={block.id}
                exclude={fixed.map((t) => t.key)}
                suggestInline
                backRef={back}
                afterOpen={onDone}
              />
            </div>
          ) : (
            <MobileTagEntity
              entityType={TT_TAG_BLOCK}
              entityId={block.id}
              pickName={pickerName(cat, start, running)}
              fixed={fixed.filter((t) => !m.off[block.id]?.includes(t.key))}
            />
          )}
        </span>
      </div>
    </div>
  );
}
