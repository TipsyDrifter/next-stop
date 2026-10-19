/**
 * useShareIntake——手機「從別的 App 分享文字進收件匣」（旅客筆記 ⑤ D-筆-59／63）。
 *
 * Kotlin（tt-notice plugin 的 captureShare）把 ACTION_SEND 的文字排進自己的 SharedPreferences 佇列；
 * 這裡在三個時機去取：掛上時（冷啟動）、回前景時、plugin 的 `shared` 事件（App 活著時分享進來）。
 * 取＋確認兩段與「收到一半又被敲門就再取一輪」都在 `createShareDrainer`（domain/notes.ts，有單元測試）。
 * （寫進 DB 之後、ack 之前被殺會重複一則；契約 §0-18 接受、不去重。）
 */
import { useEffect } from "react";
import { invoke, addPluginListener } from "@tauri-apps/api/core";
import { MOCK_MODE } from "../../../data";
import { noteRepo } from "../../../data/noteRepo";
import { createShareDrainer, shareToastText, type SharedItemLike } from "../../../domain/notes";
import { useNotesStore } from "../../../store/notesStore";
import { useUiStore } from "../../../store/uiStore";
import { onAndroid } from "../../timetable/ttNoticeBridge";

function normItems(raw: unknown): SharedItemLike[] {
  const items = (raw as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  return items.filter(
    (o): o is SharedItemLike =>
      !!o && typeof (o as SharedItemLike).id === "string" && typeof (o as SharedItemLike).text === "string",
  );
}

const drainShared = createShareDrainer({
  take: async () => normItems(await invoke<unknown>("plugin:tt-notice|take_shared")),
  create: async (body) => {
    await noteRepo.create({ kind: "note", body, inbox: true, nodeId: null });
  },
  ack: async (ids) => {
    await invoke("plugin:tt-notice|ack_shared", { ids });
  },
  after: async (count) => {
    await useNotesStore.getState().loadInbox();
    useUiStore.getState().showToast({ message: shareToastText(count) });
  },
  onError: (e) => console.warn("[notes:share] 取分享失敗", e),
});

export function useShareIntake(): void {
  useEffect(() => {
    if (!onAndroid() || MOCK_MODE) return;
    void drainShared();
    const onVisible = () => {
      if (document.visibilityState === "visible") void drainShared();
    };
    document.addEventListener("visibilitychange", onVisible);
    let unlisten: (() => void) | null = null;
    let alive = true;
    void addPluginListener("tt-notice", "shared", () => void drainShared())
      .then((l) => {
        if (alive) unlisten = () => void l.unregister();
        else void l.unregister();
      })
      .catch((e) => console.warn("[notes:share] 監聽失敗", e));
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisible);
      unlisten?.();
    };
  }, []);
}
