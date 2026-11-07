/**
 * themeShop.ts——主題商店的貨架資料（第三梯 ⑩，D-主-431）：哪幾套、亮暗底、怎麼判定。
 * 純資料（node 測試直接載入）；token 在 styles/theme-library.css，寫 DOM 在 uiStore.applyTheme。
 */
export type SkinId = "techo" | "sleeper" | "moonlight" | "yumemi";

export interface Skin {
  id: SkinId;
  name: string;
  latin: string;
  /** 亮暗底＝<html data-theme> 的值：全站 [data-theme="dark"] 的版面規則照走 */
  base: "light" | "dark";
  note: string;
}

export const SKINS: readonly Skin[] = [
  { id: "techo", name: "旅の手帖", latin: "Techo", base: "light", note: "暖米紙與墨綠書封" },
  { id: "yumemi", name: "少女手帳", latin: "Yumemi", base: "light", note: "奶米白與薰衣草" },
  { id: "sleeper", name: "夜行寝台", latin: "Night Sleeper", base: "dark", note: "車廂裡的暖燈" },
  { id: "moonlight", name: "月白", latin: "Moonlight", base: "dark", note: "冷調的月光" },
];

export function isSkinId(v: string | null | undefined): v is SkinId {
  return SKINS.some((s) => s.id === v);
}

export function skinById(id: string | null | undefined): Skin | null {
  return SKINS.find((s) => s.id === id) ?? null;
}
