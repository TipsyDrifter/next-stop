/**
 * 手機詳情頁「車站」一列（⑫；契約 §5）：規則同桌機側板（board/StationField 的 useStationField：沒有子項、路線上有車站才出）。
 * 點了開底部面板挑一站；疊在全螢幕頁上的返回層 MSheet 自己判（開的那一刻底下有 full 就當 dialog）。
 */
import { useState } from "react";
import type { NodeRow } from "../../../domain";
import { useStationField } from "../../board/StationField";
import { MSheet, MSheetItem } from "../../common/MSheet";
import { Row } from "./MobileStateRows";

export function MobileStationRow({ node }: { node: NodeRow }) {
  const f = useStationField(node);
  const [open, setOpen] = useState(false);
  if (!f) return null;
  const current = f.options.find((o) => o.value === f.value);
  return (
    <>
      <Row label="車站">
        <button type="button" className="m-dt-pick" aria-haspopup="dialog" onClick={() => setOpen(true)}>
          <span className={f.value ? undefined : "is-empty"}>{current?.label}</span>
          <span className="m-dt-chev" aria-hidden="true">
            ›
          </span>
        </button>
      </Row>
      {open && (
        <MSheet list title="車站" overline={node.name} onClose={() => setOpen(false)}>
          {f.options.map((o) => (
            <MSheetItem
              key={o.value}
              onClick={() => {
                setOpen(false);
                f.set(o.value);
              }}
            >
              {o.label}
              {o.value === f.value && <span className="m-tks-aside">✓</span>}
            </MSheetItem>
          ))}
        </MSheet>
      )}
    </>
  );
}
