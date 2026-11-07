/**
 * handFontStore——目前用哪套手寫字型、哪幾套已下載（第三梯 ⑩，D-主-434）。
 * 寫 DOM 的唯一地方：字型裝好才寫 <html data-hand>，所以畫面是「芫荽 → 換字」，不會有一段沒字可畫。
 * 選擇存 settings 本機鍵 `hand_font`（不在同步白名單：兩台各選各的，字型檔也各下載各的）。
 * 檔案不見（清過 WebView 資料）就退回芫荽，商店那一列變回「下載」，不報錯。
 */
import { create } from "zustand";
import { settingsRepo } from "../data";
import {
  downloadFont,
  downloadableFont,
  fontFiles,
  normalizeHandFont,
  type DownloadError,
  type HandFontId,
} from "../lib/handFonts";

const KEY_HAND_FONT = "hand_font";

/** 同一套只裝一次；移除時要從 document.fonts 拿掉 */
const installed = new Map<string, FontFace>();

async function install(id: string, data: ArrayBuffer): Promise<void> {
  const font = downloadableFont(id);
  if (!font || installed.has(id)) return;
  const face = new FontFace(font.family, data, { weight: "100 900" });
  await face.load();
  document.fonts.add(face);
  installed.set(id, face);
}

function applyHand(id: HandFontId) {
  const root = document.documentElement;
  if (id === "iansui") root.removeAttribute("data-hand");
  else root.setAttribute("data-hand", id);
}

interface HandFontState {
  active: HandFontId;
  /** 已存在本機的下載字型 */
  downloaded: readonly string[];
  /** 正在下載的字型與進度（0–1） */
  progress: { id: string; ratio: number } | null;
  error: { id: string; kind: DownloadError } | null;
  init: () => Promise<void>;
  /** 選用：沒下載的先下載，下載失敗就維持原本那套 */
  use: (id: HandFontId) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export const useHandFontStore = create<HandFontState>((set, get) => ({
  active: "iansui",
  downloaded: [],
  progress: null,
  error: null,

  async init() {
    try {
      const keys = (await fontFiles.keys()).map(String);
      set({ downloaded: keys });
      // 捕捉小窗每次叫出都重跑：主視窗換回芫荽後，這裡也要跟著拿掉 data-hand
      const want = normalizeHandFont(await settingsRepo.get(KEY_HAND_FONT));
      const data = want === "iansui" ? undefined : await fontFiles.get(want);
      if (data) await install(want, data);
      const active: HandFontId = data ? want : "iansui";
      applyHand(active);
      set({ active });
    } catch {
      /* 讀不到（私密視窗、被清）就留著芫荽 */
    }
  },

  async use(id) {
    const font = downloadableFont(id);
    if (font && !get().downloaded.includes(font.id)) {
      if (get().progress) return;
      set({ progress: { id: font.id, ratio: 0 }, error: null });
      try {
        const data = await downloadFont(font, (ratio) => set({ progress: { id: font.id, ratio } }));
        await fontFiles.put(font.id, data);
        void navigator.storage?.persist?.().catch(() => undefined); // 盡量不被瀏覽器的空間回收清掉；清了也只是再下載
        await install(font.id, data);
        set({ downloaded: [...get().downloaded, font.id], progress: null });
      } catch (e) {
        set({ progress: null, error: { id: font.id, kind: e === "corrupt" ? "corrupt" : "network" } });
        return;
      }
    } else if (font && !installed.has(font.id)) {
      const data = await fontFiles.get(font.id);
      if (!data) {
        set({ downloaded: get().downloaded.filter((k) => k !== font.id) });
        return;
      }
      await install(font.id, data);
    }
    applyHand(id);
    set({ active: id, error: null });
    await settingsRepo.set(KEY_HAND_FONT, id);
  },

  async remove(id) {
    if (get().active === id) await get().use("iansui");
    const face = installed.get(id);
    if (face) {
      document.fonts.delete(face);
      installed.delete(id);
    }
    await fontFiles.remove(id);
    set({ downloaded: get().downloaded.filter((k) => k !== id), error: null });
  },
}));

