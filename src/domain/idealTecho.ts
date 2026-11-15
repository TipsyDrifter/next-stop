/**
 * 車窓・理想手札（終點站的風景）與「車窓の問い」純領域模型（第六本第四梯 v1.30；D-主-560～564）。
 *
 * 零副作用、不依賴 React／Zustand／Tauri／SQLite，供 Node 單元測試與探針直接載入。
 */

/* ═══════════════════ 一、三大風景主題与車窗線畫預設 ═══════════════════ */

export type IdealTheme = "person" | "scenery" | "horizon";

export interface IdealThemeSpec {
  id: IdealTheme;
  label: string;
  latin: string;
  hint: string;
}

export const IDEAL_THEMES: readonly IdealThemeSpec[] = [
  {
    id: "person",
    label: "我想成為的人",
    latin: "WHO I ASPIRE TO BE",
    hint: "氣質、姿態、對待自己與身邊之人的方式",
  },
  {
    id: "scenery",
    label: "理想的生活風景",
    latin: "DAILY SCENERY",
    hint: "書桌光線、日常節律、想長久棲居的生活畫面",
  },
  {
    id: "horizon",
    label: "遠方的目的地",
    latin: "DISTANT HORIZONS",
    hint: "想踏上的旅途、想親手完成的作品、長遠的心願",
  },
];

export const IDEAL_THEME_LABEL: Readonly<Record<IdealTheme, string>> = {
  person: "我想成為的人",
  scenery: "理想的生活風景",
  horizon: "遠方的目的地",
};

const THEME_ORDER: Readonly<Record<IdealTheme, number>> = {
  person: 0,
  scenery: 1,
  horizon: 2,
};

export function isIdealTheme(v: unknown): v is IdealTheme {
  return v === "person" || v === "scenery" || v === "horizon";
}

export type IdealArtPresetId =
  | "sea-station"
  | "night-desk"
  | "mountain-bridge"
  | "morning-cafe"
  | "starry-window"
  | "river-tram"
  | "autumn-maple"
  | "quiet-library"
  | "sunrise-platform"
  | "rainy-window"
  | "harbor-ferry"
  | "meadow-train";

export interface IdealArtPreset {
  id: IdealArtPresetId;
  label: string;
  defaultTheme: IdealTheme;
}

export const IDEAL_ART_PRESETS: readonly IdealArtPreset[] = [
  { id: "sea-station", label: "海邊小站", defaultTheme: "horizon" },
  { id: "night-desk", label: "深夜書桌燈火", defaultTheme: "scenery" },
  { id: "starry-window", label: "夜行車窗星群", defaultTheme: "person" },
  { id: "morning-cafe", label: "晨光熱茶", defaultTheme: "scenery" },
  { id: "river-tram", label: "河畔路面電車", defaultTheme: "scenery" },
  { id: "mountain-bridge", label: "山間鐵橋", defaultTheme: "horizon" },
  { id: "quiet-library", label: "木質書架午後", defaultTheme: "person" },
  { id: "sunrise-platform", label: "破曉始發月台", defaultTheme: "person" },
  { id: "autumn-maple", label: "秋日楓紅支線", defaultTheme: "horizon" },
  { id: "rainy-window", label: "微雨車窗水珠", defaultTheme: "scenery" },
  { id: "harbor-ferry", label: "港灣渡輪薄霧", defaultTheme: "horizon" },
  { id: "meadow-train", label: "原野單節列車", defaultTheme: "person" },
];

const ART_IDS = new Set<string>(IDEAL_ART_PRESETS.map((p) => p.id));

export function isIdealArtPreset(v: unknown): v is IdealArtPresetId {
  return typeof v === "string" && ART_IDS.has(v);
}

export function defaultArtForTheme(theme: IdealTheme): IdealArtPresetId {
  if (theme === "person") return "starry-window";
  if (theme === "scenery") return "night-desk";
  return "sea-station";
}

/* ═══════════════════ 二、車窓の問い（四大類零壓力題庫） ═══════════════════ */

export type WindowPromptCategory = "self" | "daily" | "value" | "journey" | "custom";

export interface WindowPromptCategorySpec {
  id: Exclude<WindowPromptCategory, "custom">;
  label: string;
}

export const WINDOW_PROMPT_CATEGORIES: readonly WindowPromptCategorySpec[] = [
  { id: "self", label: "關於自己" },
  { id: "daily", label: "理想日常" },
  { id: "value", label: "價值態度" },
  { id: "journey", label: "旅途拾光" },
];

export const WINDOW_CATEGORY_LABEL: Readonly<Record<WindowPromptCategory, string>> = {
  self: "關於自己",
  daily: "理想日常",
  value: "價值態度",
  journey: "旅途拾光",
  custom: "自訂題目",
};

export function isWindowCategory(v: unknown): v is WindowPromptCategory {
  return v === "self" || v === "daily" || v === "value" || v === "journey" || v === "custom";
}

export interface WindowPromptSpec {
  key: string;
  category: Exclude<WindowPromptCategory, "custom">;
  question: string;
}

export const WINDOW_PROMPTS: readonly WindowPromptSpec[] = [
  // 關於自己（self）
  {
    key: "self.gentle-growth",
    category: "self",
    question: "最近有哪一個微小的瞬間，讓你覺得自己比一年前更溫柔或更篤定了一點？",
  },
  {
    key: "self.quiet-pride",
    category: "self",
    question: "回想這陣子的自己，有哪件沒有特別張揚、但你心裡其實默默為自己驕傲的小事？",
  },
  {
    key: "self.safe-harbor",
    category: "self",
    question: "當你覺得疲倦或被雜音包圍時，什麼樣的環境或舉動最能讓你重新安定下來？",
  },
  {
    key: "self.kind-words",
    category: "self",
    question: "如果把現在的自己當成一位很珍惜的好朋友，今晚你最想對他說哪一句話？",
  },
  {
    key: "self.unchanged-core",
    category: "self",
    question: "從小到大一路走來，你身上有哪個特質是無論環境怎麼變，都一直留在心裡的？",
  },
  {
    key: "self.let-go",
    category: "self",
    question: "最近有沒有哪個「其實不必逼自己做到完美」的念頭，是可以試著輕輕放下的？",
  },
  {
    key: "self.future-smile",
    category: "self",
    question: "想像三年後的自己回頭看今天，他會最感謝現在的你正在慢慢累積什麼？",
  },

  // 理想日常（daily）
  {
    key: "daily.good-day",
    category: "daily",
    question: "如果不看任何效率指標，怎樣的一天會讓你在睡前覺得「今天真好」？",
  },
  {
    key: "daily.ideal-desk",
    category: "daily",
    question: "描繪一下你最嚮往的書桌或創作角落：桌上有什麼材質、光線從哪裡照進來、耳邊有什麼聲音？",
  },
  {
    key: "daily.free-afternoon",
    category: "daily",
    question: "如果明天下午突然多出四小時完全沒有待辦的空白時光，你最想拿來怎麼度過？",
  },
  {
    key: "daily.morning-ritual",
    category: "daily",
    question: "什麼樣的早晨開場方式，最能讓你帶著從容不迫的心情展開一天？",
  },
  {
    key: "daily.season-scent",
    category: "daily",
    question: "在一年四季裡，你最喜歡哪個時節的空氣、飲品或散步路線？",
  },
  {
    key: "daily.evening-lamp",
    category: "daily",
    question: "入夜之後關掉正事，怎樣的睡前一小時最讓你覺得生活有溫度？",
  },
  {
    key: "daily.slow-pace",
    category: "daily",
    question: "生活裡有哪一件小事，是你希望自己永遠不要為了趕時間而草草帶過的？",
  },

  // 價值態度（value）
  {
    key: "value.unseen-craft",
    category: "value",
    question: "在創作或生活裡，有哪件事就算別人第一眼看不見細節，你也依然想好好守住？",
  },
  {
    key: "value.warm-connection",
    category: "value",
    question: "和重要的人相處時，什麼樣的互動或默契最讓你感受到「被真正理解」？",
  },
  {
    key: "value.meaningful-tool",
    category: "value",
    question: "對你來說，一件值得長久留在身邊的器物或作品，最打動你的特質是什麼？",
  },
  {
    key: "value.enoughness",
    category: "value",
    question: "對此刻的你而言，「富足而安穩的生活」最重要的三個元素是什麼？",
  },
  {
    key: "value.courage-kindness",
    category: "value",
    question: "在「變得更厲害」與「變得更自在」之間，現階段的你想怎麼調配兩者的比重？",
  },
  {
    key: "value.keep-pure",
    category: "value",
    question: "面對外界的評價或比較時，你想替自己守住哪一塊不被打擾的自留地？",
  },
  {
    key: "value.gift-to-world",
    category: "value",
    question: "透過你寫下的文字、程式碼或設計，你最希望帶給使用或讀到它的人什麼感受？",
  },

  // 旅途拾光（journey）
  {
    key: "journey.night-train",
    category: "journey",
    question: "閉上眼想像一列開往理想生活的夜行列車，窗外現在是什麼季節與風景？",
  },
  {
    key: "journey.small-station",
    category: "journey",
    question: "有沒有哪座去過的城市、小站或街角，至今偶爾想起來心裡還是會暖暖的？",
  },
  {
    key: "journey.recent-spark",
    category: "journey",
    question: "最近讀到的一句話、聽到的一首歌或看到的一幕畫面裡，有哪個片段特別觸動你？",
  },
  {
    key: "journey.next-trip",
    category: "journey",
    question: "如果下一趟旅行不趕行程、只選一個地方慢慢散步住上幾天，你想去哪裡？",
  },
  {
    key: "journey.language-dream",
    category: "journey",
    question: "正在學習的新技能或新語言，你最期待未來某天能用它體驗哪一個真實場景？",
  },
  {
    key: "journey.unexpected-detour",
    category: "journey",
    question: "回顧過去這一年，有沒有哪段原本不在計畫裡的繞路，反而讓你看見了意外的好風景？",
  },
  {
    key: "journey.horizon-letter",
    category: "journey",
    question: "如果可以在終點站的月台留一張明信片給未來的自己，今天你想在上面寫什麼？",
  },
];

/** FNV-1a 32-bit 雜湊（決定性、零外部依賴） */
export function fnv1aHash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * 依日期（`YYYY-MM-DD`）與「換一題」次數決定性挑出今日題目。
 * 同一天在桌機與手機打開會看到同一題；點「換一題」時以質數步進走訪題庫，不會連撞同一題。
 */
export function pickDailyPrompt(
  dayKey: string,
  shuffleOffset = 0,
  pool: readonly WindowPromptSpec[] = WINDOW_PROMPTS,
): WindowPromptSpec {
  if (pool.length === 0) {
    return {
      key: "daily.good-day",
      category: "daily",
      question: "如果不看任何效率指標，怎樣的一天會讓你在睡前覺得「今天真好」？",
    };
  }
  const base = fnv1aHash(`nextstop.window.${dayKey}`) % pool.length;
  // 選一個與 pool.length 互質的步長（pool=28 時 step=5 互質，28 次剛好走遍全庫不重複）
  const step = pool.length % 5 !== 0 ? 5 : 1;
  const normalizedOffset = ((shuffleOffset % pool.length) + pool.length) % pool.length;
  const idx = (base + normalizedOffset * step) % pool.length;
  return pool[idx];
}

/** 自訂題目的穩定識別碼：正規化空白與全半形問號，讓跨年回答同一道自訂題目也能自動聚合成跨時空對照 */
export function customPromptKey(question: string): string {
  const norm = question
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\?/g, "？")
    .toLowerCase();
  return `custom:${norm}`;
}

/* ═══════════════════ 三、資料表列型別與輸入契約 ═══════════════════ */

export interface IdealCardRow {
  id: string;
  theme: IdealTheme;
  title: string;
  body: string;
  motto: string;
  art_preset: IdealArtPresetId;
  photo_data: string | null;
  pinned: number;
  position: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface IdealReflectionRow {
  id: string;
  prompt_key: string;
  category: WindowPromptCategory;
  question: string;
  answer: string;
  answered_on: string;
  diary_note_id: string | null;
  pinned: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface CreateIdealCardInput {
  theme: IdealTheme;
  title: string;
  body?: string;
  motto?: string;
  artPreset?: IdealArtPresetId;
  photoData?: string | null;
  pinned?: boolean;
}

export interface UpdateIdealCardPatch {
  theme?: IdealTheme;
  title?: string;
  body?: string;
  motto?: string;
  artPreset?: IdealArtPresetId;
  photoData?: string | null;
  pinned?: boolean;
  position?: number;
}

export interface CreateReflectionInput {
  promptKey: string;
  category: WindowPromptCategory;
  question: string;
  answer: string;
  answeredOn: string;
  diaryNoteId?: string | null;
  pinned?: boolean;
}

export interface UpdateReflectionPatch {
  question?: string;
  answer?: string;
  answeredOn?: string;
  diaryNoteId?: string | null;
  pinned?: boolean;
}

/* ═══════════════════ 四、驗證、圖片防護與日記格式 ═══════════════════ */

/** 輕量壓縮相片 DataURL 字元上限（約對應 ≤130KB 二進位，Canvas 壓縮預設落在 35–75KB） */
export const MAX_IDEAL_PHOTO_CHARS = 180_000;

const DATA_IMAGE_RE = /^data:image\/(?:webp|jpeg|jpg|png);base64,[A-Za-z0-9+/=]+$/;

export function validatePhotoDataUrl(photoData: string | null | undefined): string | null {
  if (photoData === null || photoData === undefined || photoData === "") return null;
  const trimmed = photoData.trim();
  if (!DATA_IMAGE_RE.test(trimmed)) {
    throw new RangeError("相片格式不支援——請選擇一般圖片檔（JPG／PNG／WebP）");
  }
  if (trimmed.length > MAX_IDEAL_PHOTO_CHARS) {
    throw new RangeError("相片壓縮後仍超過手札容量上限，請換一張圖片再試");
  }
  return trimmed;
}

export const WINDOW_DIARY_TAG = "車窓の問い";

/** 產生同步寫入《旅客筆記・日記》的內文（含題目引用塊與 `#車窓の問い` 荷札） */
export function formatReflectionDiaryBody(question: string, answer: string): string {
  const q = question.trim();
  const a = answer.trim();
  return `> 🪟 **車窓の問い**：${q}\n\n${a}\n\n#${WINDOW_DIARY_TAG}`;
}

/* ═══════════════════ 五、清單排序、跨時空聚合與釘選解析 ═══════════════════ */

export function aliveIdealCards(rows: readonly IdealCardRow[]): IdealCardRow[] {
  return rows
    .filter((r) => r.deleted_at === null)
    .slice()
    .sort(
      (a, b) =>
        (THEME_ORDER[a.theme] ?? 9) - (THEME_ORDER[b.theme] ?? 9) ||
        a.position - b.position ||
        a.created_at.localeCompare(b.created_at) ||
        a.id.localeCompare(b.id),
    );
}

export function aliveReflections(rows: readonly IdealReflectionRow[]): IdealReflectionRow[] {
  return rows
    .filter((r) => r.deleted_at === null)
    .slice()
    .sort(
      (a, b) =>
        b.answered_on.localeCompare(a.answered_on) ||
        b.created_at.localeCompare(a.created_at) ||
        a.id.localeCompare(b.id),
    );
}

export interface PromptTimelapseGroup {
  promptKey: string;
  category: WindowPromptCategory;
  question: string;
  /** 依作答時間由舊到新排列，方便跨季節／跨年份左右並排閱讀演進軌跡 */
  entries: IdealReflectionRow[];
  /** 該題最新一次作答的日期（供題組由新到舊排序） */
  latestAnsweredOn: string;
  latestCreatedAt: string;
  /** 是否已有 2 則以上跨時空回答 */
  isMultiEra: boolean;
}

/** 將活著的問答依 `prompt_key` 聚合成跨時空對照組（組內由舊到新、組間由最新作答排前） */
export function groupReflectionsByPrompt(rows: readonly IdealReflectionRow[]): PromptTimelapseGroup[] {
  const alive = rows.filter((r) => r.deleted_at === null);
  const byKey = new Map<string, IdealReflectionRow[]>();
  for (const r of alive) {
    const list = byKey.get(r.prompt_key);
    if (list) list.push(r);
    else byKey.set(r.prompt_key, [r]);
  }
  const groups: PromptTimelapseGroup[] = [];
  for (const [promptKey, list] of byKey) {
    const sorted = list
      .slice()
      .sort(
        (a, b) =>
          a.answered_on.localeCompare(b.answered_on) ||
          a.created_at.localeCompare(b.created_at) ||
          a.id.localeCompare(b.id),
      );
    const latest = sorted[sorted.length - 1];
    groups.push({
      promptKey,
      category: isWindowCategory(latest.category) ? latest.category : "daily",
      question: latest.question,
      entries: sorted,
      latestAnsweredOn: latest.answered_on,
      latestCreatedAt: latest.created_at,
      isMultiEra: sorted.length >= 2,
    });
  }
  return groups.sort(
    (a, b) =>
      b.latestAnsweredOn.localeCompare(a.latestAnsweredOn) ||
      b.latestCreatedAt.localeCompare(a.latestCreatedAt) ||
      a.promptKey.localeCompare(b.promptKey),
  );
}

/** 找出某道題目過去寫過的回答（由舊到新），供今日出題時顯示溫柔回顧提示 */
export function pastReflectionsForPrompt(
  rows: readonly IdealReflectionRow[],
  promptKey: string,
  excludeId?: string,
): IdealReflectionRow[] {
  return rows
    .filter((r) => r.deleted_at === null && r.prompt_key === promptKey && r.id !== excludeId)
    .slice()
    .sort(
      (a, b) =>
        a.answered_on.localeCompare(b.answered_on) ||
        a.created_at.localeCompare(b.created_at) ||
        a.id.localeCompare(b.id),
    );
}

/** 組出過去曾作答的溫柔提示字句；沒答過回 null */
export function formatPastPromptCue(past: readonly IdealReflectionRow[]): string | null {
  if (past.length === 0) return null;
  const first = past[0];
  const ym = first.answered_on.slice(0, 7).replace("-", ".");
  if (past.length === 1) {
    return `曾於 ${ym} 寫過這題，收進手札後可並排回顧`;
  }
  return `曾於 ${ym} 等寫過 ${past.length} 次，收進手札後可並排回顧`;
}

export interface PinnedMotto {
  kind: "card" | "reflection";
  id: string;
  motto: string;
  title: string;
  subtitle: string;
}

function singleLineClip(s: string, maxLen = 72): string {
  const first = s
    .split(/\r?\n/)
    .map((x) => x.trim())
    .find(Boolean) ?? "";
  return first.length > maxLen ? `${first.slice(0, maxLen - 1)}…` : first;
}

/**
 * 解析目前釘選在今日頁頂端的「心之所向」題詞。
 * 若多台裝置離線期間各自釘選了不同項目，以 `updated_at DESC, id ASC` 決定性選出最新釘選的一筆。
 */
export function resolvePinnedMotto(
  cards: readonly IdealCardRow[],
  reflections: readonly IdealReflectionRow[],
): PinnedMotto | null {
  type Candidate = PinnedMotto & { updatedAt: string };
  const candidates: Candidate[] = [];

  for (const c of cards) {
    if (c.deleted_at !== null || !c.pinned) continue;
    const motto = singleLineClip(c.motto.trim() || c.title.trim() || c.body.trim());
    if (!motto) continue;
    candidates.push({
      kind: "card",
      id: c.id,
      motto,
      title: c.title,
      subtitle: IDEAL_THEME_LABEL[c.theme] ?? "理想手札",
      updatedAt: c.updated_at,
    });
  }

  for (const r of reflections) {
    if (r.deleted_at !== null || !r.pinned) continue;
    const motto = singleLineClip(r.answer);
    if (!motto) continue;
    candidates.push({
      kind: "reflection",
      id: r.id,
      motto,
      title: r.question,
      subtitle: `車窓の問い・${r.answered_on.replace(/-/g, ".")}`,
      updatedAt: r.updated_at,
    });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  const top = candidates[0];
  return {
    kind: top.kind,
    id: top.id,
    motto: top.motto,
    title: top.title,
    subtitle: top.subtitle,
  };
}
