/**
 * MobileInlineBody——手機筆記／日記閱讀態的段落＋行內小牌（旅客筆記車次③契約 §5.0、0-22；桌機對應＝乙席 InlineBody）。
 *
 * `plainParagraphs` 排段落（車次①②的讀法不變），每一行再 `inlineParagraphs` 切成 text／tag／code／url：
 *   tag 段畫成手機小牌（`.ns-notes-mtag.sm`；照原文寫法顯示，`#AI/工具` 就是「AI / 工具」），點了＝`onOpenTag(key)`；
 *   code／url／text 在 ③ 一律原樣文字（Markdown 是車次④）。圍欄程式碼裡的 `#` 不出牌（與 parseTags 的遮罩一致）。
 * 小牌的點擊與 Enter 不往外冒：外層的閱讀區「點一下＝進編輯」不會被它觸發。
 * 解析與切段都在 domain/tags（同一語意只定義一次）；本元件只畫。
 */
import { useMemo } from "react";
import { plainParagraphs } from "../../../domain/notes";
import { inlineParagraphs } from "../../../domain/tags";
import { MTagInline } from "./mobileTagBits";

export interface MobileInlineBodyProps {
  body: string;
  /** 空白時那一行字 */
  placeholder: string;
  onOpenTag(key: string): void;
}

export function MobileInlineBody({ body, placeholder, onOpenTag }: MobileInlineBodyProps) {
  const paras = useMemo(() => inlineParagraphs(plainParagraphs(body)), [body]);
  if (paras.length === 0) return <p className="ph">{placeholder}</p>;
  return (
    <>
      {paras.map((lines, i) => (
        <p key={i}>
          {lines.map((segs, k) => (
            <span key={k}>
              {k > 0 && <br />}
              {segs.map((seg, j) =>
                seg.kind === "tag" ? (
                  <MTagInline
                    key={j}
                    raw={seg.occ.raw}
                    onOpen={(e) => {
                      e.stopPropagation();
                      onOpenTag(seg.occ.key);
                    }}
                  />
                ) : (
                  <span key={j}>{seg.text}</span>
                ),
              )}
            </span>
          ))}
        </p>
      ))}
    </>
  );
}
