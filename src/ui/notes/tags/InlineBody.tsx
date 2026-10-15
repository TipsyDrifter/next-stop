/**
 * InlineBody——筆記／日記閱讀態的段落＋行內荷札小牌（桌機；旅客筆記車次③契約 §5.0、0-22）。
 *
 * 段落結構同 `plainParagraphs`（空行分段、段內換行 `<br>`）；每一行再切成 text／tag／code／url（`inlineParagraphs`，
 * 圍欄程式碼裡的行整行是字）。③ 只把 `tag` 段畫成 `TagChip.sm`（顯示照原文寫法 `occ.raw`），code／url 仍是純文字（④ 接樣式）。
 * 點小牌＝`openTagPage(occ.key, back)`；`stopPropagation`，不讓外層閱讀區把點擊當成「進編輯」。
 */
import { useMemo } from "react";
import { plainParagraphs } from "../../../domain/notes";
import { inlineParagraphs } from "../../../domain/tags";
import type { TagBackRef } from "../../../store/tagStore";
import { useTagStore } from "../../../store/tagStore";
import { TagChip } from "./TagChip";
import "../notes-tags.css";

export interface InlineBodyProps {
  body: string;
  /** 點小牌時的「回到剛才」（點下去那一刻才算，標題可能剛改過） */
  backRef(): TagBackRef;
  /** 空白時那一行（閱讀態提示） */
  empty?: string;
}

export function InlineBody({ body, backRef, empty = "（空白，點一下開始寫）" }: InlineBodyProps) {
  const paras = useMemo(() => {
    const p = plainParagraphs(body);
    return { lines: p, segs: inlineParagraphs(p) };
  }, [body]);
  if (!paras.lines.length) return <p className="ph">{empty}</p>;
  return (
    <>
      {paras.segs.map((lines, i) => (
        <p key={i}>
          {lines.map((segs, j) => (
            <span key={j}>
              {j > 0 && <br />}
              {segs.map((s, k) =>
                s.kind === "tag" ? (
                  <TagChip
                    key={k}
                    size="sm"
                    name={s.occ.raw}
                    title={`看 #${s.occ.name} 的清單`}
                    onOpen={(e) => {
                      e.stopPropagation();
                      void useTagStore.getState().openTagPage(s.occ.key, backRef());
                    }}
                  />
                ) : (
                  <span key={k}>{s.text}</span>
                ),
              )}
            </span>
          ))}
        </p>
      ))}
    </>
  );
}
