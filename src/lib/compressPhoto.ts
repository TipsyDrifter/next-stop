/**
 * 全站共用圖片前端輕量縮圖壓縮器（v1.39 4A；車窓理想手札與跨模組相片附件櫃共用）。
 *
 * 將本地相片／剪貼簿圖片以 `<canvas>` 等比縮圖，優先輸出 WebP（不支援則退回 JPEG），
 * 依序嘗試降邊長（預設 `960 → 720 → 520`）與遞減品質，確保 DataURL 字元數 ≤ 上限
 * （預設 `240_000` 字元，約 ≤ 180KB 二進位大小），適合隨 SQLite E2EE 同步列流轉。
 */

export interface CompressedPhotoResult {
  dataUrl: string;
  mimeType: string;
  width: number;
  height: number;
  byteSize: number;
}

export interface CompressPhotoOptions {
  /** 產出 DataURL 最大字元數（預設 240_000，約 ≤ 180KB） */
  maxChars?: number;
  /** 依序嘗試的長邊像素上限（預設 [960, 720, 520]） */
  maxSides?: readonly number[];
  /** 每個邊長階依序嘗試的編碼品質（預設 [0.8, 0.68, 0.56, 0.44, 0.34]） */
  qualitySteps?: readonly number[];
  /** 超過上限時的自訂錯誤訊息 */
  tooLargeMessage?: string;
}

export const DEFAULT_PHOTO_MAX_CHARS = 240_000;
export const DEFAULT_PHOTO_MAX_SIDES = [960, 720, 520] as const;
export const DEFAULT_PHOTO_QUALITY_STEPS = [0.8, 0.68, 0.56, 0.44, 0.34] as const;

/** 依 Base64 DataURL 估算實際二進位位元組數 */
export function estimateDataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return dataUrl.length;
  const b64 = dataUrl.slice(comma + 1);
  let padding = 0;
  if (b64.endsWith("==")) padding = 2;
  else if (b64.endsWith("=")) padding = 1;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

function loadImageFromBlob(file: Blob): Promise<HTMLImageElement> {
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

export async function compressPhoto(
  file: File | Blob,
  opts?: CompressPhotoOptions,
): Promise<CompressedPhotoResult> {
  if (file.type && !file.type.startsWith("image/")) {
    throw new RangeError("請選擇圖片檔案（JPG／PNG／WebP）");
  }
  const maxChars = opts?.maxChars ?? DEFAULT_PHOTO_MAX_CHARS;
  const maxSides = opts?.maxSides ?? DEFAULT_PHOTO_MAX_SIDES;
  const qualitySteps = opts?.qualitySteps ?? DEFAULT_PHOTO_QUALITY_STEPS;

  const img = await loadImageFromBlob(file);
  const srcW = img.naturalWidth || img.width;
  const srcH = img.naturalHeight || img.height;
  if (!srcW || !srcH) {
    throw new RangeError("圖片尺寸異常，無法壓縮");
  }

  for (const maxSide of maxSides) {
    const scale = Math.min(1, maxSide / Math.max(srcW, srcH));
    const width = Math.max(1, Math.round(srcW * scale));
    const height = Math.max(1, Math.round(srcH * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new RangeError("瀏覽器畫布初始化失敗");
    ctx.drawImage(img, 0, 0, width, height);

    for (const q of qualitySteps) {
      const webp = canvas.toDataURL("image/webp", q);
      if (webp.startsWith("data:image/webp;base64,") && webp.length <= maxChars) {
        return {
          dataUrl: webp,
          mimeType: "image/webp",
          width,
          height,
          byteSize: estimateDataUrlBytes(webp),
        };
      }
      const jpeg = canvas.toDataURL("image/jpeg", q);
      if (jpeg.startsWith("data:image/jpeg;base64,") && jpeg.length <= maxChars) {
        return {
          dataUrl: jpeg,
          mimeType: "image/jpeg",
          width,
          height,
          byteSize: estimateDataUrlBytes(jpeg),
        };
      }
    }
  }

  throw new RangeError(
    opts?.tooLargeMessage ?? "相片壓縮後仍超過 180KB 上限，請換一張構圖較單純的相片",
  );
}
