/**
 * CompleteCard——列車／車廂蓋章後的輕量完成卡（D4）：原型票面語彙的小卡（.complete-card＝paper-high＋1px line；CSS 在 styles/techo.css）
 * ＝済章（原型 .stamp／.seal）＋節點名（.title）＋心情三燈（三個 .badge 小圓，可不選）＋一行工作日誌（自動聚焦）。
 * Enter／「存入」＝儲存（有選心情→updateNode({mood})；有文字→addWorkLog）並關閉；Esc／「跳過」＝整卡跳過；不阻擋其他操作（無暗幕）。
 * 對應 UI Flow 2.0d／1.0b（今日視圖共用）。唯一來源＝uiStore.completeCardFor。
 * 取捨：心情三燈的顏色借主題既有變數（松葉／燙金／朱）而非新增 token；預設吸附於主欄底部中央（父層需 relative），可用 className 覆寫定位。
 * M3 ④（定期券）：心情照舊走 `updateNode({ mood })`——repository 會把它鏡射到「現在顯示的那一班」
 *   （nodes.mood ＝最近一班），所以這張卡對定期券與一般票走同一條路；一行乘務記錄也照舊掛在節點上。
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { KIND_LABEL, type Mood } from "../../domain";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";

const MOODS: { value: Mood; label: string; glyph: string; color: string }[] = [
  { value: "green", label: "順暢", glyph: "順", color: "var(--route-preset-3)" },
  { value: "yellow", label: "還行", glyph: "還", color: "var(--color-gold)" },
  { value: "red", label: "吃力", glyph: "難", color: "var(--color-seal)" },
];

export function CompleteCard({ className }: { className?: string }) {
  const id = useUiStore((s) => s.completeCardFor);
  if (!id) return null;
  return <CompleteCardInner key={id} id={id} className={className} />;
}

function CompleteCardInner({ id, className }: { id: string; className?: string }) {
  const node = useNodeStore((s) => s.tree.byId[id] ?? s.today.byId[id]); // 今日視圖蓋章時節點不在 tree 裡（M3 ③ WP1 接縫）
  const updateNode = useNodeStore((s) => s.updateNode);
  const addWorkLog = useNodeStore((s) => s.addWorkLog);
  const setCompleteCardFor = useUiStore((s) => s.setCompleteCardFor);

  const [mood, setMood] = useState<Mood | null>(null);
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const savingRef = useRef(false);

  // 開卡自動聚焦；關卡把焦點還給原處（通常是大綱容器）
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => {
      if (prev && prev.isConnected) prev.focus();
    };
  }, []);

  const close = () => setCompleteCardFor(null);

  const save = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      const body = text.trim();
      if (mood) await updateNode(id, { mood });
      if (body) await addWorkLog(id, body);
    } finally {
      savingRef.current = false;
      close();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      void save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  const name = node?.name ?? "這班列車";
  const kindLabel = node ? KIND_LABEL[node.kind] : "列車";

  return (
    <div
      role="dialog"
      aria-label={`完成卡：${name}`}
      onKeyDown={onKeyDown}
      className={(className ?? "absolute bottom-6 left-1/2 -translate-x-1/2 z-20") + " complete-card transition duration-200 ease-out starting:opacity-0 starting:translate-y-2"}
    >
      {/* 済章：原型検印欄（章已蓋上；靜態，不吃 hover） */}
      <div className="stamp-zone is-done">
        <span className="stamp" aria-hidden>
          <span className="hint">検印</span>
          <span className="seal">済</span>
        </span>
      </div>

      <div className="body">
        <span className="fare-class">{kindLabel}到站</span>
        <p className="title">{name}</p>

        <div className="meta">
          {/* 心情三燈：三個 .badge 小圓（空心＝未選、實底＝選中） */}
          <span role="radiogroup" aria-label="心情" className="moods">
            {MOODS.map((m) => {
              const on = mood === m.value;
              return (
                <button
                  key={m.value}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={`心情：${m.label}`}
                  title={m.label}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setMood(on ? null : m.value)}
                  className={"badge dashed" + (on ? " on" : "")}
                  style={{ color: m.color }}
                >
                  {m.glyph}
                </button>
              );
            })}
          </span>
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="這班列車做了什麼？（選填）"
            aria-label="一行乘務記錄"
            spellCheck={false}
            autoComplete="off"
            className="techo-input log"
          />
        </div>

        <div className="actions">
          <span className="note">Enter 存入・Esc 跳過</span>
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={close} aria-label="跳過完成卡" className="btn-ghost">
            跳過
          </button>
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => void save()} className="btn-seal">
            存入
          </button>
        </div>
      </div>
    </div>
  );
}
