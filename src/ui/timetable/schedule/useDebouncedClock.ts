/**
 * useDebouncedClock——小面板裡 ClockInput 的寫入節流（⑦ C 席；做法同 PlanPanel 的 pend／COMMIT_MS）。
 * ±15 長按會連跳，每一步都寫會撞寫入佇列、一步一個 toast；框裡先畫（pend），停手 COMMIT_MS 才寫一次；
 * 面板關掉時還沒寫的照寫；寫不進去（守門擋下）⇒ 框退回原值；外面的值換了而手上沒有等著寫的 ⇒ 框跟著換。
 */
import { useEffect, useRef, useState } from "react";

const COMMIT_MS = 450;

export function useDebouncedClock(value: number, commit: (ms: number) => Promise<boolean>) {
  const [pend, setPend] = useState<number | null>(null);
  const timer = useRef(0);
  const pendRef = useRef<number | null>(null);
  const seq = useRef(0);
  const commitRef = useRef(commit);
  commitRef.current = commit;

  const write = (ms: number, my: number): void => {
    void commitRef.current(ms).then((ok) => {
      if (!ok && seq.current === my) setPend(null);
    });
  };
  const writeRef = useRef(write);
  writeRef.current = write;

  useEffect(() => {
    if (!timer.current) {
      pendRef.current = null;
      setPend(null);
    }
  }, [value]);

  useEffect(
    () => () => {
      if (!timer.current) return;
      window.clearTimeout(timer.current);
      timer.current = 0;
      if (pendRef.current !== null) writeRef.current(pendRef.current, seq.current);
    },
    [],
  );

  const change = (ms: number): void => {
    const my = ++seq.current;
    pendRef.current = ms;
    setPend(ms);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = 0;
      write(ms, my);
    }, COMMIT_MS);
  };
  /** 等著寫的作廢（刪這段之前叫，免得關面板時又寫回去） */
  const cancel = (): void => {
    window.clearTimeout(timer.current);
    timer.current = 0;
    pendRef.current = null;
  };
  return { shown: pend ?? value, change, cancel };
}
