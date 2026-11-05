/**
 * useLocalFlag——記在本機設定的一個開關（己-2 B3／B4，D-主-419：區段開合「記住上次」）。
 *
 * `const [open, setOpen] = useLocalFlag("today_late_open_mobile", true)`：值存 settingsRepo（"1"／"0"），不進同步白名單——
 * 螢幕偏好一台一份（D-1.1-3）。手機殼的鍵自己帶 `_mobile`（桌機窄視窗也會切到手機殼，兩殼各記；同 KEY_RESULT_SORT）。
 *
 * 讀是非同步的：模組層快取一份，同一次開 App 第二次掛上就是同步的；第一次掛上先用 fallback，讀回來不同才換
 * （讀的途中使用者先按了 ⇒ 以他按的為準，讀回來的不蓋）。要連第一次都不閃，在模組層先叫 `preloadLocalFlag(key)`。
 * 讀不到、寫不進去都吞掉：開關照樣在這一次有效，只是下次不記得。
 */
import { useEffect, useRef, useState } from "react";
import { settingsRepo } from "../../data";

const cache = new Map<string, boolean>();
const inflight = new Map<string, Promise<void>>();

function load(key: string): Promise<void> {
  if (cache.has(key)) return Promise.resolve();
  let p = inflight.get(key);
  if (!p) {
    p = settingsRepo
      .get(key)
      .then((raw) => {
        if (!cache.has(key) && (raw === "1" || raw === "0")) cache.set(key, raw === "1");
      })
      .catch(() => undefined)
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

/** 先把這個鍵讀進快取（模組層叫一次，元件第一次掛上就不會先畫 fallback 再跳） */
export function preloadLocalFlag(key: string): void {
  void load(key);
}

export function useLocalFlag(key: string, fallback: boolean): [boolean, (next: boolean) => void] {
  const [value, setValue] = useState(() => cache.get(key) ?? fallback);
  const touched = useRef(false);
  useEffect(() => {
    if (cache.has(key)) return;
    let alive = true;
    void load(key).then(() => {
      const v = cache.get(key);
      if (alive && !touched.current && v !== undefined) setValue(v);
    });
    return () => {
      alive = false;
    };
  }, [key]);
  const set = (next: boolean) => {
    touched.current = true;
    cache.set(key, next);
    setValue(next);
    void settingsRepo.set(key, next ? "1" : "0").catch(() => undefined);
  };
  return [value, set];
}
