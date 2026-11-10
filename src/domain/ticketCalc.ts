/**
 * ticketCalc——售票口記一筆的純函式四則運算解析與小算盤引擎（v1.28 功能 3）。
 *
 * 設計原則：
 * - 零 `eval`／`Function`：手寫遞迴下降解析器（Recursive Descent Parser），安全處理 `+ - * / ( )`。
 * - 全形與符號正規化：全形數字 `０-９` → `0-9`、`× ✕ ✖ ＊` → `*`、`÷ ／` → `/`、`＋` → `+`、`－ — – −` → `-`、`（` `）` → `(` `)`。
 * - 尾端未完成運算子容錯：輸入過程如 `120+45+` 或 `(120+30` 時，即時預覽與收斂都能安全算出目前累積結果 `165`／`150`。
 */

export type CalcEvalResult =
  | { ok: true; value: number; formatted: string; isExpression: boolean }
  | { ok: false; error: string };

/** 將全形數字轉半形，並將常見全形／替代運算子轉為標準符號 */
function canonicalizeChars(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    const code = ch.charCodeAt(0);
    // 全形數字 ０(0xFF10)..９(0xFF19)
    if (code >= 0xff10 && code <= 0xff19) {
      out += String.fromCharCode(code - 0xff10 + 0x30);
      continue;
    }
    if (ch === "．" || ch === "。") {
      out += ".";
      continue;
    }
    if (ch === "（") {
      out += "(";
      continue;
    }
    if (ch === "）") {
      out += ")";
      continue;
    }
    if (ch === "＋") {
      out += "+";
      continue;
    }
    if (ch === "－" || ch === "—" || ch === "–" || ch === "−") {
      out += "-";
      continue;
    }
    if (ch === "✕" || ch === "✖" || ch === "＊") {
      out += "*";
      continue;
    }
    if (ch === "／") {
      out += "/";
      continue;
    }
    // 移除空白與千分位逗號
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "," || ch === "，") {
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * 過濾非法字元，允許數字、`.`、`+`、`-`、`*`、`/`、`×`、`÷`、`(`、`)`。
 * 全形數字與全形運算符號會先轉為對應有效字元。
 */
export function normalizeCalcInput(raw: string): string {
  const canon = canonicalizeChars(raw);
  let out = "";
  for (let i = 0; i < canon.length; i++) {
    const ch = canon[i];
    if (
      (ch >= "0" && ch <= "9") ||
      ch === "." ||
      ch === "+" ||
      ch === "-" ||
      ch === "*" ||
      ch === "/" ||
      ch === "×" ||
      ch === "÷" ||
      ch === "(" ||
      ch === ")"
    ) {
      out += ch;
    }
  }
  return out;
}

/**
 * 判斷輸入字串是否包含算式運算符號（決定是否顯示即時算式預覽 `= 245`）。
 * 單純前導負號（如 `-350`）視為負數文字而非算式；但 `500-120` 或 `-100+50` 為算式。
 */
export function hasCalcOperator(raw: string): boolean {
  const s = canonicalizeChars(raw).replace(/×/g, "*").replace(/÷/g, "/");
  if (!s) return false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "+" || ch === "*" || ch === "/" || ch === "(" || ch === ")") return true;
    if (ch === "-" && i > 0) return true;
  }
  return false;
}

/** 將數值四捨五入至指定小數位（預設 2 位），並轉為不帶多餘尾端 0 的字串 */
export function formatCalcValue(val: number, decimals = 2): string {
  const d = Math.max(0, Math.min(6, Math.trunc(decimals)));
  const factor = Math.pow(10, d);
  const rounded = Math.round((val + Number.EPSILON) * factor) / factor;
  const clean = Object.is(rounded, -0) ? 0 : rounded;
  return Number(clean.toFixed(d)).toString();
}

/**
 * 移除尾端尚未輸入完的運算子（如 `120+45+` → `120+45`、`120*(` → `120`），
 * 並自動補齊未閉合的右括號 `)`。
 */
function trimIncompleteTail(expr: string): string {
  let s = expr;
  while (s.length > 0) {
    const last = s[s.length - 1];
    if (last === "+" || last === "-" || last === "*" || last === "/" || last === "(" || last === ".") {
      // 若 `.` 前面有數字（如 `120.`），保留給數字解析處理；若單獨掛在運算子後則剝除
      if (last === "." && s.length >= 2 && s[s.length - 2] >= "0" && s[s.length - 2] <= "9") {
        break;
      }
      s = s.slice(0, -1);
    } else {
      break;
    }
  }
  return s;
}

type Token =
  | { type: "num"; value: number }
  | { type: "op"; op: "+" | "-" | "*" | "/" }
  | { type: "paren"; paren: "(" | ")" };

function tokenize(expr: string): { ok: true; tokens: Token[] } | { ok: false; error: string } {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch >= "0" && ch <= "9" || ch === ".") {
      let start = i;
      let dots = 0;
      while (i < expr.length && ((expr[i] >= "0" && expr[i] <= "9") || expr[i] === ".")) {
        if (expr[i] === ".") dots++;
        i++;
      }
      if (dots > 1) return { ok: false, error: "小數點格式有誤" };
      const numStr = expr.slice(start, i);
      if (numStr === ".") return { ok: false, error: "小數點格式有誤" };
      const val = Number(numStr);
      if (!Number.isFinite(val)) return { ok: false, error: "數字格式有誤" };
      tokens.push({ type: "num", value: val });
      continue;
    }
    if (ch === "+" || ch === "-" || ch === "*" || ch === "/") {
      tokens.push({ type: "op", op: ch });
      i++;
      continue;
    }
    if (ch === "(" || ch === ")") {
      tokens.push({ type: "paren", paren: ch });
      i++;
      continue;
    }
    return { ok: false, error: `無法辨識的字元：${ch}` };
  }
  return { ok: true, tokens };
}

/**
 * 評估算式字串：
 * - 支援 `+ - * / × ÷ ( )` 及全形符號
 * - 支援尾端未完成運算子容錯（例如 `120+45+` → `165`）
 */
export function evaluateCalcExpression(raw: string, decimals = 2): CalcEvalResult {
  const trimmedRaw = raw.replace(/=+$/g, "");
  const isExpr = hasCalcOperator(trimmedRaw);
  const canon = canonicalizeChars(trimmedRaw).replace(/×/g, "*").replace(/÷/g, "/");
  if (!canon) return { ok: false, error: "請輸入金額" };

  // 檢查是否有非法字元
  for (let i = 0; i < canon.length; i++) {
    const ch = canon[i];
    if (
      !((ch >= "0" && ch <= "9") || ch === "." || ch === "+" || ch === "-" || ch === "*" || ch === "/" || ch === "(" || ch === ")")
    ) {
      return { ok: false, error: `含有無效字元：${ch}` };
    }
  }

  const cleaned = trimIncompleteTail(canon);
  if (!cleaned) return { ok: false, error: "算式尚未完成" };

  // 檢查並補齊右括號
  let balance = 0;
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === "(") balance++;
    else if (cleaned[i] === ")") {
      balance--;
      if (balance < 0) return { ok: false, error: "括號不對稱" };
    }
  }
  const balancedExpr = balance > 0 ? cleaned + ")".repeat(balance) : cleaned;

  // 若補齊後成了空括號 `()`，擋下
  if (balancedExpr.includes("()")) return { ok: false, error: "括號內不能是空的" };

  const tokRes = tokenize(balancedExpr);
  if (!tokRes.ok) return tokRes;
  const { tokens } = tokRes;
  if (tokens.length === 0) return { ok: false, error: "請輸入金額" };

  let pos = 0;
  let divZero = false;
  let syntaxErr: string | null = null;

  function parseExpr(): number {
    let left = parseTerm();
    while (pos < tokens.length) {
      const t = tokens[pos];
      if (t.type === "op" && (t.op === "+" || t.op === "-")) {
        pos++;
        // 尾端在括號內未完成的容錯（如 `(120+30+)`）
        if (pos >= tokens.length || (tokens[pos].type === "paren" && (tokens[pos] as { paren: string }).paren === ")")) {
          break;
        }
        const right = parseTerm();
        left = t.op === "+" ? left + right : left - right;
      } else {
        break;
      }
    }
    return left;
  }

  function parseTerm(): number {
    let left = parseFactor();
    while (pos < tokens.length) {
      const t = tokens[pos];
      if (t.type === "op" && (t.op === "*" || t.op === "/")) {
        pos++;
        if (pos >= tokens.length || (tokens[pos].type === "paren" && (tokens[pos] as { paren: string }).paren === ")")) {
          break;
        }
        const right = parseFactor();
        if (t.op === "*") {
          left = left * right;
        } else {
          if (right === 0) {
            divZero = true;
            return NaN;
          }
          left = left / right;
        }
      } else {
        break;
      }
    }
    return left;
  }

  function parseFactor(): number {
    if (pos >= tokens.length) {
      syntaxErr = "算式尚未完成";
      return NaN;
    }
    const t = tokens[pos];
    if (t.type === "op" && (t.op === "+" || t.op === "-")) {
      pos++;
      const v = parseFactor();
      return t.op === "-" ? -v : v;
    }
    if (t.type === "paren" && t.paren === "(") {
      pos++;
      const v = parseExpr();
      if (pos < tokens.length && tokens[pos].type === "paren" && (tokens[pos] as { paren: string }).paren === ")") {
        pos++;
      } else {
        syntaxErr = "括號不對稱";
        return NaN;
      }
      return v;
    }
    if (t.type === "num") {
      pos++;
      return t.value;
    }
    syntaxErr = "算式格式有誤";
    return NaN;
  }

  const rawVal = parseExpr();
  if (divZero) return { ok: false, error: "不能除以 0" };
  if (syntaxErr) return { ok: false, error: syntaxErr };
  if (pos < tokens.length) return { ok: false, error: "算式格式有誤" };
  if (!Number.isFinite(rawVal)) return { ok: false, error: "計算結果無效" };

  const d = Math.max(0, Math.min(6, Math.trunc(decimals)));
  const factor = Math.pow(10, d);
  const rounded = Math.round((rawVal + Number.EPSILON) * factor) / factor;
  const value = Object.is(rounded, -0) ? 0 : rounded;
  const formatted = formatCalcValue(value, d);

  return {
    ok: true,
    value,
    formatted,
    isExpression: isExpr,
  };
}

/**
 * 收斂算式輸入（用於按下 `=`、`Enter`、失焦 `blur` 或存檔前）：
 * 若可計算出合法非負數值（或 `allowNegative: true` 時的任意合法數值）則回傳收斂後的數字字串，否則保留原值。
 */
export function commitCalcInput(
  raw: string,
  opts?: { allowNegative?: boolean; decimals?: number } | number,
): string {
  const decimals = typeof opts === "number" ? opts : (opts?.decimals ?? 2);
  const allowNegative = typeof opts === "object" && opts !== null ? (opts.allowNegative ?? false) : false;
  if (!raw.trim()) return raw;
  const res = evaluateCalcExpression(raw, decimals);
  if (!res.ok) return raw;
  if (!allowNegative && res.value < 0) return raw;
  return res.formatted;
}
