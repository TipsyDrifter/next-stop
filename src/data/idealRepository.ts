/**
 * 車窓・理想手札與「車窓の問い」的資料層介面與單例（第六本第四梯 v1.30；D-主-560～564）。
 *
 * 真機走 `SqliteIdealRepository`（WriteBatch 連同同步 op 原子寫入）；`?mock=1` 走 `MemoryIdealRepository`。
 */
import type {
  CreateIdealCardInput,
  CreateReflectionInput,
  IdealCardRow,
  IdealReflectionRow,
  UpdateIdealCardPatch,
  UpdateReflectionPatch,
} from "../domain/idealTecho";
import { MOCK_MODE, WIPED_MODE } from "./index";
import { SqliteIdealRepository } from "./sqliteIdealRepository";
import { MemoryIdealRepository } from "./memoryIdealRepository";

export interface IdealRepository {
  listCards(): Promise<IdealCardRow[]>;
  getCard(id: string, opts?: { withDeleted?: boolean }): Promise<IdealCardRow | null>;
  createCard(input: CreateIdealCardInput): Promise<IdealCardRow>;
  updateCard(id: string, patch: UpdateIdealCardPatch): Promise<IdealCardRow>;
  deleteCard(id: string): Promise<void>;
  restoreCard(id: string): Promise<void>;

  listReflections(): Promise<IdealReflectionRow[]>;
  getReflection(id: string, opts?: { withDeleted?: boolean }): Promise<IdealReflectionRow | null>;
  createReflection(input: CreateReflectionInput): Promise<IdealReflectionRow>;
  updateReflection(id: string, patch: UpdateReflectionPatch): Promise<IdealReflectionRow>;
  deleteReflection(id: string): Promise<void>;
  restoreReflection(id: string): Promise<void>;

  /** 排他釘選（或取消釘選 `target === null`）：將指定卡片或問答釘為「心之所向」，並將其他已釘選列設回 0 */
  setPinned(target: { kind: "card" | "reflection"; id: string } | null): Promise<void>;

  /** 關鍵字檢索（供快速跳轉與完整搜尋使用；不含已刪） */
  search(query: string): Promise<{ cards: IdealCardRow[]; reflections: IdealReflectionRow[] }>;
}

function makeIdealRepo(): IdealRepository {
  if (!MOCK_MODE) return new SqliteIdealRepository();
  return new MemoryIdealRepository({ seedDemo: !WIPED_MODE });
}

export const idealRepo: IdealRepository = makeIdealRepo();
