/**
 * 方針擴充——store 層（辛；契約 2026-11-04 §7）：weekAimStore 接記憶體版 repository，驗期間鍵的載入、重載、收合、回顧的本地鍵。
 * 跑法：`node --test scripts/tests/week-aims-store.test.ts`（node 24，型別剝除；零依賴）。
 * `../data`、`../data/weekAimRepository`、`./nodeStore`、`./uiStore` 換替身（載入法同 `tag-repo-create.test.ts`）；純函式與記憶體版是真的。
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const FAKES: Record<string, string> = {
  "../data": `
    export const nodeRepo = { getNode: (id) => globalThis.__aimsNodeRepo.getNode(id) };
    export const settingsRepo = {
      get: async (k) => globalThis.__aimsKv.get(k) ?? null,
      set: async (k, v) => void globalThis.__aimsKv.set(k, v),
    };`,
  "../data/weekAimRepository": `
    export const weekAimRepo = new Proxy({}, { get: (_, k) => { const r = globalThis.__aimsRepo; const v = r[k]; return typeof v === "function" ? v.bind(r) : v; } });`,
  "./nodeStore": `
    export const useNodeStore = { getState: () => globalThis.__aimsNodeState };`,
  "./uiStore": `
    export const useUiStore = { getState: () => ({ dayStartHour: 6, showToast: (t) => globalThis.__aimsToasts.push(t.message) }) };`,
};
const dataUrl = (src: string) => "data:text/javascript," + encodeURIComponent(src);
registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL;
    if (parent !== undefined && parent.includes("/src/")) {
      if (parent.includes("/src/store/weekAimStore") && FAKES[specifier]) return { url: dataUrl(FAKES[specifier]), shortCircuit: true };
      if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) return nextResolve(specifier + ".ts", context);
    }
    return nextResolve(specifier, context);
  },
});

const { MemoryWeekAimRepository } = await import("../../src/data/memoryWeekAimRepository.ts");
const { planSaveWeek } = await import("../../src/domain/weekAims.ts");
const { aimRangeOf, useWeekAimStore } = await import("../../src/store/weekAimStore.ts");

const base = { line_id: null, description: null, position: 0, sort_key: null, color: null, code: null, priority: "mid", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", deleted_at: null };
const route = { ...base, id: "R1", kind: "route", name: "R1", parent_id: null, route_id: null, status: "todo", scheduled_on: null, completed_at: null, repeat_rule: null, arrived_on: null, expected_on: null };
const ticket = (id: string, day: string) => ({ ...route, id, kind: "ticket", name: id, parent_id: null, route_id: "R1", scheduled_on: day });
const TICKETS = [ticket("K1", "2026-11-10"), ticket("K2", "2026-10-10"), ticket("K3", "2026-07-10"), ticket("K4", "2025-07-10")];
const station = (id: string, position: number, arrived_on: string | null, expected_on: string | null) => ({ ...route, id, kind: "station", name: id, parent_id: "R1", route_id: null, position, arrived_on, expected_on });

const g = globalThis as Record<string, unknown>;
const toasts = () => g.__aimsToasts as string[];
const kv = () => g.__aimsKv as Map<string, string>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let repo: any;

beforeEach(() => {
  const nodeRepo = {
    async listSidebar() {
      return { lines: [], routes: [route], stations: [] };
    },
    async listRouteTree() {
      return TICKETS;
    },
    async getNode() {
      return null;
    },
    async listOccurrences() {
      return [];
    },
  };
  repo = new MemoryWeekAimRepository({ nodeRepo: nodeRepo as never, seedDemo: false });
  g.__aimsRepo = repo;
  g.__aimsNodeRepo = nodeRepo;
  g.__aimsKv = new Map<string, string>();
  g.__aimsToasts = [];
  // 車站：a 到站 10/1 → b 預定 12/6 → c 沒日子（故意亂序放，aimRangeOf 要自己照兄弟順序排）
  g.__aimsNodeState = {
    routes: [route],
    stations: [station("c", 2, null, null), station("a", 0, "2026-10-01", null), station("b", 1, null, "2026-12-06")],
  };
  useWeekAimStore.setState(useWeekAimStore.getInitialState(), true);
});

const draft = (text: string, nodeId: string | null = null) => ({ id: null, text, nodeId, carriedFrom: null });
const save = (key: string, ...texts: (string | [string, string])[]) =>
  repo.saveWeek(key, planSaveWeek([], texts.map((t) => (Array.isArray(t) ? draft(t[0], t[1]) : draft(t))), key));
const texts = (key: string) => (useWeekAimStore.getState().weeks[key] ?? []).map((a) => a.text);

describe("掛的支線與今日切換", () => {
  const branch = (id: string, name: string, deleted_at: string | null = null, updated_at = base.updated_at) => ({ ...route, id, kind: "branch", name, parent_id: "R1", route_id: "R1", deleted_at, updated_at });

  test("refreshAimNodes（全集 #15）：改名即時更新；刪掉的拿掉（標籤消失）；讀失敗的留著舊名", async () => {
    const st = useWeekAimStore.getState();
    st.rememberAimNodes([branch("B1", "舊名"), branch("B2", "會刪"), branch("B3", "讀失敗"), branch("B4", "查無此列")] as never);
    const db: Record<string, unknown> = {
      B1: branch("B1", "新名", null, "2026-11-04T00:00:00.000Z"),
      B2: branch("B2", "會刪", "2026-11-04T00:00:00.000Z"),
      B4: null,
    };
    (g.__aimsNodeRepo as { getNode(id: string): Promise<unknown> }).getNode = async (id) => {
      if (id === "B3") throw new Error("讀不到");
      return db[id];
    };
    await st.refreshAimNodes();
    const nodes = useWeekAimStore.getState().aimNodes;
    assert.equal(nodes.B1?.name, "新名");
    assert.equal(nodes.B2, undefined);
    assert.equal(nodes.B3?.name, "讀失敗");
    assert.equal(nodes.B4, undefined);
  });

  test("refreshAimNodes：沒記支線就不讀", async () => {
    let reads = 0;
    (g.__aimsNodeRepo as { getNode(id: string): Promise<unknown> }).getNode = async () => {
      reads++;
      return null;
    };
    await useWeekAimStore.getState().refreshAimNodes();
    assert.equal(reads, 0);
  });

  test("todayPick（D-主-377）：預設本週、切了留在記憶體、不寫設定", () => {
    const st = useWeekAimStore.getState();
    assert.equal(st.todayPick, "week");
    st.setTodayPick("month");
    assert.equal(useWeekAimStore.getState().todayPick, "month");
    assert.equal(kv().size, 0);
  });
});

describe("載入", () => {
  test("loadWeek：週、月、年連上一期一起載；車站只載自己", async () => {
    await save("2026-10-26", "上週");
    await save("2026-11-02", "這週");
    await save("M2026-10", "上月");
    await save("M2026-11", "本月");
    await save("Y2025", "去年");
    await save("Y2026", "今年");
    await save("Sa", "A 站");
    const st = useWeekAimStore.getState();
    await st.loadWeek("2026-11-02");
    assert.deepEqual(texts("2026-11-02"), ["這週"]);
    assert.deepEqual(texts("2026-10-26"), ["上週"]);
    await st.loadWeek("M2026-11");
    assert.deepEqual(texts("M2026-11"), ["本月"]);
    assert.deepEqual(texts("M2026-10"), ["上月"]);
    await st.loadWeek("Y2026");
    assert.deepEqual(texts("Y2026"), ["今年"]);
    assert.deepEqual(texts("Y2025"), ["去年"]);
    await st.loadWeek("Sa");
    assert.deepEqual(texts("Sa"), ["A 站"]);
    assert.deepEqual(Object.keys(useWeekAimStore.getState().weeks).filter((k) => k.startsWith("S")), ["Sa"]);
  });

  test("跨年：一月的上一期是去年十二月", async () => {
    await save("M2026-12", "十二月");
    await useWeekAimStore.getState().loadWeek("M2027-01");
    assert.deepEqual(texts("M2026-12"), ["十二月"]);
    assert.deepEqual(texts("M2027-01"), []);
  });

  test("loadKeys：整批載、不算已排；週的鍵照區間口徑", async () => {
    await save("Sa", ["A 站", "R1"]);
    await save("Sb", "B 站");
    await repo.saveWeek("2026-10-27", planSaveWeek([], [draft("週二寫的舊列")]));
    await useWeekAimStore.getState().loadKeys(["Sa", "Sb", "Sz", "2026-10-26"]);
    assert.deepEqual(texts("Sa"), ["A 站"]);
    assert.deepEqual(texts("Sb"), ["B 站"]);
    assert.deepEqual(texts("Sz"), []);
    assert.deepEqual(texts("2026-10-26"), ["週二寫的舊列"]);
    assert.deepEqual(useWeekAimStore.getState().planned, {});
  });

  test("已排：月、年、車站照各自的範圍；車站沒掛的句子看這條路線", async () => {
    await save("M2026-11", ["本月", "R1"]);
    await save("Y2026", ["今年", "R1"]);
    await save("Sb", "B 站，沒掛");
    const st = useWeekAimStore.getState();
    await st.loadWeek("M2026-11");
    await st.loadWeek("Y2026");
    await st.loadWeek("Sb");
    const planned = useWeekAimStore.getState().planned;
    assert.equal(planned["M2026-11"].R1.planned, 1, "K1");
    assert.equal(planned["Y2026"].R1.planned, 3, "K1、K2、K3");
    assert.equal(planned["Sb"].R1.planned, 2, "A 站到站 10/1 ～ B 站預定 12/6：K1、K2");
  });

  test("aimRangeOf：週、月、年照鍵；車站照兄弟順序算；站不在了＝null", () => {
    assert.deepEqual(aimRangeOf("M2026-11"), { from: "2026-11-01", to: "2026-11-30" });
    assert.deepEqual(aimRangeOf("Sa"), { from: "0000-01-01", to: "2026-10-01" });
    assert.deepEqual(aimRangeOf("Sb"), { from: "2026-10-01", to: "9999-12-31" });
    assert.deepEqual(aimRangeOf("Sc"), { from: "2026-10-01", to: "9999-12-31" });
    assert.equal(aimRangeOf("Sgone"), null);
  });

  test("站不在了：已排是空的、不丟錯", async () => {
    await save("Sgone", "藏起來的句子");
    await useWeekAimStore.getState().loadWeek("Sgone");
    assert.deepEqual(useWeekAimStore.getState().planned.Sgone, {});
  });
});

describe("reloadAll", () => {
  test("照期間分別讀，載過的週、月、年、站都換成最新", async () => {
    const st = useWeekAimStore.getState();
    await st.loadWeek("2026-11-02");
    await st.loadWeek("M2026-11");
    await st.loadWeek("Y2026");
    await st.loadWeek("Sa");
    // 同步拉到新資料
    await save("2026-11-02", "週新句");
    await save("M2026-11", ["月新句", "R1"]);
    await save("Y2026", "年新句");
    await save("Sa", "站新句");
    await save("Sb", "沒載過的站");
    await st.reloadAll();
    assert.deepEqual(texts("2026-11-02"), ["週新句"]);
    assert.deepEqual(texts("M2026-11"), ["月新句"]);
    assert.deepEqual(texts("Y2026"), ["年新句"]);
    assert.deepEqual(texts("Sa"), ["站新句"]);
    assert.equal(useWeekAimStore.getState().weeks.Sb, undefined);
    assert.equal(useWeekAimStore.getState().planned["M2026-11"].R1.planned, 1);
  });

  test("只載過月：不會把 M 鍵丟進週的區間算術", async () => {
    const st = useWeekAimStore.getState();
    await st.loadWeek("M2026-11");
    await save("M2026-11", "月新句");
    await st.reloadAll();
    assert.deepEqual(texts("M2026-11"), ["月新句"]);
  });

  test("回顧開著：一起重算", async () => {
    const st = useWeekAimStore.getState();
    await save("M2026-10", ["上月", "R1"]);
    await st.openReview("M2026-10");
    const before = useWeekAimStore.getState().review;
    assert.equal(before?.weekOn, "M2026-10");
    assert.ok(before?.result);
    await st.reloadAll();
    assert.equal(useWeekAimStore.getState().review?.weekOn, "M2026-10");
  });
});

describe("寫入與本地鍵", () => {
  test("saveWeek：寫進那一期；第六句 toast 的字隨期間", async () => {
    const st = useWeekAimStore.getState();
    assert.equal(await st.saveWeek("M2026-11", [draft("本月")]), true);
    assert.deepEqual(texts("M2026-11"), ["本月"]);
    assert.equal((await repo.listRange("M2026-11", "M2026-11"))[0].week_on, "M2026-11");
    const six = ["一", "二", "三", "四", "五", "六"].map((t) => draft(t));
    assert.equal(await st.saveWeek("Y2026", six), false);
    assert.deepEqual(toasts(), ["一年最多 5 句"]);
    assert.equal(await st.saveWeek("Sa", six), false);
    assert.deepEqual(toasts(), ["一年最多 5 句", "一站最多 5 句"]);
  });

  test("carryDraft：目標期間鍵進決定性 id", async () => {
    await save("M2026-11", ["本月", "R1"]);
    const [src] = (await repo.listRange("M2026-11", "M2026-11")) as { id: string; node_id: string }[];
    const st = useWeekAimStore.getState();
    const d = await st.carryDraft(src as never, "M2026-12");
    assert.equal(d.carriedFrom, src.id);
    assert.equal(d.nodeId, "R1");
    assert.notEqual(d.id, (await st.carryDraft(src as never, "M2027-01")).id);
  });

  test("toggleDone：蓋月方針後那一期跟著重載", async () => {
    await save("M2026-11", "本月");
    const st = useWeekAimStore.getState();
    await st.loadWeek("M2026-11");
    await st.toggleDone(useWeekAimStore.getState().weeks["M2026-11"][0]);
    assert.notEqual(useWeekAimStore.getState().weeks["M2026-11"][0].done_at, null);
  });

  test("setFolded／loadSettings：各期間各記各的鍵；週沿用舊鍵", async () => {
    const st = useWeekAimStore.getState();
    await st.setFolded("2026-11-02", true);
    await st.setFolded("M2026-11", false);
    await st.setFolded("Y2026", true);
    await st.setFolded("Sa", true);
    assert.deepEqual(useWeekAimStore.getState().foldRaw, { week: "2026-11-02:1", month: "M2026-11:0", year: "Y2026:1", station: "Sa:1" });
    assert.equal(kv().get("week_aims_fold"), "2026-11-02:1");
    assert.equal(kv().get("aims_fold_month"), "M2026-11:0");
    assert.equal(kv().get("aims_fold_year"), "Y2026:1");
    assert.equal(kv().get("aims_fold_station"), "Sa:1");
    useWeekAimStore.setState(useWeekAimStore.getInitialState(), true);
    kv().set("week_aims_review_seen", "2026-10-26");
    kv().set("aims_review_seen_month", "M2026-10");
    await useWeekAimStore.getState().loadSettings();
    const after = useWeekAimStore.getState();
    assert.deepEqual(after.foldRaw, { week: "2026-11-02:1", month: "M2026-11:0", year: "Y2026:1", station: "Sa:1" });
    assert.deepEqual(after.reviewSeen, { week: "2026-10-26", month: "M2026-10", year: null });
  });

  test("回顧：關掉＝看過，各期間各記；不倒退；車站不記", async () => {
    const st = useWeekAimStore.getState();
    await st.openReview("M2026-10");
    await st.closeReview();
    assert.equal(useWeekAimStore.getState().review, null);
    assert.deepEqual(useWeekAimStore.getState().reviewSeen, { week: null, month: "M2026-10", year: null });
    assert.equal(kv().get("aims_review_seen_month"), "M2026-10");
    await st.openReview("M2026-08");
    await st.closeReview();
    assert.equal(useWeekAimStore.getState().reviewSeen.month, "M2026-10", "回頭看更早的不倒退");
    await st.openReview("2026-10-26");
    await st.closeReview();
    assert.equal(kv().get("week_aims_review_seen"), "2026-10-26");
    await st.openReview("Y2025");
    await st.closeReview();
    assert.equal(kv().get("aims_review_seen_year"), "Y2025");
    const size = kv().size;
    await st.openReview("Sa");
    await st.closeReview();
    assert.equal(kv().size, size);
  });

  test("回顧的範圍：車站走 stationWindow；沒掛的句子有路線的數字；站不在了＝空數字不丟錯", async () => {
    await save("Sb", "B 站，沒掛");
    const st = useWeekAimStore.getState();
    await st.openReview("Sb");
    assert.ok(useWeekAimStore.getState().review?.result?.stats.R1, "路線的數字有算");
    await st.closeReview();
    await st.openReview("Sgone");
    assert.deepEqual(useWeekAimStore.getState().review?.result, { stats: {}, money: null });
  });
});

describe("框開著時同步進來（saveWeek 帶 base）", () => {
  const KEY = "M2026-11";
  const alive = async () => (await repo.listRange(KEY, KEY)).filter((r: { deleted_at: string | null }) => r.deleted_at === null);
  const draftsOf = (rows: { id: string; text: string; node_id: string | null; carried_from: string | null }[]) =>
    rows.map((r) => ({ id: r.id, text: r.text, nodeId: r.node_id, carriedFrom: r.carried_from }));

  test("別處刪了 X：存檔不復活、toast 說", async () => {
    await save(KEY, "X", "A");
    const [x] = await alive();
    const base = draftsOf(await alive());
    await repo.deleteAim(x.id);
    const st = useWeekAimStore.getState();
    assert.equal(await st.saveWeek(KEY, base, base), true);
    assert.deepEqual(texts(KEY), ["A"]);
    assert.notEqual((await repo.getAim(x.id, { withDeleted: true })).deleted_at, null, "X 還是刪掉的");
    assert.deepEqual(toasts(), ["「X」在別處刪掉了，沒有存回去"]);
  });

  test("別處新寫 Y：存檔不刪、接在草稿後面、toast 說", async () => {
    await save(KEY, "A");
    const base = draftsOf(await alive());
    await repo.saveWeek(KEY, planSaveWeek(await alive(), [...base, draft("Y")], KEY));
    const st = useWeekAimStore.getState();
    assert.equal(await st.saveWeek(KEY, [...base, draft("這邊新寫的")], base), true);
    assert.deepEqual(texts(KEY), ["A", "這邊新寫的", "Y"]);
    assert.deepEqual(toasts(), ["「Y」是別處新寫的，也留著"]);
  });

  test("別處蓋了済：這邊存檔不動済的時刻", async () => {
    await save(KEY, "A");
    const [a] = await alive();
    const base = draftsOf([a]);
    await repo.setDone(a.id, "2026-11-04T00:00:00.000Z");
    assert.equal(await useWeekAimStore.getState().saveWeek(KEY, [{ ...base[0], text: "A 改字" }], base), true);
    assert.equal((await repo.getAim(a.id)).done_at, "2026-11-04T00:00:00.000Z");
    assert.equal((await repo.getAim(a.id)).text, "A 改字");
  });

  test("五句上限不因別處的句子擋存檔：合起來七句照存", async () => {
    await save(KEY, "A", "B", "C");
    const base = draftsOf(await alive());
    await repo.saveWeek(KEY, planSaveWeek(await alive(), [...base, draft("Y"), draft("Z")], KEY));
    const st = useWeekAimStore.getState();
    assert.equal(await st.saveWeek(KEY, [...base, draft("丁"), draft("戊")], base), true);
    assert.deepEqual(texts(KEY), ["A", "B", "C", "丁", "戊", "Y", "Z"]);
  });

  test("帶過來的列已被別處刪掉（不在 base）：照 D-主-252 復活，不提示", async () => {
    await save("M2026-10", "上月那句");
    const [src] = await repo.listRange("M2026-10", "M2026-10");
    const st = useWeekAimStore.getState();
    const carried = await st.carryDraft(src, KEY);
    await repo.saveWeek(KEY, planSaveWeek([], [carried], KEY));
    await repo.deleteAim(carried.id);
    assert.equal(await st.saveWeek(KEY, [carried], []), true);
    assert.deepEqual(texts(KEY), ["上月那句"]);
    assert.deepEqual(toasts(), []);
  });

  test("不帶 base：舊呼叫行為不變", async () => {
    await save(KEY, "A");
    const [a] = await alive();
    await repo.deleteAim(a.id);
    assert.equal(await useWeekAimStore.getState().saveWeek(KEY, draftsOf([a])), true);
    assert.deepEqual(texts(KEY), ["A"], "沒給 base 分不出是誰刪的，照舊走 create");
  });
});

describe("reloadAll 等待期間", () => {
  const deferred = () => {
    let open = () => {};
    const gate = new Promise<void>((r) => (open = r));
    return { gate, open };
  };

  test("別的畫面載好的鍵不被丟掉：告示不會卡在 loading", async () => {
    const st = useWeekAimStore.getState();
    await st.loadWeek("M2026-11");
    await save("Y2026", "今年");
    const { gate, open } = deferred();
    const listKeys = repo.listKeys.bind(repo);
    repo.listKeys = async (keys: string[]) => {
      const rows = await listKeys(keys);
      await gate;
      return rows;
    };
    const reload = st.reloadAll();
    await st.loadWeek("Y2026"); // 走 listRange，不等閘門
    assert.deepEqual(texts("Y2026"), ["今年"]);
    open();
    await reload;
    assert.deepEqual(texts("Y2026"), ["今年"], "重載完還在");
    assert.ok(useWeekAimStore.getState().planned.Y2026, "已排也還在");
  });

  test("被刪光的那一期不殘留舊句子", async () => {
    await save("M2026-11", "會被刪光");
    await save("2026-11-02", "週也刪光");
    const st = useWeekAimStore.getState();
    await st.loadWeek("M2026-11");
    await st.loadWeek("2026-11-02");
    for (const k of ["M2026-11", "2026-11-02"]) for (const r of await repo.listRange(k, k)) await repo.deleteAim(r.id);
    await st.reloadAll();
    assert.deepEqual(useWeekAimStore.getState().weeks["M2026-11"], []);
    assert.deepEqual(useWeekAimStore.getState().weeks["2026-11-02"], []);
  });
});

describe("關回顧", () => {
  test("review 清掉與 reviewSeen 記下是同一次 set：回顧排隊不會在中間看到「關了但還沒看過」又把同一張打開", async () => {
    const st = useWeekAimStore.getState();
    await st.openReview("M2026-10");
    const seenAtClose: (string | null)[] = [];
    const off = useWeekAimStore.subscribe((s) => {
      if (s.review === null) seenAtClose.push(s.reviewSeen.month);
    });
    await st.closeReview();
    off();
    assert.ok(seenAtClose.length > 0);
    assert.ok(seenAtClose.every((v) => v === "M2026-10"), JSON.stringify(seenAtClose));
  });
});
