/**
 * MobileCatDrill——手機的分類格子：一層一層點進去（售票口④ 第二輪 D-票-78；手機席；原型 prototypes/design-structure-分類多層.html
 * 「A 手機・第一層／第二層」）。記一筆與改一筆、定期帳表單、預算「加分類預算」、篩選 sheet 共用這一份。
 *
 * 頂層＝平常的格子（四欄；篩選 sheet 三欄由 CSS 換）。有下一層的格子小字「N 個 ›」，點了＝走進去；沒有下一層的點了＝選。
 * 走進去之後整塊框成虛線卡 `.ns-tk-mdrill`：頂端麵包屑「‹ 支出 › 食物 › 外食」（‹＝回上一層，點哪一段回到那一層）、
 *   那一層的格子、最下面「選這一層「外食」」（記在這個分類本身；篩選＝選它含底下全部）。
 * 每一層最後一格由呼叫端給（`tail`：記一筆的「＋ 新增…」，建在所在的那一層底下）。
 *
 * 現在在哪一層由呼叫端持有（`level`／`onLevel`）：常用格、備註帶分類、改一筆一打開，要能把格子帶到選中的那一層。
 * 返回鍵退一層：只在**主人自己點進去**之後登記（`backId`，kind 由呼叫端給——疊在全螢幕表單上 "full"、篩選 sheet "sheet"、
 *   預算挑選 sheet "dialog"）；被帶到某一層（打開改一筆、點常用）時返回鍵照舊是那張表單／sheet 的取消，不必先一層一層退出來。
 *
 * 選中態：
 *   單選（預設）：選中的格子亮；選在某格底下 ⇒ 那條路上的格子也亮（看得出選在哪一支）。
 *   多選（`multi`，篩選）：只有選中的亮；底下有選的寫「已選 N 個 ›」；上層選了 ⇒ 底下的格子寫「已含」（選一個＝含子孫）。
 *   `taken`（預算已設）：那格不能選、寫「已設」；有下一層的照樣進得去（底下的還能設）。
 * 封存的分類（連同底下整棵）不列（`categoryForest` includeArchived false）；那一層不在了（封存、同步刪掉、換了收支）＝回頂層。
 * 樣式在 ticket-4b-mobile.css（`.ns-tk-mdrill`／`.ns-tk-mcrumb`／`.ns-tk-mthis`；格子本身沿用 `.ns-tk-mgrid`／`.ns-tk-mcell`）。
 */
import { useMemo, useState, type ReactNode } from "react";
import { useTicketStore } from "../../../store/ticketStore";
import { useBackLayer, type BackKind } from "../../mobile/backStack";
import {
  UNCAT_EXPENSE_ID,
  UNCAT_INCOME_ID,
  bareName,
  categoryArchivedUp,
  categoryForest,
  categoryPath,
  flattenForest,
  type CategoryKind,
  type CategoryNode,
  type CategoryRow,
} from "../../../domain/ticket";
import { IconLeft } from "./mobileBits";

export interface MobileCatDrillProps {
  kind: CategoryKind;
  /** 現在在哪一層（那一層分類的 id；null＝頂層） */
  level: string | null;
  onLevel(id: string | null): void;
  /** 選中的（單選＝0 或 1 個） */
  picked: readonly string[];
  /** 點了沒有下一層的格子、或「選這一層」 */
  onPick(c: CategoryRow): void;
  multi?: boolean;
  /** 不能選的（預算已設） */
  taken?: ReadonlySet<string>;
  /** 不列「未分類」（預算、篩選以外的用不到它時） */
  hideUncat?: boolean;
  /** 每一層最後一格（拿到所在那一層） */
  tail?(level: string | null): ReactNode;
  /** 麵包屑第一段（「支出」「收入」） */
  rootLabel: string;
  backId: string;
  backKind: BackKind;
}

const isUncat = (id: string) => id === UNCAT_EXPENSE_ID || id === UNCAT_INCOME_ID;

/** 某分類「實際的上一層」在樹上的 id（頂層 ⇒ null） */
export function catParentId(cat: CategoryRow, catById: Readonly<Record<string, CategoryRow>>): string | null {
  const path = categoryPath(cat, catById);
  return path.length > 1 ? path[path.length - 2].id : null;
}

/** 選了 `id` 之後格子該停在哪一層：它的上一層（頂層的 ⇒ null；不在了 ⇒ null） */
export function levelFor(id: string | null, catById: Readonly<Record<string, CategoryRow>>): string | null {
  const c = id ? catById[id] : undefined;
  return c ? catParentId(c, catById) : null;
}

export function MobileCatDrill({
  kind,
  level,
  onLevel,
  picked,
  onPick,
  multi = false,
  taken,
  hideUncat = false,
  tail,
  rootLabel,
  backId,
  backKind,
}: MobileCatDrillProps) {
  const categories = useTicketStore((s) => s.categories);
  const catById = useTicketStore((s) => s.catById);
  const forest = useMemo(() => categoryForest(categories, kind, { includeArchived: false }), [categories, kind]);
  const nodeById = useMemo(() => {
    const m: Record<string, CategoryNode> = {};
    for (const n of flattenForest(forest)) m[n.cat.id] = n;
    return m;
  }, [forest]);

  const here = level ? (nodeById[level] ?? null) : null;
  const trail = here ? categoryPath(here.cat, catById).filter((c) => nodeById[c.id]) : [];
  const upId = trail.length > 1 ? trail[trail.length - 2].id : null;

  // 主人自己點進去的才登記返回層（檔頭）；回到頂層就放掉
  const [walked, setWalked] = useState(false);
  const go = (id: string | null) => {
    setWalked(id !== null);
    onLevel(id);
  };
  useBackLayer(backId, here !== null && walked, () => go(upId), backKind);

  /* 選中的與它們的上層（單選：路上的格子都亮；多選：數「底下選了幾個」、標「已含」） */
  const pickedSet = useMemo(() => new Set(picked), [picked]);
  const ancestorsOfPicked = useMemo(() => {
    const m = new Map<string, number>();
    for (const id of picked) {
      const c = catById[id];
      if (!c) continue;
      const path = categoryPath(c, catById);
      for (let i = 0; i < path.length - 1; i++) m.set(path[i].id, (m.get(path[i].id) ?? 0) + 1);
    }
    return m;
  }, [picked, catById]);
  const coveredByPick = (c: CategoryRow) => multi && categoryPath(c, catById).slice(0, -1).some((x) => pickedSet.has(x.id));

  const nodes = (here ? here.children : forest).filter((n) => !(hideUncat && isUncat(n.cat.id)));

  const cell = (n: CategoryNode) => {
    const c = n.cat;
    const kids = n.children.length;
    const self = pickedSet.has(c.id);
    const below = ancestorsOfPicked.get(c.id) ?? 0;
    const on = self || (!multi && below > 0);
    const isTaken = taken?.has(c.id) ?? false;
    if (kids > 0) {
      const note = multi && below > 0 ? `已選 ${below} 個 ›` : `${kids} 個 ›`;
      return (
        <button
          key={c.id}
          type="button"
          className={"ns-tk-mcell has-kids" + (on ? " on" : "")}
          aria-label={`${c.name}，${multi && below > 0 ? `已選 ${below} 個，` : ""}底下 ${kids} 個`}
          aria-pressed={on}
          onClick={() => go(c.id)}
        >
          <span>
            {c.name}
            <small>{note}</small>
          </span>
        </button>
      );
    }
    const covered = !self && coveredByPick(c);
    return (
      <button
        key={c.id}
        type="button"
        className={"ns-tk-mcell" + (on ? " on" : "") + (isTaken ? " is-taken" : "")}
        aria-pressed={on}
        disabled={isTaken}
        onClick={() => onPick(c)}
      >
        <span>
          {c.name}
          {isTaken ? <small>已設</small> : covered ? <small>已含</small> : null}
        </span>
      </button>
    );
  };

  const grid = (
    // key＝那一層：換層時整格重畫（淡入），不會沿用上一層的按鈕焦點
    <div key={here ? here.cat.id : "top"} className={"ns-tk-mgrid" + (here ? " is-in" : "")} role="group" aria-label={here ? here.cat.name : rootLabel}>
      {nodes.map(cell)}
      {tail?.(here ? here.cat.id : null)}
    </div>
  );
  if (!here) return grid;

  const thisOn = pickedSet.has(here.cat.id);
  const thisTaken = taken?.has(here.cat.id) ?? false;
  return (
    <div className="ns-tk-mdrill">
      <nav className="ns-tk-mcrumb" aria-label="分類的層">
        <button type="button" className="back" aria-label="回上一層" onClick={() => go(upId)}>
          <IconLeft size={16} />
        </button>
        <button type="button" className="seg" onClick={() => go(null)}>
          {rootLabel}
        </button>
        {trail.map((c, i) =>
          i < trail.length - 1 ? (
            <span key={c.id} className="part">
              <span className="sl" aria-hidden>
                ›
              </span>
              <button type="button" className="seg" onClick={() => go(c.id)}>
                {c.name}
              </button>
            </span>
          ) : (
            <span key={c.id} className="part">
              <span className="sl" aria-hidden>
                ›
              </span>
              <b aria-current="location">{c.name}</b>
            </span>
          ),
        )}
      </nav>
      {grid}
      <button
        type="button"
        className={"ns-tk-mthis" + (thisOn ? " on" : "")}
        aria-pressed={thisOn}
        disabled={thisTaken}
        onClick={() => onPick(here.cat)}
      >
        <span>
          {thisTaken ? "已設「" : multi && thisOn ? "已選「" : "選這一層「"}
          <b>{here.cat.name}</b>」{multi && !thisTaken ? "（含底下）" : ""}
        </span>
      </button>
    </div>
  );
}

/** 分類的完整路徑：上層淡字（去掉 emoji）、自己照名字——「食物 › 外食 › 午餐」（原型 a-m 的小標；自己或上層封存了補「（已封存）」） */
export function CatPathText({ cat }: { cat: CategoryRow }) {
  const catById = useTicketStore((s) => s.catById);
  const path = categoryPath(cat, catById);
  return (
    <>
      {path.length > 1 && (
        <span className="ns-tk-m4b-pa">
          {path
            .slice(0, -1)
            .map((c) => bareName(c.name) || c.name)
            .join(" › ")}{" "}
          ›{" "}
        </span>
      )}
      {cat.name}
      {categoryArchivedUp(cat, catById) ? "（已封存）" : ""}
    </>
  );
}
