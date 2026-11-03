/**
 * 支線章節列尾的那一句（丁 D-主-247；原型「4 班・済 1」「1 班・2 張」）：數**直屬**子項——列車＝班、車票＝張、支線＝條；
 * 済＝直屬的列車與車票裡已済的（支線不算済，它是主題）。桌機大綱與手機路線圖同一支。純函式。
 */
export interface ChapterCount {
  trains: number;
  tickets: number;
  branches: number;
  done: number;
}

export function chapterCount<N extends { kind: string }>(kids: readonly N[], isDone: (n: N) => boolean): ChapterCount {
  const c: ChapterCount = { trains: 0, tickets: 0, branches: 0, done: 0 };
  for (const k of kids) {
    if (k.kind === "branch") c.branches++;
    else if (k.kind === "ticket") c.tickets++;
    else c.trains++;
    if (k.kind !== "branch" && isDone(k)) c.done++;
  }
  return c;
}

/** 「2 條支線・4 班・3 張」各段（0 的不寫）；什麼都沒有＝「還沒有內容」 */
export function chapterParts(c: ChapterCount): string[] {
  const out: string[] = [];
  if (c.branches) out.push(`${c.branches} 條支線`);
  if (c.trains) out.push(`${c.trains} 班`);
  if (c.tickets) out.push(`${c.tickets} 張`);
  return out.length ? out : ["還沒有內容"];
}
