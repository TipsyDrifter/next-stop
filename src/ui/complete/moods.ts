/**
 * 心情三燈的字與色（UI 丙-3 G1；D-1.36-6 全站正名＝順暢／平穩／吃力）——完成卡、側板、手機詳情與一日運行專頁同一份。
 * 只改顯示字：存進資料庫的值照舊是 green／yellow／red（domain Mood），舊資料不用遷移。
 * 顏色走語意層 --mood-good（松葉）／--mood-ok（紀念章弧金 --arc）／--mood-hard（赭；磨光⑤ D-主-63：吃力是警示不是済，朱改赭），
 * theme.css 定義、跟著主題換色（視覺規範 §1.1）。
 * 小圓裡的一個字：順／平／難（D-1.36-6 正名，取代原「還行／還」）。
 */
import type { Mood } from "../../domain";

export interface MoodOption {
  value: Mood;
  label: string;
  glyph: string;
  color: string;
}

export const MOODS: readonly MoodOption[] = [
  { value: "green", label: "順暢", glyph: "順", color: "var(--mood-good)" },
  { value: "yellow", label: "平穩", glyph: "平", color: "var(--mood-ok)" },
  { value: "red", label: "吃力", glyph: "難", color: "var(--mood-hard)" },
];
