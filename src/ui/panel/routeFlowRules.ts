/**
 * 幹線／路線管理的純規則（手機殼班第四輪 D-主-84：寫入與守門抽成兩殼共用）——文案組字、預設色、代碼正規化、刪除後切去哪。
 * 零 runtime store／data import：`scripts/tests/route-flows.test.ts` 用 node 直接載入本檔。
 * 接到 store、確認框與 toast 的那一層在 `./routeFlows.ts`（桌機 RouteDialog／RoutePanel／StationList 與手機路線圖、路線詳情頁共用）。
 *
 * 文案是桌機 RouteDialog／RoutePanel 原本寫在元件裡的字，一字不改搬過來（兩殼同一句話只有一個定義）。
 */
/** 本模組用到的節點欄位（NodeRow 的子集，免得為了型別拉 domain/index） */
export interface LineLike {
  id: string;
  name: string;
}
export interface RouteLike {
  id: string;
  name: string;
  line_id: string | null;
  code: string | null;
}

/** 確認框的三個字段（askConfirm 的 title／body／confirmLabel；body 還沒接別線的附加句） */
export interface ConfirmText {
  title: string;
  body: string;
  confirmLabel: string;
}

/* ── 新增路線表單 ── */

/** 新增路線的預設色是第幾格（給 ColorPicker 的 routePresetColor）：前三格輪流（第 4 格利休鼠＝灰，不當預設） */
export function defaultRouteColorIndex(routeCount: number): number {
  return (routeCount % 3) + 1;
}

/** 代碼輸入框：打字當下就轉大寫、最多 4 個字（新增表單與詳情編輯同一條規矩，兩殼皆同） */
export function codeInput(raw: string): string {
  return raw.toUpperCase().slice(0, 4);
}

/** 送出時的代碼：去頭尾空白、大寫；空字串＝不設（null） */
export function codeValue(raw: string): string | null {
  return raw.trim().toUpperCase() || null;
}

/** 代碼已被別條路線用掉（只淡提示、不擋） */
export function codeTaken(routes: readonly RouteLike[], raw: string): boolean {
  const v = raw.trim().toUpperCase();
  return v.length > 0 && routes.some((r) => r.code?.toUpperCase() === v);
}

/** 編輯既有路線時的版本：撞到的是自己不算 */
export function codeTakenByOther(routes: readonly RouteLike[], selfId: string, raw: string): boolean {
  return codeTaken(
    routes.filter((r) => r.id !== selfId),
    raw,
  );
}

/** 代碼重複時的提示句 */
export function codeTakenNote(raw: string): string {
  return `已有其他路線使用「${raw.trim().toUpperCase()}」——仍可儲存，只是圖示會重複。`;
}

/* ── 刪除幹線 ── */

/** 幹線底下的路線數 */
export function childRouteCount(routes: readonly RouteLike[], lineId: string): number {
  return routes.filter((r) => r.line_id === lineId).length;
}

/** 刪除幹線的確認框（連同底下幾條路線） */
export function lineDeleteConfirm(line: LineLike, childRoutes: number): ConfirmText {
  return {
    title: `刪除幹線「${line.name}」？`,
    body:
      childRoutes > 0
        ? `底下的 ${childRoutes} 條路線與所有支線、列車、車廂、車票會一起刪除；6 秒內可復原。`
        : "底下的所有內容會一起刪除；6 秒內可復原。",
    confirmLabel: "刪除",
  };
}

/** 編輯幹線危險區那一句（桌機 RouteDialog；按下去才是上面那個確認框） */
export function lineDeleteNote(childRoutes: number): string {
  return childRoutes > 0 ? `連同底下 ${childRoutes} 條路線一起刪除；6 秒內可復原。` : "刪除這條幹線；6 秒內可復原。";
}

/** 刪掉的幹線底下有沒有目前開著的路線（有＝刪完要換路線） */
export function lineHasCurrent(routes: readonly RouteLike[], lineId: string, currentRouteId: string | null): boolean {
  return routes.some((r) => r.line_id === lineId && r.id === currentRouteId);
}

export function lineDeletedToast(name: string): string {
  return `已刪除幹線「${name}」`;
}

/* ── 刪除路線 ── */

export function routeDeleteConfirm(route: LineLike): ConfirmText {
  return {
    title: `刪除路線「${route.name}」？`,
    body: "底下的支線、列車、車票與車站會一起刪掉（6 秒內可復原）。",
    confirmLabel: "刪除路線",
  };
}

export function routeDeletedToast(name: string): string {
  return `已刪除路線「${name}」`;
}

/** 刪完之後要切去的路線：剩下的第一條（排除剛刪的那條）；一條都不剩＝null */
export function nextRouteAfterDelete(routes: readonly RouteLike[], deletedId: string | null): string | null {
  return routes.find((r) => r.id !== deletedId)?.id ?? null;
}

/* ── 車站 ── */

export function stationDeletedToast(name: string): string {
  return `已刪除車站「${name}」`;
}
