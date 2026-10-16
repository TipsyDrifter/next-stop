/**
 * MobileMdBody——手機筆記／日記閱讀態的 Markdown 排版（旅客筆記車次④契約 §5.0、§5.5-2；D-筆-54；取代車次③的 MobileInlineBody）。
 *
 * 雙端同等：解析（`domain/markdown` 的 `parseMarkdown`＋③ 的 `inlineSegments`）與 AST→React 都是桌機那一支 `MdBody`——
 *   手機只換兩件事：
 *   1. 行內小牌畫手機的 `MTagInline`（`MdTagSlot` 提供；點了＝`onOpenTag(key)`，「回到剛才」由呼叫端組，與 ③ 相同）；
 *   2. 樣式：容器由呼叫端給 `.ns-notes-mread`，本元件不畫容器；排版規則寫在 notes-mobile.css 的 `.ns-notes-mread` 子選擇器
 *      （手機 CSS 自給自足、不借桌機 class——紀律見 notes-mobile.css 檔頭）。16px／行高 1.8、`*斜體*`＝著重號（D-筆-54）。
 * 連結（`url`／`link`）：MdBody 的 `<a>` 點了 `openLink` 開系統瀏覽器、`stopPropagation`——外層閱讀區「點一下＝進編輯」不會被觸發；
 *   連結的 Enter 也不往外冒（外層的 Enter＝進編輯）。只放行 http／https（`isSafeHref`），其他 scheme 原樣當字。
 * 整條線不把字串當 HTML 塞進畫面（AST 由 React 直接畫）。
 */
import { useCallback } from "react";
import type { TagOccurrence } from "../../../domain/tags";
import { MdBody } from "../md/MdBody";
import { MdTagSlot } from "../md/mdTagSlot";
import { MTagInline } from "./mobileTagBits";

export interface MobileMdBodyProps {
  body: string;
  /** 空白時那一行字 */
  placeholder: string;
  onOpenTag(key: string): void;
}

/** MdBody 要的「回到剛才」：手機的小牌不走這條（MdTagSlot 換掉了），只為了滿足型別 */
const NO_BACKREF = () => ({ label: "", restore() {} });

export function MobileMdBody({ body, placeholder, onOpenTag }: MobileMdBodyProps) {
  const renderTag = useCallback(
    (occ: TagOccurrence) => (
      <MTagInline
        raw={occ.raw}
        onOpen={(e) => {
          e.stopPropagation();
          onOpenTag(occ.key);
        }}
      />
    ),
    [onOpenTag],
  );
  return (
    <MdTagSlot.Provider value={renderTag}>
      <MdBody body={body} empty={placeholder} backRef={NO_BACKREF} />
    </MdTagSlot.Provider>
  );
}
