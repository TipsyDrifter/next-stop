/**
 * 車窓・理想手札——自選相片前端輕量縮圖壓縮器（第六本第四梯 v1.30；v1.39 改由共用 `src/lib/compressPhoto.ts` 承接）。
 *
 * 保留既有 `compressIdealPhoto(file: File): Promise<string>` 簽名與容量規則（長邊 ≤ 720px、≤ MAX_IDEAL_PHOTO_CHARS）。
 */
import { MAX_IDEAL_PHOTO_CHARS, validatePhotoDataUrl } from "../../domain/idealTecho";
import { compressPhoto } from "../../lib/compressPhoto";

const IDEAL_MAX_SIDES = [720, 520, 380] as const;
const IDEAL_QUALITY_STEPS = [0.78, 0.62, 0.48, 0.36] as const;

export async function compressIdealPhoto(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new RangeError("請選擇圖片檔案（JPG／PNG／WebP）");
  }
  const compressed = await compressPhoto(file, {
    maxChars: MAX_IDEAL_PHOTO_CHARS,
    maxSides: IDEAL_MAX_SIDES,
    qualitySteps: IDEAL_QUALITY_STEPS,
    tooLargeMessage: "相片壓縮後仍超過手札容量上限，請換一張構圖較單純的相片",
  });
  const checked = validatePhotoDataUrl(compressed.dataUrl);
  if (!checked) {
    throw new RangeError("相片處理失敗，請再試一次");
  }
  return checked;
}
