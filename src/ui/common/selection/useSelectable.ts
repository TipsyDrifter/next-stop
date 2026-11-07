/**
 * 這一頁哪些卡能進多選（⑫ 車庫裡的路線唯讀；判準在 store/selectionStore.setSelectable）。兩殼共用：掛著的時候登記、卸載拿掉。
 * 判準讀最新的 props（用 ref），呼叫端不必 memo。
 */
import { useEffect, useRef } from "react";
import { setSelectable, type SelectionScope } from "../../../store/selectionStore";

export function useSelectable(scope: SelectionScope, can: (id: string) => boolean): void {
  const ref = useRef(can);
  ref.current = can;
  useEffect(() => {
    setSelectable(scope, (id) => ref.current(id));
    return () => setSelectable(scope, null);
  }, [scope]);
}
