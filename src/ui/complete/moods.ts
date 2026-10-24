/**
 * 心情三燈的字與色（UI 丙-3 G1；視覺規範 §4 定案字＝順暢／還行／吃力）——完成卡與側板同一份，不再各寫一張表。
 * 只改顯示字：存進資料庫的值照舊是 green／yellow／red（domain Mood），舊資料不用遷移。
 * 顏色走語意層 --mood-good（松葉）／--mood-ok（紀念章弧金 --arc）／--mood-hard（赭；磨光⑤ D-主-63：吃力是警示不是済，朱改赭），
 * theme.css 定義、跟著主題換色（視覺規範 §1.1）。
 * 小圓裡的一個字：順／還／難（「吃」單字讀不出意思，沿用完成卡原本的「難」）。
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
  { value: "yellow", label: "還行", glyph: "還", color: "var(--mood-ok)" },
  { value: "red", label: "吃力", glyph: "難", color: "var(--mood-hard)" },
];
