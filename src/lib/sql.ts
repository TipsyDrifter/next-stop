/**
 * SQL 小工具（零 import；純函式，`node --test` 直接載）。
 */

/**
 * LIKE 的三個萬用字元跳脫（`\` 當跳脫字元；SQL 端要配 `ESCAPE '\'`）：`%`→`\%`、`_`→`\_`、`\`→`\\`。
 * 用法：`WHERE name LIKE $1 ESCAPE '\'`，參數 `` `%${escapeLike(q)}%` ``（接縫 #67：打 `%` 或 `_` 不該列出全部）。
 */
export function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (c) => `\\${c}`);
}
