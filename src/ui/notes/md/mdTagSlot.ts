/**
 * MdBody 的行內小牌換畫法的口（旅客筆記車次④；手機 MobileMdBody 共用桌機 MdBody 的 AST→React，只換小牌）。
 *
 * 桌機不提供＝MdBody 照舊畫 `TagChip.sm`；手機在外面包一層 Provider，小牌改畫 `MTagInline`（手機的牌子、點了走手機的荷札頁）。
 * 這樣兩端閱讀態是同一份解析＋同一份排版程式（D-筆-54「雙端同等」），沒有第二份 Markdown 畫法。
 */
import { createContext, type ReactNode } from "react";
import type { TagOccurrence } from "../../../domain/tags";

/** 回傳要畫的小牌；點擊要自己 `stopPropagation`（外層閱讀區點一下＝進編輯） */
export type MdTagRender = (occ: TagOccurrence) => ReactNode;

export const MdTagSlot = createContext<MdTagRender | null>(null);
