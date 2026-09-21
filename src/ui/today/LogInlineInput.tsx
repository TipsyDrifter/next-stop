/**
 * LogInlineInput——今日列的行內乘務記錄（`L`；M3 ③ 決策 2／實施計畫 §3 WP4）。
 *
 * 契約（TodayView／useTodayController 用）：{ nodeId, onDone(), onCancel() }
 *   - onDone()＝已記下（controller 關窗、焦點還給容器）
 *   - onCancel()＝放棄（同上，但不寫入）
 * 渲染的是 `<li class="log-row">` 內的兩個子節點：`<span class="lbl">乘務記錄</span>` ＋ 輸入框／回饋字；`<li>` 由 TodayView 出。
 *
 * 行為：
 * - 輸入框沿用 outline 的 InlineInput（IME 組字護欄／Enter 提交／Esc 取消／blur 保守處理全在裡面），
 *   只換字體＝手寫（--font-hand；主人筆跡例外，① 比稿 Q5），與側板乘務記錄的 `.what.hw` 同一套。
 * - Enter → addWorkLog → **列上短暫「記了」回饋**（輸入框換成一枚手寫「記了」約 0.9 秒）→ 才 onDone()。
 *   回饋掛在本元件內（controller 沒有 justLogged 狀態，WP2 回報已言明），列因此多活 0.9 秒。
 * - Esc／空字串 blur → onCancel()（不產生垃圾列）；有字 blur＝焦點已離開，直接記下收工，不留回饋。
 * - 計時器在卸載時清掉（React StrictMode 雙掛載會跑兩輪 effect，比照 ui/ambience 的 clear 模式）。
 */
import { useEffect, useRef, useState } from "react";
import { useNodeStore } from "../../store/nodeStore";
import { InlineInput } from "../outline/InlineInput";

/** 「記了」停留時間（ms）——看得見但不擋路 */
const FLASH_MS = 900;

export interface LogInlineInputProps {
  nodeId: string;
  onDone(): void;
  onCancel(): void;
}

export function LogInlineInput({ nodeId, onDone, onCancel }: LogInlineInputProps) {
  const addWorkLog = useNodeStore((s) => s.addWorkLog);
  const [flash, setFlash] = useState(false);
  const timer = useRef<number | null>(null);
  // 最新的 onDone 放 ref：timer 回呼裡才不會抓到舊 closure
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    },
    [],
  );

  if (flash) {
    return (
      <>
        <span className="lbl" aria-hidden>
          乘務記錄
        </span>
        <span className="logged" role="status">
          記了
        </span>
      </>
    );
  }

  return (
    <>
      <span className="lbl" aria-hidden>
        乘務記錄
      </span>
      <InlineInput
        placeholder="記一句（Enter 記下・Esc 取消）"
        ariaLabel="乘務記錄"
        focusKey={nodeId}
        className="techo-input hw"
        onCommit={(text, via) => {
          const body = text.trim();
          if (!body) {
            // 空白＝沒東西可記：blur 與 Enter 都當取消，不寫垃圾列
            onCancel();
            return;
          }
          void addWorkLog(nodeId, body);
          if (via === "enter") {
            // 留在原地閃一下「記了」，讓主人看見那句話確實落進乘務記錄
            setFlash(true);
            timer.current = window.setTimeout(() => {
              timer.current = null;
              done.current();
            }, FLASH_MS);
          } else {
            // blur＝焦點已經去別處，回饋沒人看：直接收工
            onDone();
          }
        }}
        onCancel={onCancel}
        onTab={() => onCancel()}
      />
    </>
  );
}
