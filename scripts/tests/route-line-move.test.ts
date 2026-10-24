/**
 * UI 丙-3 C2（E12）：側板「所屬幹線」——路線搬到另一條幹線、子樹的 line_id 跟著改、復原回原幹線原位置。
 * 走 src/ui/panel/routeLine.ts 的純邏輯＋記憶體 repository（不經 store、不碰 sqlite）。
 * 跑法：`node --test scripts/tests/route-line-move.test.ts`。載入替身照 move-root-line.test.ts。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const FAKE_DB = `
let t = Date.now();
export function getDb() { throw new Error("測試不碰 sqlite"); }
export function uuid() { return crypto.randomUUID(); }
export function nowUtcIso() { t += 1000; return new Date(t).toISOString(); }
`;
const dataUrl = (src: string) => "data:text/javascript," + encodeURIComponent(src);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const fromSrc = context.parentURL !== undefined && context.parentURL.includes("/src/");
    if (fromSrc) {
      if (specifier === "../lib/db") return { url: dataUrl(FAKE_DB), shortCircuit: true };
      if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
        try {
          return nextResolve(specifier + ".ts", context);
        } catch {
          return nextResolve(specifier + "/index.ts", context);
        }
      }
    }
    return nextResolve(specifier, context);
  },
});

const { MemoryNodeRepository } = await import("../../src/data/memoryRepository.ts");
const { planRouteMove, runRouteMove } = await import("../../src/ui/panel/routeLine.ts");

type Repo = InstanceType<typeof MemoryNodeRepository>;

/** 兩條幹線：學習（日文、英文）、生活（健身）；日文底下有列車→車廂→車票、一個車站 */
async function seed() {
  const repo: Repo = new MemoryNodeRepository();
  const study = await repo.create({ kind: "line", name: "學習", parentId: null });
  const life = await repo.create({ kind: "line", name: "生活", parentId: null });
  const ja = await repo.create({ kind: "route", name: "日文", parentId: study.id });
  const en = await repo.create({ kind: "route", name: "英文", parentId: study.id });
  const gym = await repo.create({ kind: "route", name: "健身", parentId: life.id });
  const train = await repo.create({ kind: "train", name: "文法", parentId: ja.id });
  const car = await repo.create({ kind: "car", name: "第一課", parentId: train.id });
  const ticket = await repo.create({ kind: "ticket", name: "背單字", parentId: car.id });
  const station = await repo.create({ kind: "station", name: "N3", parentId: ja.id });
  return { repo, study, life, ja, en, gym, train, car, ticket, station };
}

/** 埠：路線清單每次現讀 repository（＝store refresh 之後的 routes） */
async function portsOf(repo: Repo) {
  let routes = (await repo.listSidebar()).routes;
  return {
    routes: () => routes,
    async move(id: string, parentId: string, index: number) {
      try {
        await repo.move(id, parentId, index);
        routes = (await repo.listSidebar()).routes;
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: String(e) };
      }
    },
  };
}

test("路線搬到另一條幹線：接在新幹線最後、整棵子樹的 line_id 跟著改", async () => {
  const s = await seed();
  const ports = await portsOf(s.repo);
  const r = await runRouteMove(ports, s.ja.id, s.life.id);
  assert.equal(r.ok, true);
  assert.ok(r.undo, "搬成功要帶復原");

  const moved = await s.repo.getNode(s.ja.id);
  assert.equal(moved?.parent_id, s.life.id);
  assert.equal(moved?.line_id, s.life.id);
  assert.equal(moved?.position, (await s.repo.getNode(s.gym.id))!.position + 1, "接在健身之後");
  for (const n of [s.train, s.car, s.ticket, s.station]) {
    const row = await s.repo.getNode(n.id);
    assert.equal(row?.line_id, s.life.id, `${n.name} 的 line_id 跟著換幹線`);
    assert.equal(row?.route_id, s.ja.id, `${n.name} 的 route_id 不變`);
  }
  // 沒搬的路線不受影響
  assert.equal((await s.repo.getNode(s.en.id))?.line_id, s.study.id);
});

test("復原：回到原幹線、原位置，兄弟順序不變、子樹 line_id 回來", async () => {
  const s = await seed();
  const ports = await portsOf(s.repo);
  const before = (await s.repo.listSidebar()).routes.filter((r) => r.line_id === s.study.id).map((r) => r.id);
  const r = await runRouteMove(ports, s.ja.id, s.life.id);
  const back = await r.undo!();
  assert.equal(back.ok, true);

  const row = await s.repo.getNode(s.ja.id);
  assert.equal(row?.parent_id, s.study.id);
  assert.equal(row?.line_id, s.study.id);
  const after = (await s.repo.listSidebar()).routes
    .filter((x) => x.line_id === s.study.id)
    .sort((a, b) => a.position - b.position)
    .map((x) => x.id);
  assert.deepEqual(after, before, "日文回到英文前面");
  for (const n of [s.train, s.car, s.ticket, s.station]) {
    assert.equal((await s.repo.getNode(n.id))?.line_id, s.study.id);
  }
});

test("挑原本那條幹線＝不搬；找不到路線＝擋下", async () => {
  const s = await seed();
  const routes = (await s.repo.listSidebar()).routes;
  assert.deepEqual(planRouteMove(s.ja.id, s.study.id, routes), { kind: "same" });
  assert.deepEqual(planRouteMove("nope", s.life.id, routes), { kind: "missing" });

  const ports = await portsOf(s.repo);
  const same = await runRouteMove(ports, s.ja.id, s.study.id);
  assert.equal(same.ok, true);
  assert.equal(same.same, true);
  assert.equal(same.undo, undefined);
  assert.equal((await s.repo.getNode(s.ja.id))?.parent_id, s.study.id);
});

test("搬到空的幹線：落點是 0", async () => {
  const s = await seed();
  const empty = await s.repo.create({ kind: "line", name: "旅行", parentId: null });
  const routes = (await s.repo.listSidebar()).routes;
  const plan = planRouteMove(s.en.id, empty.id, routes);
  assert.equal(plan.kind, "move");
  assert.equal(plan.kind === "move" && plan.index, 0);
});

test("根層臨時車票掛這條路線標籤：line_id 快取跟著新幹線、復原回原幹線、不動 updated_at", async () => {
  const s = await seed();
  const loose = await s.repo.create({ kind: "ticket", name: "臨時：買字典", parentId: null });
  await s.repo.setRouteTag(loose.id, s.ja.id);
  const tagged = await s.repo.getNode(loose.id);
  assert.equal(tagged?.line_id, s.study.id, "前提：標籤路線的幹線");
  const stamp = tagged?.updated_at;

  const ports = await portsOf(s.repo);
  const r = await runRouteMove(ports, s.ja.id, s.life.id);
  assert.equal(r.ok, true);
  const after = await s.repo.getNode(loose.id);
  assert.equal(after?.line_id, s.life.id, "本機立刻跟上，不用等下一次同步拉取");
  assert.equal(after?.route_id, s.ja.id, "路線標籤是資料，不變");
  assert.equal(after?.updated_at, stamp, "快取重算不是內容修改，不碰 updated_at");

  await r.undo!();
  assert.equal((await s.repo.getNode(loose.id))?.line_id, s.study.id);
});
