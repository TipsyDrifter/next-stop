/**
 * themeShop.ts——主題商店的貨架資料（第三梯 ⑩，D-主-431；v1.34 4A/4B 擴充「水鏡鎌倉」動態時光主題）。
 * 純資料（node 測試直接載入）；token 在 styles/theme-library.css，解析與寫 DOM 在 lib/themeSystem.ts 與 store/uiStore.ts。
 */
export type SkinId = "techo" | "sleeper" | "moonlight" | "yumemi" | "kamakura";

export interface Skin {
  id: SkinId;
  name: string;
  latin: string;
  /** 亮暗底＝預設或縮圖的 <html data-theme> 值；dynamic 主題同時支援 light 與 dark 兩象限 */
  base: "light" | "dark";
  note: string;
  /** 24h 時光流轉動態主題（隨真實時間與晴雨連續變化，可設為亮／暗代表或全天候模式） */
  dynamic?: boolean;
}

export const SKINS: readonly Skin[] = [
  { id: "kamakura", name: "水鏡鎌倉", latin: "Kamakura", base: "light", note: "隨真實時光與晴雨流轉的湖上列車", dynamic: true },
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
