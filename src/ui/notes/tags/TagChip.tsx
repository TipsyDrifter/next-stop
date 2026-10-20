/**
 * TagChip——荷札牌（桌機；旅客筆記車次③契約 §5.0、§5.4；原型 styles.css:32-94、app.js chip／bigTagHtml／glyph）。
 *
 * 造型＝行李荷札：細框、左端切角、打孔小圓（金屬墊圈）。**沒有顏色**（決策記錄〈承接〉）：只用 `--ns-tag-*`（墨與紙推導）。
 * 名稱顯示「難度 / 高」：父層淡、末段正常、分隔「 / 」；牌子上不印 `#`（契約 §1-7）。
 *
 *   TagChip        一般牌（側板、牌雲）與 `size="sm"` 行內小牌（內文）：`span.ns-notes-tag[.sm][.is-armed]`
 *                  ＞ `button.ns-notes-tag-nm`（點＝看清單；沒給 onOpen＝`span`、點不動）＋可選 `button.ns-notes-tag-x`（摘；hover 現身、armed 常亮）
 *   TagChipLarge   荷札頁頁頭大牌 `.lg`：父層每一段是 `button.pa`（點＝看父層）；虛資料夾 `.virtual`（不打孔、框線退淡）
 *   TagName        名稱的三段式排法（建議清單的加粗 `hl` 也走這裡）
 *   TagGlyph       樹與建議清單的小圖示：真荷札＝實線牌、虛資料夾＝虛線空心牌
 */
import type { MouseEvent, ReactNode } from "react";
import { keyOf } from "../../../domain/tags";
import { IconTag, IconX } from "../notesBits";
import "../notes-tags.css";

/** 名稱（`/` 或全形 `／` 分層）：父層 `.pa`、末段 `.la`、分隔 `i.sl`；`hl`＝要加粗的字元範圍（對 name 的位置） */
export function TagName({ name, hl }: { name: string; hl?: readonly [number, number] | null }) {
  const segs = String(name).split(/[/／]/);
  const out: ReactNode[] = [];
  let off = 0;
  segs.forEach((s, i) => {
    if (i) out.push(<i key={`s${i}`} className="sl">/</i>);
    let inner: ReactNode = s;
    if (hl && hl[1] > off && hl[0] < off + s.length) {
      const a = Math.max(0, hl[0] - off);
      const b = Math.min(s.length, hl[1] - off);
      inner = (
        <>
          {s.slice(0, a)}
          <b>{s.slice(a, b)}</b>
          {s.slice(b)}
        </>
      );
    }
    out.push(
      <span key={i} className={i < segs.length - 1 ? "pa" : "la"}>
        {inner}
      </span>,
    );
    off += s.length + 1;
  });
  return <>{out}</>;
}

export function TagGlyph({ real, size = 14 }: { real: boolean; size?: number }) {
  return (
    <span className={`ns-notes-tglyph${real ? "" : " hollow"}`} aria-hidden>
      <IconTag size={size} hollow={!real} />
    </span>
  );
}

export interface TagChipProps {
  /** 顯示名（全路徑；行內小牌傳原文寫法 `occ.raw`） */
  name: string;
  size?: "sm";
  /** Backspace 第一下選中（側板）：底色轉強調、× 常亮 */
  armed?: boolean;
  onOpen?(e: MouseEvent<HTMLButtonElement>): void;
  /** 給了才有 ×（摘） */
  onRemove?(): void;
  title?: string;
}

export function TagChip({ name, size, armed, onOpen, onRemove, title }: TagChipProps) {
  const cls = ["ns-notes-tag", size, armed && "is-armed"].filter(Boolean).join(" ");
  return (
    <span className={cls}>
      {onOpen ? (
        <button type="button" className="ns-notes-tag-nm" title={title ?? `看 #${name} 的清單`} onClick={onOpen}>
          <TagName name={name} />
        </button>
      ) : (
        // 沒有 onOpen（受控草稿：點了會離開面板）＝名字不是按鈕、沒有「看 #… 的清單」（磨光③ 2-9；同時刻表 TtTag）
        <span className="ns-notes-tag-nm" title={title}>
          <TagName name={name} />
        </span>
      )}
      {onRemove && (
        <button
          type="button"
          className="ns-notes-tag-x"
          aria-label={`摘下 #${name}`}
          title="摘下"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onRemove}
        >
          <IconX size={9} />
        </button>
      )}
    </span>
  );
}

/** 頁頭大牌：父層段可點（＝看父層）；虛資料夾 `.virtual` */
export function TagChipLarge({ name, virtual, onParent }: { name: string; virtual?: boolean; onParent?(key: string): void }) {
  const segs = String(name).split("/");
  const parts: ReactNode[] = [];
  let acc = "";
  segs.forEach((s, i) => {
    acc += (i ? "/" : "") + s;
    if (i) parts.push(<i key={`s${i}`} className="sl">/</i>);
    if (i < segs.length - 1) {
      const k = keyOf(acc);
      const label = acc;
      parts.push(
        <button key={i} type="button" className="pa" title={`看父層 #${label}`} onClick={() => k && onParent?.(k)}>
          {s}
        </button>,
      );
    } else
      parts.push(
        <span key={i} className="la">
          {s}
        </span>,
      );
  });
  return (
    <span className={`ns-notes-tag lg${virtual ? " virtual" : ""}`}>
      <span className="ns-notes-tag-nm">{parts}</span>
    </span>
  );
}
