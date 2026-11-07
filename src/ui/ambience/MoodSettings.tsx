/**
 * MoodSettings.tsx — 設定裡的「今日氛圍」一區（⑪）。桌機〈一般〉與手機「更多」共用同一份字、同一支元件。
 * 模式單選走 Segmented、元件多選走選項 chip（視覺規範 §2.2／§2.5）。
 * 這個主題或模式用不到的那顆灰掉，title 寫為什麼（§1.8）。
 */
import { Segmented, type SegmentedOption } from "../common/Segmented";
import { useUiStore } from "../../store/uiStore";
import type { MoodMode, MoodParts } from "./moodDirector";
import { useMoodStore, type MoodLevel } from "./moodStore";

const MODES: SegmentedOption<MoodMode>[] = [
  { value: "ambient", label: "一直有", title: "列車、候鳥、流星偶爾經過，天色跟著時間變" },
  { value: "ritual", label: "蓋章時", title: "蓋一枚済來一班列車，全部済放雁行或流星群" },
  { value: "off", label: "關閉", title: "天空完全不動，星星也定住" },
];

const LEVELS: SegmentedOption<MoodLevel>[] = [
  { value: "lite", label: "淡" },
  { value: "mid", label: "中" },
];

const PARTS: { key: keyof MoodParts; label: string }[] = [
  { key: "train", label: "列車" },
  { key: "birds", label: "候鳥" },
  { key: "meteor", label: "流星" },
  { key: "dusk", label: "晨昏" },
];

export function MoodSettings({ labelClass, blockClass }: { labelClass: string; blockClass?: string }) {
  const mode = useMoodStore((s) => s.mode);
  const level = useMoodStore((s) => s.level);
  const parts = useMoodStore((s) => s.parts);
  const setMode = useMoodStore((s) => s.setMode);
  const setLevel = useMoodStore((s) => s.setLevel);
  const setPart = useMoodStore((s) => s.setPart);
  useUiStore((s) => s.theme); // 換主題時重畫，灰掉的那顆才跟得上

  const root = document.documentElement;
  const dark = root.getAttribute("data-theme") === "dark";
  const skin = root.hasAttribute("data-skin");
  const unavailable = (k: keyof MoodParts): string | null => {
    if (k === "birds" && dark) return "候鳥只在亮色主題出現";
    if (k === "meteor" && !dark && skin) return "這個主題的天空沒有星";
    if (k === "dusk" && mode !== "ambient") return "選「一直有」時才有晨昏";
    return null;
  };

  return (
    <div className={blockClass}>
      <span className={labelClass}>今日氛圍</span>
      <Segmented options={MODES} value={mode} onChange={setMode} aria-label="今日氛圍" />
      {mode !== "off" && (
        <div className="ns-mood-opts">
          <Segmented options={LEVELS} value={level} onChange={setLevel} aria-label="濃淡" compact />
          <div className="ns-mood-parts" role="group" aria-label="要出現哪些">
            {PARTS.map((p) => {
              const why = unavailable(p.key);
              return (
                <button
                  key={p.key}
                  type="button"
                  className={"chip ns-chip" + (parts[p.key] && !why ? " is-on" : "")}
                  aria-pressed={parts[p.key] && !why}
                  disabled={why !== null}
                  title={why ?? undefined}
                  onClick={() => setPart(p.key, !parts[p.key])}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
