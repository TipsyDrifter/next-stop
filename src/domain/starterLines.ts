/**
 * 預設幹線（癸 清空一致性，D-主-531）：路線圖第一次打開時的三條通用幹線，底下不放路線。
 * 清空等於回到第一次裝 App，所以清空之後也會回來；都能改名、刪除。
 *
 * id 是 uuid v5(LINE_ID_NAMESPACE, "line:<key>") 的字面值，兩台各種一次也只有一份。
 * `src-tauri/src/sync/tables/core.rs` 的 NODES_ALIVE 要排掉同一組 id（App 自種的不算「這台有資料」），
 * `scripts/tests/starter-defaults.test.ts` 對帳。
 *
 * 鐵則：不 import 任何東西（`node --test` 直載）。
 */
export const LINE_ID_NAMESPACE = "d36eefb9-ce1d-50f3-9369-d576d0d4dd47";

export interface StarterLine {
  key: string;
  id: string;
  name: string;
}

export const STARTER_LINES: readonly StarterLine[] = [
  { key: "work", id: "99e220f9-53da-55a7-a521-30f65cff69dd", name: "工作" },
  { key: "study", id: "2058e959-b8b3-5511-b4ef-4fc3f582595c", name: "學習" },
  { key: "life", id: "c05cb7ab-b899-5208-9bee-3e6d6b8c2b7c", name: "生活" },
];
