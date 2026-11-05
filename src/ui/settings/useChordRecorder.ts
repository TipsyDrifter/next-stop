/**
 * useChordRecorder——錄鍵：開著的時候整個視窗的鍵都歸它（⑧；原型 `prototypes/⑧-自訂快捷鍵.html` A 就地錄鍵）。
 *
 * 掛在 window 的 capture 階段再 `stopImmediatePropagation`：按什麼都不能順便觸發別的鍵
 * （Ctrl+P 不開跳轉、Esc 不關設定、Tab 不跳焦點）。Esc＝取消；Esc 不開放錄（isRebindable），所以不會擋到誰。
 * 點別的地方也算取消（按住卷軸捲動不算：只看按在鍵帽之外的 pointerdown，且捲軸按在 html 上）。
 */
import { useEffect, useRef, useState } from "react";
import { IS_MAC, type Chord } from "../shell/hotkeys";
import { chordFromEvent } from "../shell/hotkeyRebind";

/** 正在按著、還沒按到主鍵的修飾鍵（畫成「Ctrl+…」讓人知道有收到） */
function heldMods(e: KeyboardEvent): string[] {
  const held: string[] = [];
  if (e.ctrlKey || e.metaKey) held.push(IS_MAC ? "⌘" : "Ctrl");
  if (e.altKey) held.push(IS_MAC ? "⌥" : "Alt");
  if (e.shiftKey) held.push(IS_MAC ? "⇧" : "Shift");
  return held;
}

export function useChordRecorder(
  active: boolean,
  handlers: { onChord: (chord: Chord, code: string) => void; onCancel: () => void },
): { held: string[]; capRef: React.RefObject<HTMLSpanElement | null> } {
  const [held, setHeld] = useState<string[]>([]);
  const capRef = useRef<HTMLSpanElement | null>(null);
  const latest = useRef(handlers);
  latest.current = handlers;

  useEffect(() => {
    if (!active) return;
    setHeld([]);
    const swallow = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      swallow(e);
      if (e.repeat) return;
      if (e.key === "Escape") {
        latest.current.onCancel();
        return;
      }
      const chord = chordFromEvent(e, IS_MAC);
      if (chord) latest.current.onChord(chord, e.code);
      else setHeld(heldMods(e));
    };
    const onKeyUp = (e: KeyboardEvent) => {
      swallow(e);
      setHeld(heldMods(e));
    };
    const onPointerDown = (e: PointerEvent) => {
      if (e.target instanceof Node && capRef.current?.contains(e.target)) return;
      if (e.target === document.documentElement) return;
      latest.current.onCancel();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [active]);

  return { held, capRef };
}
