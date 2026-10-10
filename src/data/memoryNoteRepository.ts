/**
 * MemoryNoteRepository——NoteRepository 的記憶體實作（`?mock=1`；車次①契約 §3.5）。
 *
 * 語義對齊 `sqliteNoteRepository.ts`：排序（noted_at DESC, created_at DESC）、路線由 node_id 推導
 * （節點是路線＝它自己；其餘＝nodes.route_id）、node_missing（節點不在或已刪）、標題空字串存 null、
 * soft delete。資料進出一律複製（同 memoryRepository.ts），重新整理即重置。
 *
 * 種子：第一次任何方法被呼叫時 lazy 跑（要先問 nodeRepo 拿路線與列車 id）；`seed=false`
 * （`?wiped=1`，公約 §六）一顆都不種。內容**全部虛構**，不用主人的真實資料。
 */
import { nowUtcIso, uuid } from "../lib/db";
import { todayKey } from "../lib/date";
import type { NodeRow } from "../domain";
import { matchesQuery, type NoteRow } from "../domain/notes";
import type { NodeRepository } from "./nodeRepository";
import type { CreateNoteInput, NoteListItem, NotePatch, NoteRepository, NotesQuery } from "./noteRepository";

const clone = <T extends object>(o: T): T => ({ ...o });

/** ORDER BY noted_at DESC, created_at DESC */
function byNotedDesc(a: NoteRow, b: NoteRow): number {
  return b.noted_at.localeCompare(a.noted_at) || b.created_at.localeCompare(a.created_at);
}

function normTitle(t: string | null | undefined): string | null {
  return t && t.trim() ? t : null;
}

/** 本地日 key 往前 n 天、h:m 的 UTC ISO（種子用；固定偏移，重整不變） */
function isoDaysAgo(n: number, h: number, m: number): string {
  const [y, mo, d] = todayKey().split("-").map(Number);
  return new Date(y, mo - 1, d - n, h, m).toISOString();
}

/* ───────── 種子內文（虛構） ───────── */

const LIST_300 = [
  "這學期想把讀書的節奏固定下來，先寫下目前的做法，之後每個月回頭看一次。",
  "",
  "- 早上：通勤時聽二十分鐘的單字音檔，不求記住，只求耳朵熟。",
  "- 中午：吃完飯後讀一節課本，讀完在頁邊寫一句自己的話當摘要。",
  "- 晚上：把當天的摘要抄進筆記本，順手標出看不懂的地方。",
  "- 週末：挑一個看不懂的地方查資料，查完寫成一段短短的說明。",
  "",
  "目前卡住的是晚上常常太累，抄寫會被跳過。下個月試試看改成睡前只抄三行，降低門檻，先求不中斷再求量。",
  "如果三行都做不到，就改成只看一眼當天的摘要，讓腦袋知道今天有讀過東西。",
  "另外，考試前兩週不要再加新的做法，只維持原本的節奏，把力氣留給複習與睡眠。",
].join("\n");

const LONG_1000 = [
  "上週末去河堤邊走了一趟，原本只是想散步，結果走了快兩個小時。回來之後想把路上想到的事記下來，免得過幾天就忘了。",
  "",
  "第一件事是關於「開始」。很多事情拖著沒做，並不是因為難，而是因為開頭那一步想得太大。像是整理房間，腦中浮現的是把整個房間翻過來的畫面，當然提不起勁；但如果只是「把書桌左邊那一疊紙分成要的和不要的」，五分鐘就做完了，做完之後常常會順手再多做一點。走路也是一樣，出門的時候只打算走到第一座橋，到了橋邊覺得還可以，就再走到下一座。",
  "",
  "第二件事是關於「記錄」。以前記東西總想記得完整漂亮，結果往往記到一半就放棄，或是乾脆不記。最近改成想到什麼就先丟一句進去，不分類、不修飾，等有空再回頭整理。這樣做的好處是不會漏掉，壞處是會累積一堆零碎的句子。所以整理的時間一定要固定，不然零碎的句子只會越堆越多，最後變成另一種負擔。我打算每週日晚上花十五分鐘，把這一週丟進去的東西過一遍：能變成待辦的就排進日子裡，值得留著的就寫成完整一點的筆記，其他的直接刪掉。",
  "",
  "第三件事是關於「節奏」。河堤上有人跑步、有人騎車、有人像我一樣慢慢走，大家速度不一樣，但都在往前。以前看到別人進度快就會焦慮，覺得自己是不是太慢了。現在比較能接受每個人有自己的節奏，重點是方向對、有在動。與其一次衝很快然後停很久，不如每天都走一點點。這句話聽起來很老套，但真的走過兩個小時之後，腳的感覺會讓人相信它。",
  "",
  "第四件事比較小：路邊有一家賣豆花的小攤，老闆說他每天只做固定的量，賣完就收。問他為什麼不多做一點，他說多做的話品質顧不好，而且他也想早點回家陪家人。這讓我想到自己排行程的時候，常常把一天塞得太滿，結果每件事都做得匆匆忙忙。也許應該學老闆，先決定「今天只做這些」，做完就收工，剩下的明天再說。",
  "",
  "最後是一個提醒：下次出門記得帶水壺。這次走到一半口渴，附近又沒有店，只好硬撐回家。看起來是小事，但小事沒準備好，就會把一段好好的路程變得很狼狽。",
  "",
  "回程的時候天色暗下來，路燈一盞一盞亮起。我發現自己走得比去程慢，不是因為累，而是開始注意到很多來的時候沒看到的東西：橋墩上有人畫的小貓、河面上停著的白鷺、遠處球場傳來的哨音。也許做事情也是這樣，第一次經過只顧著往前，第二次經過才看得見細節。所以回頭整理不是浪費時間，而是讓同一段路再走一次，順便把漏掉的東西撿回來。",
  "",
  "寫到這裡大概就是這樣。下次散步的時候再看看有沒有新的想法，到時候再補在後面。",
].join("\n");

export class MemoryNoteRepository implements NoteRepository {
  private readonly notes = new Map<string, NoteRow>();
  private ready: Promise<void> | null = null;
  private readonly nodeRepo: NodeRepository;
  private readonly seed: boolean;

  constructor(nodeRepo: NodeRepository, opts: { seed: boolean }) {
    this.nodeRepo = nodeRepo;
    this.seed = opts.seed;
  }

  // ───────────── 讀取 ─────────────

  async listInbox(): Promise<NoteListItem[]> {
    await this.ensureSeed();
    const rows = this.alive().filter((n) => n.kind === "note" && n.inbox === 1);
    return this.toItems(rows.sort(byNotedDesc));
  }

  async listNotes(q: NotesQuery = {}): Promise<NoteListItem[]> {
    await this.ensureSeed();
    const rows = this.alive()
      .filter((n) => n.kind === "note" && n.inbox === 0)
      .filter((n) => matchesQuery(n, q.query ?? ""))
      .sort(byNotedDesc);
    let items = await this.toItems(rows);
    if (q.routeId === "none") items = items.filter((n) => n.node_id === null);
    else if (q.routeId) items = items.filter((n) => n.route_id === q.routeId);
    const offset = q.offset ?? 0;
    return items.slice(offset, offset + (q.limit ?? 200));
  }

  async getNote(id: string): Promise<NoteListItem | null> {
    await this.ensureSeed();
    const n = this.notes.get(id);
    if (!n || n.deleted_at !== null) return null;
    return (await this.toItems([n]))[0];
  }

  async listInboxTickets(): Promise<NodeRow[]> {
    return this.nodeRepo.listInboxTickets();
  }

  // ───────────── 寫入 ─────────────

  async create(input: CreateNoteInput): Promise<NoteRow> {
    await this.ensureSeed();
    return clone(this.insert(input, nowUtcIso()));
  }

  async update(id: string, patch: NotePatch): Promise<void> {
    await this.ensureSeed();
    const n = this.notes.get(id);
    if (!n) return;
    const next: NoteRow = { ...n };
    if (patch.title !== undefined) next.title = normTitle(patch.title);
    if (patch.body !== undefined) next.body = patch.body;
    if (patch.noted_at !== undefined) next.noted_at = patch.noted_at;
    if (patch.node_id !== undefined) next.node_id = patch.node_id;
    if (patch.inbox !== undefined) next.inbox = patch.inbox ? 1 : 0;
    const touched = (["title", "body", "noted_at", "node_id", "inbox"] as const).some((k) => patch[k] !== undefined);
    if (!touched) return;
    next.updated_at = nowUtcIso();
    this.notes.set(id, next);
  }

  async softDelete(id: string): Promise<void> {
    await this.ensureSeed();
    const n = this.notes.get(id);
    if (!n || n.deleted_at !== null) return;
    const now = nowUtcIso();
    this.notes.set(id, { ...n, deleted_at: now, updated_at: now });
  }

  async restore(ids: string[]): Promise<void> {
    await this.ensureSeed();
    const now = nowUtcIso();
    for (const id of ids) {
      const n = this.notes.get(id);
      if (n) this.notes.set(id, { ...n, deleted_at: null, updated_at: now });
    }
  }

  // ───────────── 內部 ─────────────

  private alive(): NoteRow[] {
    return [...this.notes.values()].filter((n) => n.deleted_at === null);
  }

  /** 補上 JOIN nodes 推出來的欄（＝sqlite 版 §3.4 的 CASE） */
  private async toItems(rows: NoteRow[]): Promise<NoteListItem[]> {
    const cache = new Map<string, NodeRow | null>();
    const out: NoteListItem[] = [];
    for (const n of rows) {
      let x: NodeRow | null = null;
      if (n.node_id) {
        if (!cache.has(n.node_id)) cache.set(n.node_id, await this.nodeRepo.getNode(n.node_id));
        x = cache.get(n.node_id) ?? null;
      }
      out.push({
        ...clone(n),
        route_id: x ? (x.kind === "route" ? x.id : x.route_id) : null,
        node_name: x ? x.name : null,
        node_kind: x ? x.kind : null,
        node_missing: !!n.node_id && (!x || x.deleted_at !== null),
      });
    }
    return out;
  }

  private insert(input: CreateNoteInput, now: string, createdAt?: string): NoteRow {
    const row: NoteRow = {
      id: uuid(),
      kind: input.kind,
      title: normTitle(input.title),
      body: input.body,
      entry_date: null,
      noted_at: input.notedAt ?? now,
      node_id: input.nodeId ?? null,
      inbox: input.inbox ? 1 : 0,
      created_at: createdAt ?? now,
      updated_at: createdAt ?? now,
      deleted_at: null,
    };
    this.notes.set(row.id, row);
    return row;
  }

  private ensureSeed(): Promise<void> {
    if (!this.ready) this.ready = this.seed ? this.seedDemo() : Promise.resolve();
    return this.ready;
  }

  /** 收件匣 4 則＋筆記 6 則（契約 §3.5）；noted_at 分佈在最近 100 天內（固定偏移） */
  private async seedDemo(): Promise<void> {
    let routeId: string | null = null;
    let trainId: string | null = null;
    try {
      const { routes } = await this.nodeRepo.listSidebar();
      routeId = routes[0]?.id ?? null;
      if (routeId) {
        const tree = await this.nodeRepo.listRouteTree(routeId);
        trainId = tree.find((n) => n.kind === "train")?.id ?? null;
      }
    } catch (e) {
      console.warn("MemoryNoteRepository：讀路線失敗，種子筆記全部不掛路線", e);
    }
    const put = (daysAgo: number, h: number, m: number, input: Omit<CreateNoteInput, "kind" | "notedAt">) => {
      const at = isoDaysAgo(daysAgo, h, m);
      this.insert({ kind: "note", notedAt: at, ...input }, at, at);
    };

    // 收件匣（未整理）：多行待辦清單／一句話／兩三行／三個字
    put(0, 8, 12, { body: "今天要做的事：\n・回信給社團\n・買影印卡\n・交作業\n・查 API 限額", inbox: true });
    put(0, 12, 40, { body: "車站旁那家麵包店週三公休，下次改週四去", inbox: true });
    put(1, 21, 5, {
      body: "讀到一個想法：每週固定一個晚上做回顧。\n先試三週，每次只留十五分鐘。\n做不到就縮成五分鐘。",
      inbox: true,
    });
    put(3, 18, 30, { body: "買電池", inbox: true });

    // 筆記的家：一句話 4（2 則掛路線、1 則掛列車——沒有列車就掛路線、1 則沒掛）
    put(2, 9, 20, { body: "例句要自己造才記得住，抄書的效果很有限", inbox: false, nodeId: routeId });
    put(9, 22, 10, { body: "複習的時候先遮住答案，想三秒再翻開", inbox: false, nodeId: routeId });
    put(17, 7, 45, { body: "這一段卡關的地方可以拆成兩小步，明天先做前半", inbox: false, nodeId: trainId ?? routeId });
    put(41, 20, 0, { body: "雨天的公車比平常晚十分鐘，早點出門", inbox: false });
    // 300 字條列整理（有標題）、1,000 字長文（有標題）
    put(26, 23, 15, { title: "讀書節奏的做法", body: LIST_300, inbox: false });
    put(88, 16, 30, { title: "河堤散步想到的幾件事", body: LONG_1000, inbox: false });
  }
}
