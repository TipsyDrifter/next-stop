/**
 * MemoryNoteRepository——NoteRepository 的記憶體實作（`?mock=1`；車次①契約 §3.5）。
 *
 * 語義對齊 `sqliteNoteRepository.ts`：排序（noted_at DESC, created_at DESC）、路線由 node_id 推導
 * （節點是路線＝它自己；其餘＝nodes.route_id）、node_missing（節點不在或已刪）、標題空字串存 null、
 * soft delete。資料進出一律複製（同 memoryRepository.ts），重新整理即重置。
 *
 * 種子：第一次任何方法被呼叫時 lazy 跑（要先問 nodeRepo 拿路線與列車 id）；`seed=false`
 * （`?wiped=1`，公約 §六）一顆都不種。內容**全部虛構**，不用主人的真實資料。
 *
 * 車次②：日記三支＝同義過濾；足跡不另種，用 NodeRepository 公開方法拼核心三表（memoryRepository 的示範資料
 * 已有已完成節點、定期券班次與 event=null 的手記），過濾語義走 domain 的 footprintSeals／footprintLogs。
 */
import { nowUtcIso, uuid } from "../lib/db";
import { dayKeyOf, dayWindow, toDateKey, todayKey } from "../lib/date";
import type { NodeRow, Occurrence, WorkLog } from "../domain";
import {
  footprintDayKeys,
  footprintLogs,
  footprintSeals,
  groupFootprints,
  matchesQuery,
  type FootprintDay,
  type NoteRow,
} from "../domain/notes";
import type { NodeRepository } from "./nodeRepository";
import type {
  CreateNoteInput,
  DiarySearchQuery,
  NoteListItem,
  NotePatch,
  NoteRepository,
  NotesQuery,
} from "./noteRepository";

const clone = <T extends object>(o: T): T => ({ ...o });

/** ORDER BY noted_at DESC, created_at DESC */
function byNotedDesc(a: NoteRow, b: NoteRow): number {
  return b.noted_at.localeCompare(a.noted_at) || b.created_at.localeCompare(a.created_at);
}

function normTitle(t: string | null | undefined): string | null {
  return t && t.trim() ? t : null;
}

/**
 * 種子的「今天」。資料層不依賴 store、種子時不知道主人的日界線設定 ⇒ 固定用 03:00 口徑；
 * 這是 mock 種子專用、車次②契約 §3.5 准許的唯一一處日界線字面值（正式路徑一律讀 uiStore.dayStartHour）。
 */
const seedToday = (): string => todayKey(3);

/** 本地日 key 往前 n 天、h:m 的 UTC ISO（種子用；固定偏移，重整不變） */
function isoDaysAgo(n: number, h: number, m: number): string {
  const [y, mo, d] = seedToday().split("-").map(Number);
  return new Date(y, mo - 1, d - n, h, m).toISOString();
}

/** 本地日 key 往前 n 天（日記種子的 entry_date） */
function keyDaysAgo(n: number): string {
  const [y, mo, d] = seedToday().split("-").map(Number);
  return toDateKey(new Date(y, mo - 1, d - n));
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
    if (patch.kind !== undefined) next.kind = patch.kind;
    if (patch.entry_date !== undefined) next.entry_date = patch.entry_date;
    const touched = (["title", "body", "noted_at", "node_id", "inbox", "kind", "entry_date"] as const).some(
      (k) => patch[k] !== undefined,
    );
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

  // ───────────── 車次②・日記（＝sqlite 版 §3.4 的同義過濾） ─────────────

  async listDiary(day: string): Promise<NoteListItem[]> {
    await this.ensureSeed();
    const rows = this.alive()
      .filter((n) => n.kind === "diary" && n.entry_date === day)
      .sort((a, b) => a.noted_at.localeCompare(b.noted_at) || a.created_at.localeCompare(b.created_at));
    return this.toItems(rows);
  }

  async searchDiary(q: DiarySearchQuery): Promise<NoteListItem[]> {
    await this.ensureSeed();
    const query = q.query.trim();
    if (!query) return [];
    const rows = this.alive()
      .filter((n) => n.kind === "diary" && matchesQuery(n, query))
      .sort((a, b) => (b.entry_date ?? "").localeCompare(a.entry_date ?? "") || b.noted_at.localeCompare(a.noted_at));
    const offset = q.offset ?? 0;
    return this.toItems(rows.slice(offset, offset + (q.limit ?? 100)));
  }

  async listDiaryMarks(from: string, to: string): Promise<Record<string, number>> {
    await this.ensureSeed();
    const out: Record<string, number> = {};
    for (const n of this.alive()) {
      if (n.kind !== "diary" || !n.entry_date || n.entry_date < from || n.entry_date > to) continue;
      out[n.entry_date] = (out[n.entry_date] ?? 0) + 1;
    }
    return out;
  }

  async listDiaryDays(from: string, to: string): Promise<string[]> {
    return Object.keys(await this.listDiaryMarks(from, to)).sort();
  }

  // ───────────── 車次②・當天足跡（用 NodeRepository 的公開方法拼，§3.5；0-3 甲） ─────────────
  // 過濾語義與 SQLite 版 §3.4 同一份：domain 的 footprintSeals／footprintLogs（單元測試鎖住）。
  // 已知近似：沒路線、沒 parent 的臨時票不在任何路線樹裡 ⇒ 它的済章與手記在 mock 足跡看不到（真機 SQL 看得到）。

  async listFootprints(day: string, dayStartHour: number): Promise<FootprintDay> {
    const w = dayWindow(day, dayStartHour);
    const src = await this.footprintSources();
    return groupFootprints(day, footprintSeals(w, src.nodes, src.occurrences), footprintLogs(w, src.logs, src.nodes), null);
  }

  async listFootprintDays(from: string, to: string, dayStartHour: number): Promise<string[]> {
    if (from > to) return [];
    const w = { start: dayWindow(from, dayStartHour).start, end: dayWindow(to, dayStartHour).end };
    const src = await this.footprintSources();
    const isos = [
      ...footprintSeals(w, src.nodes, src.occurrences).map((s) => s.at),
      ...footprintLogs(w, src.logs, src.nodes).map((l) => l.at),
    ];
    return footprintDayKeys(isos, (iso) => dayKeyOf(iso, dayStartHour));
  }

  /**
   * 核心三表的 mock 近似：側欄的幹線／路線／車站＋每條路線的整棵樹（存活節點）；
   * 班次逐節點 listOccurrences（不帶班次日區間——補済的班次 completed_at 可能不在 due_on 那天，交給 TS 以完成時刻篩）；
   * 手記逐節點 listWorkLogs。記憶體、N 次無妨。
   */
  private async footprintSources(): Promise<{ nodes: NodeRow[]; occurrences: Occurrence[]; logs: WorkLog[] }> {
    const side = await this.nodeRepo.listSidebar();
    const byId = new Map<string, NodeRow>();
    for (const n of [...side.lines, ...side.routes, ...side.stations]) byId.set(n.id, n);
    for (const r of side.routes) for (const n of await this.nodeRepo.listRouteTree(r.id)) byId.set(n.id, n);
    const nodes = [...byId.values()];
    const occurrences: Occurrence[] = [];
    const logs: WorkLog[] = [];
    for (const n of nodes) {
      if (n.kind === "train" || n.kind === "car" || n.kind === "ticket") {
        occurrences.push(...(await this.nodeRepo.listOccurrences(n.id)));
      }
      logs.push(...(await this.nodeRepo.listWorkLogs(n.id)));
    }
    return { nodes, occurrences, logs };
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
    // 與 sqlite 版同：日記必填 entryDate（缺 ⇒ RangeError），筆記恆 NULL
    if (input.kind === "diary" && !input.entryDate) throw new RangeError("日記要有日期");
    const row: NoteRow = {
      id: uuid(),
      kind: input.kind,
      title: normTitle(input.title),
      body: input.body,
      entry_date: input.kind === "diary" ? (input.entryDate ?? null) : null,
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

  /** 收件匣 4 則＋筆記 6 則（車次① §3.5）＋日記 6 篇（車次② §3.5）；noted_at 分佈在最近 100 天內（固定偏移） */
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

    // 日記 6 篇（車次② §3.5）：散在最近五週；一天兩篇（4 天前）；一篇補記（16 天前的日記、13 天後才寫）；
    // 今天沒有日記（看「今天還沒有寫日記」空狀態）。時刻都在白天到深夜之間，03:00／06:00 兩種日界線都不會誤判成補記。
    const diary = (entryDaysAgo: number, notedDaysAgo: number, h: number, m: number, body: string, title?: string) => {
      const at = isoDaysAgo(notedDaysAgo, h, m);
      this.insert({ kind: "diary", body, title: title ?? null, inbox: false, notedAt: at, entryDate: keyDaysAgo(entryDaysAgo) }, at, at);
    };
    diary(1, 1, 22, 10, "下午下了一陣大雨，躲在圖書館把上週的筆記整理完。\n回家路上雨停了，空氣很乾淨。");
    diary(4, 4, 8, 40, "早上提早半小時起床，先把今天要做的三件事寫下來再出門。");
    diary(
      4,
      4,
      21,
      15,
      "晚上和社團的人吃飯，聊到下學期想辦的讀書會。\n\n大家都說好，但沒人想當召集人。我說我可以先整理一份書單。",
      "讀書會的雛形",
    );
    diary(9, 9, 23, 5, "今天什麼都沒做成，只把房間打掃了一遍。\n算了，乾淨的房間也是一種進度。");
    diary(16, 13, 20, 30, "那天第一次自己煮了一鍋咖哩，份量抓太多，吃了三天。");
    diary(
      30,
      30,
      21,
      0,
      "跑完今年第一次五公里，比想像中輕鬆。\n\n下次試試看不停下來走路。",
      "第一次五公里",
    );
  }
}
