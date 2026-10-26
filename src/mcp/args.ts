/**
 * 工具參數的讀取與檢查（不引第三方 schema 套件：參數形狀很淺，手寫幾支小工具比較直白）。
 * 錯一律丟 `McpUserError`，訊息寫給助理看、要說得出「哪個欄位、要什麼」，它才能自己修正重送。
 */
import { MCP_BATCH_LIMIT, McpUserError, type JsonSchema } from "./types";

type Args = Record<string, unknown>;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 營業日表記：小時可以 ≥ 24（日界線之後的凌晨），由 repository 再驗範圍 */
const CLOCK_RE = /^\d{2}:\d{2}$/;

export function obj(v: unknown, where: string): Args {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new McpUserError(`${where} 要是物件`);
  return v as Args;
}

export function str(a: Args, key: string, opts: { required: true; where?: string }): string;
export function str(a: Args, key: string, opts?: { required?: false; where?: string }): string | undefined;
export function str(a: Args, key: string, opts: { required?: boolean; where?: string } = {}): string | undefined {
  const v = a[key];
  const at = opts.where ? `${opts.where}.${key}` : key;
  if (v === undefined || v === null) {
    if (opts.required) throw new McpUserError(`缺少 ${at}`);
    return undefined;
  }
  if (typeof v !== "string") throw new McpUserError(`${at} 要是字串`);
  const t = v.trim();
  if (opts.required && !t) throw new McpUserError(`${at} 不能是空字串`);
  return t;
}

/** 可以是 null（＝清除）的字串欄位：沒給＝undefined（不動）、null＝清除 */
export function nullableStr(a: Args, key: string, where?: string): string | null | undefined {
  if (a[key] === null) return null;
  return str(a, key, { where });
}

export function date(a: Args, key: string, opts: { required: true; where?: string }): string;
export function date(a: Args, key: string, opts?: { required?: false; where?: string }): string | undefined;
export function date(a: Args, key: string, opts: { required?: boolean; where?: string } = {}): string | undefined {
  const v = opts.required ? str(a, key, { required: true, where: opts.where }) : str(a, key, { where: opts.where });
  if (v === undefined) return undefined;
  if (!DATE_RE.test(v) || Number.isNaN(new Date(`${v}T00:00:00`).getTime())) {
    throw new McpUserError(`${opts.where ? `${opts.where}.` : ""}${key} 要是 YYYY-MM-DD 日期，收到「${v}」`);
  }
  return v;
}

/** 日期，null＝清除 */
export function nullableDate(a: Args, key: string, where?: string): string | null | undefined {
  if (a[key] === null) return null;
  return date(a, key, { where });
}

/** 時刻 'HH:MM'（營業日表記），null＝清除 */
export function nullableClock(a: Args, key: string, where?: string): string | null | undefined {
  if (a[key] === null) return null;
  const v = str(a, key, { where });
  if (v === undefined) return undefined;
  if (!CLOCK_RE.test(v)) throw new McpUserError(`${where ? `${where}.` : ""}${key} 要是 HH:MM 時刻，收到「${v}」`);
  return v;
}

export function int(a: Args, key: string, opts: { min?: number; max?: number; where?: string } = {}): number | undefined {
  const v = a[key];
  if (v === undefined || v === null) return undefined;
  const at = opts.where ? `${opts.where}.${key}` : key;
  if (typeof v !== "number" || !Number.isInteger(v)) throw new McpUserError(`${at} 要是整數`);
  if (opts.min !== undefined && v < opts.min) throw new McpUserError(`${at} 不能小於 ${opts.min}`);
  if (opts.max !== undefined && v > opts.max) throw new McpUserError(`${at} 不能大於 ${opts.max}`);
  return v;
}

export function bool(a: Args, key: string, where?: string): boolean | undefined {
  const v = a[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new McpUserError(`${where ? `${where}.` : ""}${key} 要是 true 或 false`);
  return v;
}

export function oneOf<T extends string>(a: Args, key: string, allowed: readonly T[], where?: string): T | undefined {
  const v = str(a, key, { where });
  if (v === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(v)) {
    throw new McpUserError(`${where ? `${where}.` : ""}${key} 只能是 ${allowed.join("／")}，收到「${v}」`);
  }
  return v as T;
}

/** 陣列式寫入的主陣列：1～50 筆，每筆都是物件 */
export function batch(a: Args, key: string): Args[] {
  const v = a[key];
  if (!Array.isArray(v)) throw new McpUserError(`${key} 要是陣列`);
  if (v.length === 0) throw new McpUserError(`${key} 至少一筆`);
  if (v.length > MCP_BATCH_LIMIT) throw new McpUserError(`${key} 一次最多 ${MCP_BATCH_LIMIT} 筆，收到 ${v.length} 筆`);
  return v.map((x, i) => obj(x, `${key}[${i}]`));
}

/** 字串陣列（id 清單之類）：1～50 筆 */
export function idList(a: Args, key: string): string[] {
  const v = a[key];
  if (!Array.isArray(v)) throw new McpUserError(`${key} 要是字串陣列`);
  if (v.length === 0) throw new McpUserError(`${key} 至少一筆`);
  if (v.length > MCP_BATCH_LIMIT) throw new McpUserError(`${key} 一次最多 ${MCP_BATCH_LIMIT} 筆`);
  return v.map((x, i) => {
    if (typeof x !== "string" || !x.trim()) throw new McpUserError(`${key}[${i}] 要是非空字串`);
    return x.trim();
  });
}

/** 區間檢查：from ≤ to，且最多 `maxDays` 天（避免一次把整本手帳倒給模型） */
export function range(a: Args, fromKey: string, toKey: string, maxDays: number): { from: string; to: string } {
  const from = date(a, fromKey, { required: true });
  const to = date(a, toKey, { required: true });
  if (from > to) throw new McpUserError(`${fromKey} 不能晚於 ${toKey}`);
  const days = (new Date(`${to}T00:00:00`).getTime() - new Date(`${from}T00:00:00`).getTime()) / 86_400_000 + 1;
  if (days > maxDays) throw new McpUserError(`一次最多查 ${maxDays} 天，收到 ${Math.round(days)} 天`);
  return { from, to };
}

/**
 * 參數裡 schema 沒列的欄位一律回錯：Rust 不驗 inputSchema，拼錯的欄位（例 due、scheduled_on）
 * 會被默默忽略、票照建，助理還以為寫進去了。陣列欄位的每一筆也照 items 檢查。
 * `run.ts` 對每支工具統一先跑一次（任務線評審抓到、收成全模組）。
 */
export function checkKeys(a: Args, schema: JsonSchema, where?: string): void {
  const props = schema.properties;
  if (!props) return;
  const extra = Object.keys(a).filter((k) => !(k in props));
  if (extra.length) {
    throw new McpUserError(`${where ? `${where} ` : ""}不認得的欄位：${extra.join("、")}（可用：${Object.keys(props).join("、")}）`);
  }
  for (const [k, s] of Object.entries(props)) {
    const v = a[k];
    if (s.type !== "array" || !s.items?.properties || !Array.isArray(v)) continue;
    v.forEach((x, i) => {
      if (x && typeof x === "object" && !Array.isArray(x)) checkKeys(x as Args, s.items!, `${k}[${i}]`);
    });
  }
}

