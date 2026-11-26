/**
 * attachmentStore——跨模組輕量相片附件計數快取（v1.39 4A-1）。
 *
 * 效能鐵則：
 *   - Store 內**絕不儲存 `photo_data`**，僅快取 `counts: Record<string, number>`（key = `${entityType}:${entityId}`）。
 *   - `revision` 遞增信號讓已開啟的詳情面板與運行報告單日跨頁感知遠端同步或異動並按需重拉實圖。
 */
import { create } from "zustand";
import { attachmentRepo } from "../data/attachmentRepo";
import { attachmentEntityKey, type AttachmentEntityType } from "../domain/attachments";

export interface AttachmentStoreState {
  /** `${entityType}:${entityId}` → 未刪除附件張數 */
  counts: Record<string, number>;
  /** 哪些 entityType 已向資料層載入過計數 */
  loadedTypes: Partial<Record<AttachmentEntityType, boolean>>;
  /** 每次新增／刪除／同步重載遞增，通知詳情面板或單日跨頁按需重拉實圖 */
  revision: number;
  /** 載入指定類型（或全站）的輕量附件計數；不碰 photo_data */
  loadCounts(entityType?: AttachmentEntityType): Promise<void>;
  /** 同步 pull 後全量重載計數並遞增 revision */
  refreshAll(): Promise<void>;
  /** 取得單一實體目前附件張數 */
  getCount(entityType: AttachmentEntityType, entityId: string): number;
  /** 樂觀調整單一實體計數並遞增 revision */
  bumpCount(entityType: AttachmentEntityType, entityId: string, delta: number): void;
}

let allInflight: Promise<void> | null = null;
const typeInflight: Partial<Record<AttachmentEntityType, Promise<void>>> = {};

export const useAttachmentStore = create<AttachmentStoreState>((set, get) => ({
  counts: {},
  loadedTypes: {},
  revision: 0,

  async loadCounts(entityType) {
    if (!entityType) {
      if (allInflight) return allInflight;
      allInflight = (async () => {
        try {
          const all = await attachmentRepo.listAllCounts();
          set({
            counts: all,
            loadedTypes: { "ticket:entry": true, "timetable:block": true },
          });
        } catch (e) {
          console.warn("[attachments] 載入附件計數失敗", e);
        } finally {
          allInflight = null;
        }
      })();
      return allInflight;
    }

    if (typeInflight[entityType]) return typeInflight[entityType]!;
    const p = (async () => {
      try {
        const byId = await attachmentRepo.listCountsByType(entityType);
        const prefix = `${entityType}:`;
        set((s) => {
          const next: Record<string, number> = {};
          for (const [k, v] of Object.entries(s.counts)) {
            if (!k.startsWith(prefix)) next[k] = v;
          }
          for (const [id, cnt] of Object.entries(byId)) {
            if (cnt > 0) next[attachmentEntityKey(entityType, id)] = cnt;
          }
          return {
            counts: next,
            loadedTypes: { ...s.loadedTypes, [entityType]: true },
          };
        });
      } catch (e) {
        console.warn(`[attachments] 載入 ${entityType} 計數失敗`, e);
      } finally {
        delete typeInflight[entityType];
      }
    })();
    typeInflight[entityType] = p;
    return p;
  },

  async refreshAll() {
    try {
      const all = await attachmentRepo.listAllCounts();
      set((s) => ({
        counts: all,
        loadedTypes: { "ticket:entry": true, "timetable:block": true },
        revision: s.revision + 1,
      }));
    } catch (e) {
      console.warn("[attachments] 重載附件計數失敗", e);
    }
  },

  getCount(entityType, entityId) {
    return get().counts[attachmentEntityKey(entityType, entityId)] ?? 0;
  },

  bumpCount(entityType, entityId, delta) {
    if (!entityId || !delta) return;
    const key = attachmentEntityKey(entityType, entityId);
    set((s) => {
      const cur = s.counts[key] ?? 0;
      const nextVal = Math.max(0, cur + delta);
      const next = { ...s.counts };
      if (nextVal > 0) next[key] = nextVal;
      else delete next[key];
      return { counts: next, revision: s.revision + 1 };
    });
  },
}));
