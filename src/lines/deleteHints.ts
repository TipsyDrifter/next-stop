/**
 * 刪除確認框的附加句（接縫 #62；旅客筆記車次④ 0-13）：桌機四個刪除入口共用的核心小函式。
 * 逐線問 `LineMount.nodeDeleteHints`（只問 `page.status` 為 open 的線），把有內容的句子以一個空白接起來；
 * 沒有線填值、或各線都回 null／空字串 ⇒ 回 ""，呼叫端的 `body` 一字不動。
 *
 * 一條線丟錯（同步或非同步）只 warn、當作沒有句子——刪除不能因為別線的查詢失敗而卡住。
 * 本檔不 import 任何元件或 store（只經 `./runtime` 查表），四個呼叫端都可以直接 import。
 */
import type { NodeRow } from "../domain";
import { lineNodeDeleteHints } from "./runtime";

/** 附加句（可能是空字串）；`descendantIds`＝呼叫端已知的底下節點 id（不含 node 自己，沒載到就傳 `[]`） */
export async function collectDeleteHints(node: NodeRow, descendantIds: readonly string[]): Promise<string> {
  const fns = lineNodeDeleteHints();
  if (!fns.length) return "";
  const parts = await Promise.all(
    fns.map(async (fn) => {
      try {
        return (await fn(node, descendantIds)) ?? "";
      } catch (e) {
        console.warn("[nodeDeleteHints]", e);
        return "";
      }
    }),
  );
  return parts.map((p) => p.trim()).filter(Boolean).join(" ");
}

/** 把附加句接在確認框的 `body` 後面（句子空 ⇒ 原樣回傳） */
export function withDeleteHints(body: string, hints: string): string {
  return hints ? `${body} ${hints}` : body;
}

/** 走 `childrenOf` 收集 id 底下所有節點的 id（不含自己）；只吃結構、不綁 `TreeIndex` 型別，免得核心檔互相 import */
export function descendantIdsOf(tree: { childrenOf: Readonly<Record<string, readonly string[] | undefined>> }, id: string): string[] {
  const out: string[] = [];
  const stack = [...(tree.childrenOf[id] ?? [])];
  while (stack.length) {
    const c = stack.pop() as string;
    out.push(c);
    stack.push(...(tree.childrenOf[c] ?? []));
  }
  return out;
}
