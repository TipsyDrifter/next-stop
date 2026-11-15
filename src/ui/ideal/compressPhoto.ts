/**
 * 車窓・理想手札——自選相片前端輕量縮圖壓縮器（第六本第四梯 v1.30；決定 1-B）。
 *
 * 將使用者挑選的本地圖片以 `<canvas>` 等比縮至長邊 ≤ 720px，優先輸出 WebP（不支援時退回 JPEG），
 * 自動遞減品質確保產出的 DataURL 字元數嚴格小於 `MAX_IDEAL_PHOTO_CHARS`（通常約 35–75KB），
 * 直接隨 SQLite 同步列走端到端加密，不增加雲端儲存負擔。
 */
import { MAX_IDEAL_PHOTO_CHARS, validatePhotoDataUrl } from "../../domain/idealTecho";

const MAX_SIDE_PX = 720;
const QUALITY_STEPS = [0.78, 0.62, 0.48, 0.36] as const;

function loadImageFromFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new RangeError("無法讀取這張圖片——請換一張 JPG／PNG／WebP 相片再試"));
    };
    img.src = url;
  });
}

export async function compressIdealPhoto(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new RangeError("請選擇圖片檔案（JPG／PNG／WebP）");
  }
  const img = await loadImageFromFile(file);
  const srcW = img.naturalWidth || img.width;
  const srcH = img.naturalHeight || img.height;
  if (!srcW || !srcH) {
    throw new RangeError("圖片尺寸異常，無法壓縮");
  }

  const tryEncode = (maxSide: number): string | null => {
    const scale = Math.min(1, maxSide / Math.max(srcW, srcH));
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new RangeError("瀏覽器畫布初始化失敗");
    ctx.drawImage(img, 0, 0, w, h);

    for (const q of QUALITY_STEPS) {
      const webp = canvas.toDataURL("image/webp", q);
      if (webp.startsWith("data:image/webp;base64,") && webp.length <= MAX_IDEAL_PHOTO_CHARS) {
        return webp;
      }
      const jpeg = canvas.toDataURL("image/jpeg", q);
      if (jpeg.startsWith("data:image/jpeg;base64,") && jpeg.length <= MAX_IDEAL_PHOTO_CHARS) {
        return jpeg;
      }
    }
    return null;
  };

  const result = tryEncode(MAX_SIDE_PX) ?? tryEncode(520) ?? tryEncode(380);
  if (!result) {
    throw new RangeError("相片壓縮後仍超過手札容量上限，請換一張構圖較單純的相片");
  }
  const checked = validatePhotoDataUrl(result);
  if (!checked) {
    throw new RangeError("相片處理失敗，請再試一次");
  }
  return checked;
}
