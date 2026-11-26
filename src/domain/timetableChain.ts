/**
 * timetableChain——時刻表行為鏈（計時模板 `time_chains`）純領域層。
 *
 * 鐵則：零 React、零 Store、零 Tauri 執行期依賴，可直接由 `node --test` 毫秒級測試。
 */

export const CHAIN_STEP_MIN = 5;
export const CHAIN_STEP_MAX = 480;
export const CHAIN_DEFAULT_MIN = 25;
export const CHAIN_NAME_MAX = 40;
export const CHAIN_STEPS_MAX = 20;
export const CHAIN_LABEL_MAX = 32;
export const CHAIN_NOTE_MAX = 120;
export const CHAIN_LOCATION_MAX = 60;

export interface TimeChainStep {
  categoryId: string;
  /** 選填步驟顯示名（未填則顯示分類名） */
  label?: string;
  /** 預估分鐘數（5 ~ 480，預設 25） */
  estimateMin: number;
  /** 選填備註（發車時自動帶入時間塊備註） */
  note?: string;
  /** 選填地點（預留給地點連動） */
  location?: string;
}

export interface TimeChainRow {
  id: string;
  name: string;
  steps: TimeChainStep[];
  position: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ActiveChainState {
  chainId: string;
  chainName: string;
  steps: TimeChainStep[];
  /** 0-based 當前執行步驟索引 */
  stepIndex: number;
  runningBlockId: string | null;
}

export interface ChainStarterPresetMeta {
  id: "morning" | "deepwork" | "bedtime";
  name: string;
  desc: string;
  summary: string;
}

interface StarterPresetBlueprint {
  meta: ChainStarterPresetMeta;
  steps: ReadonlyArray<{
    label: string;
    estimateMin: number;
    keywords: readonly string[];
    note?: string;
  }>;
}

const STARTER_BLUEPRINTS: readonly StarterPresetBlueprint[] = [
  {
    meta: {
      id: "morning",
      name: "晨間啟動",
      desc: "喚醒伸展 10 分 → 晨間閱讀 20 分 → 整理今日計畫 10 分",
      summary: "3 站 · 40 分",
    },
    steps: [
      { label: "喚醒伸展", estimateMin: 10, keywords: ["運動", "伸展", "健身", "洗漱", "生活"] },
      { label: "晨間閱讀", estimateMin: 20, keywords: ["學習", "閱讀", "讀書", "興趣", "書"] },
      { label: "整理今日計畫", estimateMin: 10, keywords: ["工作", "計畫", "規劃", "創作", "家務"] },
    ],
  },
  {
    meta: {
      id: "deepwork",
      name: "專注連班",
      desc: "前置暖身 10 分 → 深度專注 45 分 → 整理收尾 10 分",
      summary: "3 站 · 1 小時 5 分",
    },
    steps: [
      { label: "前置暖身", estimateMin: 10, keywords: ["學習", "工作", "創作", "準備", "上課"] },
      { label: "深度專注", estimateMin: 45, keywords: ["創作", "工作", "學習", "專注", "上課"] },
      { label: "整理收尾", estimateMin: 10, keywords: ["工作", "家務", "整理", "休息", "學習"] },
    ],
  },
  {
    meta: {
      id: "bedtime",
      name: "睡前收心",
      desc: "書桌歸位 10 分 → 手帳回顧 15 分 → 靜心閱讀 20 分",
      summary: "3 站 · 45 分",
    },
    steps: [
      { label: "書桌歸位", estimateMin: 10, keywords: ["家務", "整理", "洗漱", "生活"] },
      { label: "手帳回顧", estimateMin: 15, keywords: ["創作", "手帳", "寫作", "興趣", "學習"] },
      { label: "靜心閱讀", estimateMin: 20, keywords: ["興趣", "休息", "學習", "閱讀", "睡覺"] },
    ],
  },
];

/** 3 組內建一鍵套用範本清單（僅在 App 內點選建立，不進 SQL migration） */
export const CHAIN_STARTER_PRESETS: readonly ChainStarterPresetMeta[] = STARTER_BLUEPRINTS.map((b) => b.meta);

function cleanOptionalText(raw: unknown, maxLen: number): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.replace(/\r?\n/g, " ").trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLen);
}

/** 將預估分鐘數正規化並夾在 5 ~ 480；無效值退回 25 */
export function normalizeStepEstimateMin(raw: unknown): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return CHAIN_DEFAULT_MIN;
  return Math.max(CHAIN_STEP_MIN, Math.min(CHAIN_STEP_MAX, Math.round(n)));
}

/** 將單一步驟正規化；缺少有效 categoryId 時回傳 null */
export function normalizeChainStep(raw: unknown): TimeChainStep | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const categoryId = typeof obj.categoryId === "string" ? obj.categoryId.trim() : "";
  if (!categoryId) return null;

  const step: TimeChainStep = {
    categoryId,
    estimateMin: normalizeStepEstimateMin(obj.estimateMin),
  };
  const label = cleanOptionalText(obj.label, CHAIN_LABEL_MAX);
  const note = cleanOptionalText(obj.note, CHAIN_NOTE_MAX);
  const location = cleanOptionalText(obj.location, CHAIN_LOCATION_MAX);
  if (label !== undefined) step.label = label;
  if (note !== undefined) step.note = note;
  if (location !== undefined) step.location = location;
  return step;
}

/** 安全解析資料庫 `steps` JSON 字串，過濾壞資料並正規化 `estimateMin` */
export function parseChainSteps(raw: string): TimeChainStep[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: TimeChainStep[] = [];
    for (const item of parsed) {
      const step = normalizeChainStep(item);
      if (step) out.push(step);
      if (out.length >= CHAIN_STEPS_MAX) break;
    }
    return out;
  } catch {
    return [];
  }
}

/** 正規化並序列化為精簡 JSON 字串（存入 `time_chains.steps`） */
export function serializeChainSteps(steps: readonly TimeChainStep[]): string {
  const clean: TimeChainStep[] = [];
  for (const s of steps) {
    const norm = normalizeChainStep(s);
    if (norm) clean.push(norm);
    if (clean.length >= CHAIN_STEPS_MAX) break;
  }
  return JSON.stringify(clean);
}

/** 驗證行為鏈名稱與步驟；合法回傳 null，不合法回傳人話錯誤訊息 */
export function validateChainInput(name: string, steps: readonly TimeChainStep[]): string | null {
  const trimmedName = typeof name === "string" ? name.trim() : "";
  if (!trimmedName) return "請輸入行為鏈名稱";
  if (Array.from(trimmedName).length > CHAIN_NAME_MAX) return `行為鏈名稱最多 ${CHAIN_NAME_MAX} 個字`;
  if (!Array.isArray(steps) || steps.length === 0) return "行為鏈至少需要 1 個步驟";
  if (steps.length > CHAIN_STEPS_MAX) return `行為鏈最多只能有 ${CHAIN_STEPS_MAX} 個步驟`;

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (!s || typeof s.categoryId !== "string" || !s.categoryId.trim()) {
      return `第 ${i + 1} 站尚未選擇分類`;
    }
    if (!Number.isFinite(s.estimateMin) || s.estimateMin < CHAIN_STEP_MIN || s.estimateMin > CHAIN_STEP_MAX) {
      return `第 ${i + 1} 站的預估時長須介於 ${CHAIN_STEP_MIN} 至 ${CHAIN_STEP_MAX} 分鐘`;
    }
    if (s.label && Array.from(s.label.trim()).length > CHAIN_LABEL_MAX) {
      return `第 ${i + 1} 站的步驟名稱最多 ${CHAIN_LABEL_MAX} 個字`;
    }
    if (s.note && Array.from(s.note.trim()).length > CHAIN_NOTE_MAX) {
      return `第 ${i + 1} 站的備註最多 ${CHAIN_NOTE_MAX} 個字`;
    }
    if (s.location && Array.from(s.location.trim()).length > CHAIN_LOCATION_MAX) {
      return `第 ${i + 1} 站的地點最多 ${CHAIN_LOCATION_MAX} 個字`;
    }
  }
  return null;
}

/** 計算整條行為鏈預估總分鐘數 */
export function chainTotalMin(steps: readonly TimeChainStep[]): number {
  let sum = 0;
  for (const s of steps) {
    sum += normalizeStepEstimateMin(s.estimateMin);
  }
  return sum;
}

/** 格式化行為鏈時長（如 `40 分`、`1 小時`、`1 小時 15 分`） */
export function formatChainDuration(totalMin: number): string {
  const safe = Number.isFinite(totalMin) ? Math.max(0, Math.round(totalMin)) : 0;
  if (safe < 60) return `${safe} 分`;
  const h = Math.floor(safe / 60);
  const m = safe % 60;
  return m === 0 ? `${h} 小時` : `${h} 小時 ${m} 分`;
}

/** 取得步驟顯示名稱：優先 `step.label`，其次分類名，最後 `未指定` */
export function resolveStepTitle(step: TimeChainStep, categoryName?: string): string {
  const label = step.label?.trim();
  if (label) return label;
  const cat = categoryName?.trim();
  if (cat) return cat;
  return "未指定";
}

function matchCategoryId(
  keywords: readonly string[],
  categories: ReadonlyArray<{ id: string; name: string }>,
): string {
  if (categories.length === 0) return "";
  // 1. 優先精確匹配分類名
  for (const kw of keywords) {
    const exact = categories.find((c) => c.name.trim() === kw);
    if (exact) return exact.id;
  }
  // 2. 其次部分包含匹配（忽略大小寫）
  for (const kw of keywords) {
    const lowerKw = kw.toLowerCase();
    const partial = categories.find((c) => c.name.toLowerCase().includes(lowerKw));
    if (partial) return partial.id;
  }
  // 3. 退回第一個可用分類
  return categories[0].id;
}

/** 依範本 ID 與使用者現有分類清單智慧配對出步驟陣列 */
export function resolveStarterPresetSteps(
  presetId: string,
  categories: ReadonlyArray<{ id: string; name: string }>,
): TimeChainStep[] {
  const blueprint = STARTER_BLUEPRINTS.find((b) => b.meta.id === presetId);
  if (!blueprint) return [];
  const fallbackId = categories[0]?.id ?? "";
  return blueprint.steps.map((s) => ({
    categoryId: matchCategoryId(s.keywords, categories) || fallbackId,
    label: s.label,
    estimateMin: s.estimateMin,
    ...(s.note ? { note: s.note } : {}),
  }));
}

/** 依範本 ID 取得範本中繼資訊 */
export function getStarterPresetMeta(presetId: string): ChainStarterPresetMeta | null {
  return CHAIN_STARTER_PRESETS.find((p) => p.id === presetId) ?? null;
}
