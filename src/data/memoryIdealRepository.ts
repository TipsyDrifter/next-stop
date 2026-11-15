/**
 * 車窓・理想手札與「車窓の問い」的記憶體實作（`?mock=1` 與 Node 測試共用）。
 */
import type { IdealRepository } from "./idealRepository";
import {
  aliveIdealCards,
  aliveReflections,
  defaultArtForTheme,
  isIdealArtPreset,
  isIdealTheme,
  isWindowCategory,
  validatePhotoDataUrl,
  type CreateIdealCardInput,
  type CreateReflectionInput,
  type IdealCardRow,
  type IdealReflectionRow,
  type UpdateIdealCardPatch,
  type UpdateReflectionPatch,
} from "../domain/idealTecho.ts";

let seq = 0;
function nextIso(): string {
  seq += 1;
  return new Date(Date.now() + seq).toISOString();
}

export class MemoryIdealRepository implements IdealRepository {
  private cards = new Map<string, IdealCardRow>();
  private reflections = new Map<string, IdealReflectionRow>();

  constructor(opts?: { seedDemo?: boolean }) {
    if (opts?.seedDemo) this.seed();
  }

  private seed(): void {
    const t0 = "2026-02-15T10:00:00.000Z";
    const t1 = "2026-06-20T14:30:00.000Z";
    const t2 = "2026-09-12T18:10:00.000Z";
    const demoCards: IdealCardRow[] = [
      {
        id: "demo-ideal-person-1",
        theme: "person",
        title: "溫柔而有底氣的創造者",
        body: "把複雜留給架構，把純粹與溫度留給生活與身邊的人。不急著迎合外面的喧囂，而是做出真正能長久陪伴日常的作品。",
        motto: "把複雜留給架構，把純粹與溫度留給生活與身邊的人。",
        art_preset: "starry-window",
        photo_data: null,
        pinned: 1,
        position: 0,
        created_at: t0,
        updated_at: t2,
        deleted_at: null,
      },
      {
        id: "demo-ideal-scenery-1",
        theme: "scenery",
        title: "看得見晚霞與路面電車的書桌",
        body: "胡桃木桌面放著鋼筆與象牙紙手札，傍晚泡一壺熱茶，聽著遠處平交道的叮噹聲寫小說、學日文，沒有被追趕的焦慮。",
        motto: "在沒有追趕感的光線裡，泡一壺熱茶慢慢創作。",
        art_preset: "night-desk",
        photo_data: null,
        pinned: 0,
        position: 0,
        created_at: t1,
        updated_at: t1,
        deleted_at: null,
      },
      {
        id: "demo-ideal-horizon-1",
        theme: "horizon",
        title: "搭江之電與叡山電車的秋日慢旅",
        body: "等日文能夠自在點餐與看懂站牌的時候，帶上這本親手打造的手帳，去鎌倉海邊與京都出町柳散步一整週。",
        motto: "帶上自己寫的手帳，去鎌倉海邊與京都出町柳散步。",
        art_preset: "sea-station",
        photo_data: null,
        pinned: 0,
        position: 0,
        created_at: t2,
        updated_at: t2,
        deleted_at: null,
      },
    ];
    for (const c of demoCards) this.cards.set(c.id, c);

    const demoRefs: IdealReflectionRow[] = [
      {
        id: "demo-ref-2025",
        prompt_key: "daily.good-day",
        category: "daily",
        question: "如果不看任何效率指標，怎樣的一天會讓你在睡前覺得「今天真好」？",
        answer: "只要那天沒有因為小事責備自己，晚上有時間聽兩首喜歡的歌、跟重要的人聊幾句日常，就覺得很滿足了。",
        answered_on: "2025-11-18",
        diary_note_id: null,
        pinned: 0,
        created_at: "2025-11-18T15:20:00.000Z",
        updated_at: "2025-11-18T15:20:00.000Z",
        deleted_at: null,
      },
      {
        id: "demo-ref-2026",
        prompt_key: "daily.good-day",
        category: "daily",
        question: "如果不看任何效率指標，怎樣的一天會讓你在睡前覺得「今天真好」？",
        answer: "早上自然醒泡杯熱美式，下午把腦海裡的一個小設計親手做出來，傍晚散步看天色慢慢變暗，心裡很安靜的一天。",
        answered_on: "2026-11-10",
        diary_note_id: null,
        pinned: 0,
        created_at: "2026-11-10T16:05:00.000Z",
        updated_at: "2026-11-10T16:05:00.000Z",
        deleted_at: null,
      },
    ];
    for (const r of demoRefs) this.reflections.set(r.id, r);
  }

  private clearAllPins(now: string, except?: { kind: "card" | "reflection"; id: string } | null): void {
    for (const c of this.cards.values()) {
      if (c.deleted_at === null && c.pinned && !(except?.kind === "card" && except.id === c.id)) {
        c.pinned = 0;
        c.updated_at = now;
      }
    }
    for (const r of this.reflections.values()) {
      if (r.deleted_at === null && r.pinned && !(except?.kind === "reflection" && except.id === r.id)) {
        r.pinned = 0;
        r.updated_at = now;
      }
    }
  }

  async listCards(): Promise<IdealCardRow[]> {
    return aliveIdealCards([...this.cards.values()]).map((c) => ({ ...c }));
  }

  async getCard(id: string, opts?: { withDeleted?: boolean }): Promise<IdealCardRow | null> {
    const r = this.cards.get(id);
    if (!r) return null;
    if (r.deleted_at !== null && !opts?.withDeleted) return null;
    return { ...r };
  }

  async createCard(input: CreateIdealCardInput): Promise<IdealCardRow> {
    const title = input.title.trim();
    if (!title) throw new RangeError("請填寫風景卡標題");
    const theme = isIdealTheme(input.theme) ? input.theme : "person";
    const body = (input.body ?? "").trim();
    const motto = (input.motto ?? "").trim();
    const artPreset = isIdealArtPreset(input.artPreset) ? input.artPreset : defaultArtForTheme(theme);
    const photoData = validatePhotoDataUrl(input.photoData);
    const pinned = input.pinned ? 1 : 0;
    const now = nextIso();
    const id = crypto.randomUUID();
    const maxPos = [...this.cards.values()]
      .filter((c) => c.deleted_at === null && c.theme === theme)
      .reduce((m, c) => Math.max(m, c.position), -1);

    if (pinned) this.clearAllPins(now, { kind: "card", id });
    const row: IdealCardRow = {
      id,
      theme,
      title,
      body,
      motto,
      art_preset: artPreset,
      photo_data: photoData,
      pinned,
      position: maxPos + 1,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
    this.cards.set(id, row);
    return { ...row };
  }

  async updateCard(id: string, patch: UpdateIdealCardPatch): Promise<IdealCardRow> {
    const cur = this.cards.get(id);
    if (!cur || cur.deleted_at !== null) throw new RangeError("找不到這張手札風景卡");
    const now = nextIso();
    const next: IdealCardRow = { ...cur };

    if (patch.theme !== undefined && isIdealTheme(patch.theme)) next.theme = patch.theme;
    if (patch.title !== undefined) {
      const t = patch.title.trim();
      if (!t) throw new RangeError("請填寫風景卡標題");
      next.title = t;
    }
    if (patch.body !== undefined) next.body = patch.body.trim();
    if (patch.motto !== undefined) next.motto = patch.motto.trim();
    if (patch.artPreset !== undefined && isIdealArtPreset(patch.artPreset)) next.art_preset = patch.artPreset;
    if (patch.photoData !== undefined) next.photo_data = validatePhotoDataUrl(patch.photoData);
    if (patch.position !== undefined) next.position = patch.position;
    if (patch.pinned !== undefined) {
      const pinVal = patch.pinned ? 1 : 0;
      if (pinVal === 1) this.clearAllPins(now, { kind: "card", id });
      next.pinned = pinVal;
    }
    next.updated_at = now;
    this.cards.set(id, next);
    return { ...next };
  }

  async deleteCard(id: string): Promise<void> {
    const cur = this.cards.get(id);
    if (!cur || cur.deleted_at !== null) return;
    const now = nextIso();
    cur.deleted_at = now;
    cur.updated_at = now;
  }

  async restoreCard(id: string): Promise<void> {
    const cur = this.cards.get(id);
    if (!cur) throw new RangeError("找不到這張手札風景卡");
    if (cur.deleted_at === null) return;
    cur.deleted_at = null;
    cur.updated_at = nextIso();
  }

  async listReflections(): Promise<IdealReflectionRow[]> {
    return aliveReflections([...this.reflections.values()]).map((r) => ({ ...r }));
  }

  async getReflection(id: string, opts?: { withDeleted?: boolean }): Promise<IdealReflectionRow | null> {
    const r = this.reflections.get(id);
    if (!r) return null;
    if (r.deleted_at !== null && !opts?.withDeleted) return null;
    return { ...r };
  }

  async createReflection(input: CreateReflectionInput): Promise<IdealReflectionRow> {
    const question = input.question.trim();
    const answer = input.answer.trim();
    const promptKey = input.promptKey.trim();
    if (!question) throw new RangeError("題目不能空白");
    if (!answer) throw new RangeError("請寫下此刻的想法再收進手札");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.answeredOn)) throw new RangeError("作答日期格式不正確");

    const category = isWindowCategory(input.category) ? input.category : "daily";
    const pinned = input.pinned ? 1 : 0;
    const now = nextIso();
    const id = crypto.randomUUID();

    if (pinned) this.clearAllPins(now, { kind: "reflection", id });
    const row: IdealReflectionRow = {
      id,
      prompt_key: promptKey,
      category,
      question,
      answer,
      answered_on: input.answeredOn,
      diary_note_id: input.diaryNoteId ?? null,
      pinned,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
    this.reflections.set(id, row);
    return { ...row };
  }

  async updateReflection(id: string, patch: UpdateReflectionPatch): Promise<IdealReflectionRow> {
    const cur = this.reflections.get(id);
    if (!cur || cur.deleted_at !== null) throw new RangeError("找不到這則車窓問答");
    const now = nextIso();
    const next: IdealReflectionRow = { ...cur };

    if (patch.question !== undefined) {
      const q = patch.question.trim();
      if (!q) throw new RangeError("題目不能空白");
      next.question = q;
    }
    if (patch.answer !== undefined) {
      const a = patch.answer.trim();
      if (!a) throw new RangeError("回答內容不能空白");
      next.answer = a;
    }
    if (patch.answeredOn !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(patch.answeredOn)) throw new RangeError("作答日期格式不正確");
      next.answered_on = patch.answeredOn;
    }
    if (patch.diaryNoteId !== undefined) next.diary_note_id = patch.diaryNoteId;
    if (patch.pinned !== undefined) {
      const pinVal = patch.pinned ? 1 : 0;
      if (pinVal === 1) this.clearAllPins(now, { kind: "reflection", id });
      next.pinned = pinVal;
    }
    next.updated_at = now;
    this.reflections.set(id, next);
    return { ...next };
  }

  async deleteReflection(id: string): Promise<void> {
    const cur = this.reflections.get(id);
    if (!cur || cur.deleted_at !== null) return;
    const now = nextIso();
    cur.deleted_at = now;
    cur.updated_at = now;
  }

  async restoreReflection(id: string): Promise<void> {
    const cur = this.reflections.get(id);
    if (!cur) throw new RangeError("找不到這則車窓問答");
    if (cur.deleted_at === null) return;
    cur.deleted_at = null;
    cur.updated_at = nextIso();
  }

  async setPinned(target: { kind: "card" | "reflection"; id: string } | null): Promise<void> {
    const now = nextIso();
    this.clearAllPins(now, target);
    if (!target) return;
    if (target.kind === "card") {
      const c = this.cards.get(target.id);
      if (!c || c.deleted_at !== null) throw new RangeError("找不到這張手札風景卡");
      c.pinned = 1;
      c.updated_at = now;
    } else {
      const r = this.reflections.get(target.id);
      if (!r || r.deleted_at !== null) throw new RangeError("找不到這則車窓問答");
      r.pinned = 1;
      r.updated_at = now;
    }
  }

  async search(query: string): Promise<{ cards: IdealCardRow[]; reflections: IdealReflectionRow[] }> {
    const q = query.trim().toLowerCase();
    if (!q) return { cards: [], reflections: [] };
    const cards = aliveIdealCards([...this.cards.values()]).filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        c.body.toLowerCase().includes(q) ||
        c.motto.toLowerCase().includes(q),
    );
    const reflections = aliveReflections([...this.reflections.values()]).filter(
      (r) => r.question.toLowerCase().includes(q) || r.answer.toLowerCase().includes(q),
    );
    return { cards, reflections };
  }
}
