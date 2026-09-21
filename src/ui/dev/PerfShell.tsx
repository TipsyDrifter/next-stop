/**
 * PerfShell — M3 主題換裝前的 WebView2 效能驗證空殼（dev 專用，?perf=1 掛載）。
 *
 * 依 C1（銀河鐵道）／C2（粉彩星空）原型的真實配方重建氛圍層壓力源：
 *   - C2：30 張 backdrop-filter:blur(14px) 霧面卡＋SVG 噪點疊層＋7 顆 bokeh＋halo blur(22px)＋48 星
 *   - C1：90 星塵＋56 呼吸星＋mask 打孔票卡 30 張＋列車／流星動畫
 *   - baseline：無氛圍層的素卡 30 張（比較基準）
 * 每情境量 idle／scroll／anim 三態的幀率統計＋輸入延遲 proxy。
 * 結果：畫面顯示＋POST http://127.0.0.1:14260/result（scratchpad 的 perf-receiver 收檔）。
 *
 * 原型出處：prototypes/m3-mood-c1-galaxy.html／m3-mood-c2-pastel.html（決策 10：原生動態隨主題進）。
 * 量完即棄的檢測工具；不進 production bundle（main.tsx 以 import.meta.env.DEV 閘門）。
 */
import { useEffect, useRef, useState } from "react";

const NOISE =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.95' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")";

const CSS = `
.pf-root{position:fixed;inset:0;overflow:hidden;font-family:'Noto Sans TC',sans-serif;color:#222}
.pf-sky{position:absolute;inset:0;pointer-events:none}
.pf-base .pf-sky{background:#f2efe9}
.pf-c2 .pf-sky{background:
  radial-gradient(560px 400px at 0% 96%, rgba(255,240,220,.62), transparent 66%),
  linear-gradient(180deg, transparent 34%, rgba(255,255,255,.16) 54%, transparent 76%),
  linear-gradient(180deg, #b4c1e0 0%, #c8c0e4 52%, #ecd2da 100%)}
.pf-c1 .pf-sky{background:
  radial-gradient(640px 480px at 95% 2%, rgba(226,232,250,.085), transparent 62%),
  linear-gradient(180deg, #0d1126 0%, #111a30 42%, #17233e 80%, #1d2b4a 100%)}
.pf-halo{position:absolute;left:38%;top:6%;width:1180px;height:150px;transform:rotate(-16deg);transform-origin:0 50%;
  background:linear-gradient(90deg, transparent 0%, rgba(255,176,176,.27) 14%, rgba(255,220,166,.24) 30%,
  rgba(206,240,196,.21) 46%, rgba(176,212,255,.27) 62%, rgba(214,186,255,.27) 78%, transparent 100%);
  filter:blur(22px);opacity:.9}
.pf-bokeh{position:absolute;border-radius:50%;width:var(--s);height:var(--s);
  background:radial-gradient(circle, var(--c) 0%, transparent 68%)}
.pf-star{position:absolute;border-radius:50%;background:#fff;width:var(--s);height:var(--s);left:var(--x);top:var(--y);
  opacity:var(--o);animation:pfTwinkle var(--d) ease-in-out var(--dl) infinite}
@keyframes pfTwinkle{0%,100%{opacity:calc(var(--o) * .35)} 50%{opacity:var(--o)}}
.pf-dust{position:absolute;border-radius:50%;background:rgb(230,236,255);width:var(--s);height:var(--s);
  left:var(--x);top:var(--y);opacity:var(--o)}
.pf-meteor{position:absolute;left:40%;top:14%;transform:rotate(24deg);transform-origin:0 50%;opacity:0}
.pf-meteor i{display:block;width:170px;height:2px;border-radius:2px;
  background:linear-gradient(90deg, rgba(255,255,255,0), rgba(255,255,255,.6) 60%, #fff);
  box-shadow:0 0 10px 1px rgba(255,255,255,.85)}
.pf-meteor.go{opacity:1}
.pf-meteor.go i{animation:pfMeteor 1.15s cubic-bezier(.25,.1,.35,1) forwards}
@keyframes pfMeteor{0%{transform:translateX(0);opacity:0}12%{opacity:1}80%{opacity:.9}100%{transform:translateX(440px);opacity:0}}
.pf-train{position:absolute;left:0;bottom:10px;width:262px;height:26px;opacity:.6;transform:translateX(-300px)}
.pf-train.go{animation:pfTrain 15s linear infinite}
@keyframes pfTrain{0%{transform:translateX(-300px)}100%{transform:translateX(110vw)}}
.pf-list{position:absolute;left:260px;top:96px;bottom:24px;width:640px;overflow-y:auto;
  display:flex;flex-direction:column;gap:14px;padding:4px 20px 40px 4px}
.pf-card{position:relative;display:flex;align-items:stretch;min-height:76px;border-radius:4px;flex:none}
.pf-base .pf-card{background:#fff;border:1px solid #ddd;box-shadow:0 1px 2px rgba(0,0,0,.06),0 8px 22px rgba(0,0,0,.06)}
.pf-c2 .pf-card{background:rgba(255,255,255,.64);
  -webkit-backdrop-filter:blur(14px) saturate(1.15);backdrop-filter:blur(14px) saturate(1.15);
  border:1px solid rgba(255,255,255,.78);
  box-shadow:0 0 0 1px rgba(60,60,120,.10),0 1px 2px rgba(50,45,100,.08),0 8px 22px rgba(60,50,120,.12);
  -webkit-mask-image:radial-gradient(circle 6.5px at 118px 0, transparent 97%, #000 100%),
    radial-gradient(circle 6.5px at 118px 100%, transparent 97%, #000 100%);
  -webkit-mask-composite:source-in;
  mask-image:radial-gradient(circle 6.5px at 118px 0, transparent 97%, #000 100%),
    radial-gradient(circle 6.5px at 118px 100%, transparent 97%, #000 100%);
  mask-composite:intersect;color:#2a2b49}
.pf-c2 .pf-card::after{content:"";position:absolute;inset:0;border-radius:4px;background:${NOISE};
  opacity:.055;mix-blend-mode:multiply;pointer-events:none}
.pf-c1 .pf-card{color:#e4e8f3}
.pf-c1 .pf-card::before{content:"";position:absolute;inset:0;z-index:-1;border-radius:3px;background:#212a40;
  border:1px solid rgba(222,230,250,.14);
  box-shadow:inset 0 1px 0 rgba(230,236,255,.09),inset -1px 0 0 rgba(230,236,255,.035);
  -webkit-mask-image:radial-gradient(circle at 118px 0, transparent 6px, #000 6.8px);
  -webkit-mask-size:100% 100%;-webkit-mask-repeat:repeat-y;
  mask-image:radial-gradient(circle at 118px 0, transparent 6px, #000 6.8px);
  mask-size:100% 100%;mask-repeat:repeat-y}
.pf-c1 .pf-card{box-shadow:0 1px 2px rgba(3,6,14,.4),0 8px 22px rgba(3,6,14,.38)}
.pf-stub{width:118px;flex:none;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;
  border-right:1px dashed rgba(128,128,150,.4);font-size:10px;letter-spacing:.2em}
.pf-badge{width:31px;height:31px;border-radius:50%;border:1.6px solid currentColor;display:grid;place-items:center;font-size:12px}
.pf-body{flex:1;padding:13px 18px 12px;min-width:0}
.pf-title{font-size:15px;letter-spacing:.04em}
.pf-meta{margin-top:7px;font-size:12px;opacity:.75}
.pf-zone{width:100px;flex:none;display:grid;place-items:center}
.pf-seal{width:58px;height:58px;border-radius:50%;border:2.5px solid #c4503e;color:#c4503e;display:grid;place-items:center;
  font-size:26px;font-weight:700;transform:rotate(-8deg);opacity:0}
.pf-card.done .pf-seal{opacity:.94}
.pf-card.fresh .pf-seal{animation:pfStamp .4s cubic-bezier(.2,1.5,.4,1)}
@keyframes pfStamp{0%{transform:scale(1.75) rotate(-26deg);opacity:0}55%{transform:scale(.9) rotate(-6deg);opacity:.96}100%{transform:scale(1) rotate(-8deg);opacity:.94}}
.pf-hud{position:absolute;left:16px;top:12px;z-index:9;background:rgba(20,22,40,.86);color:#fff;border-radius:6px;
  padding:10px 16px;font-size:13px;line-height:1.7;max-width:210px}
.pf-hud b{color:#ffd9a0}
.pf-input{position:absolute;left:16px;top:150px;z-index:9;width:210px;padding:6px 8px;font-size:13px}
.pf-out{position:absolute;right:12px;top:12px;bottom:12px;width:430px;z-index:9;overflow:auto;background:rgba(20,22,40,.92);
  color:#cfe;padding:14px;font-size:11px;line-height:1.5;border-radius:6px;white-space:pre-wrap}
`;

type FrameStats = {
  frames: number; fps: number; medianMs: number; p95Ms: number; maxMs: number;
  long50: number; dropped: number; hidden: boolean;
};
type Scenario = "base" | "c2" | "c1";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const doubleRaf = () =>
  new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

function meter(ms: number): Promise<FrameStats> {
  return new Promise((res) => {
    const deltas: number[] = [];
    let hidden = false;
    let last = 0, t0 = 0;
    function tick(t: number) {
      if (t0 === 0) { t0 = t; last = t; requestAnimationFrame(tick); return; }
      const d = t - last; last = t;
      if (d > 0 && d < 1000) deltas.push(d);
      if (document.hidden) hidden = true;
      if (t - t0 < ms) requestAnimationFrame(tick);
      else {
        const sorted = [...deltas].sort((a, b) => a - b);
        const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
        const median = q(0.5);
        const avg = deltas.reduce((a, b) => a + b, 0) / Math.max(1, deltas.length);
        res({
          frames: deltas.length,
          fps: Math.round(10000 / avg) / 10,
          medianMs: Math.round(median * 100) / 100,
          p95Ms: Math.round(q(0.95) * 100) / 100,
          maxMs: Math.round((sorted[sorted.length - 1] ?? 0) * 100) / 100,
          long50: deltas.filter((d2) => d2 > 50).length,
          dropped: deltas.filter((d2) => d2 > Math.max(25, median * 2.2)).length,
          hidden,
        });
      }
    }
    requestAnimationFrame(tick);
  });
}

export function PerfShell() {
  const [scenario, setScenario] = useState<Scenario>("base");
  const [phase, setPhase] = useState("暖機中…");
  const [output, setOutput] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const skyRef = useRef<HTMLDivElement>(null);
  const meteorRef = useRef<HTMLDivElement>(null);
  const trainRef = useRef<SVGSVGElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const ran = useRef(false);

  // 星點依情境重建（配方照原型：C2＝48 星；C1＝90 塵＋56 星）
  useEffect(() => {
    const sky = skyRef.current;
    if (!sky) return;
    sky.querySelectorAll(".pf-star,.pf-dust").forEach((n) => n.remove());
    const rnd = (a: number, b: number) => a + Math.random() * (b - a);
    const frag = document.createDocumentFragment();
    if (scenario === "c2") {
      for (let i = 0; i < 48; i++) {
        const s = document.createElement("span");
        s.className = "pf-star";
        const big = i < 4;
        s.style.setProperty("--x", rnd(18, 99).toFixed(2) + "%");
        s.style.setProperty("--y", (Math.pow(Math.random(), 1.6) * 62).toFixed(2) + "%");
        s.style.setProperty("--s", (big ? rnd(2.2, 2.8) : rnd(1, 1.9)).toFixed(2) + "px");
        s.style.setProperty("--o", (big ? rnd(0.8, 0.95) : rnd(0.45, 0.85)).toFixed(2));
        s.style.setProperty("--d", rnd(4, 9).toFixed(2) + "s");
        s.style.setProperty("--dl", (-rnd(0, 9)).toFixed(2) + "s");
        if (big) s.style.boxShadow = "0 0 6px 1px rgba(255,255,255,.75)";
        frag.appendChild(s);
      }
    } else if (scenario === "c1") {
      for (let i = 0; i < 90; i++) {
        const d = document.createElement("span");
        d.className = "pf-dust";
        d.style.setProperty("--x", rnd(0, 100).toFixed(2) + "%");
        d.style.setProperty("--y", rnd(0, 86).toFixed(2) + "%");
        d.style.setProperty("--s", rnd(0.8, 1.5).toFixed(2) + "px");
        d.style.setProperty("--o", rnd(0.18, 0.48).toFixed(2));
        frag.appendChild(d);
      }
      for (let i = 0; i < 56; i++) {
        const s = document.createElement("span");
        s.className = "pf-star";
        const r = Math.random();
        const size = r < 0.12 ? 2.6 : r < 0.5 ? 1.8 : 1.3;
        s.style.setProperty("--x", rnd(0, 100).toFixed(2) + "%");
        s.style.setProperty("--y", rnd(0, 84).toFixed(2) + "%");
        s.style.setProperty("--s", size + "px");
        s.style.setProperty("--o", rnd(0.72, 1).toFixed(2));
        s.style.setProperty("--d", rnd(4, 11).toFixed(1) + "s");
        s.style.setProperty("--dl", (-rnd(0, 9)).toFixed(1) + "s");
        if (size > 2) s.style.boxShadow = "0 0 4px 1px rgba(230,236,255,.35)";
        frag.appendChild(s);
      }
    }
    sky.appendChild(frag);
  }, [scenario]);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    let meteorTimer: number | undefined;
    let stampTimer: number | undefined;
    let scrollOn = false;

    const startMeteors = () => {
      const fire = () => {
        const m = meteorRef.current;
        if (!m) return;
        m.classList.remove("go");
        void (m as unknown as HTMLElement).offsetWidth;
        m.style.left = (28 + Math.random() * 44).toFixed(1) + "%";
        m.style.top = (5 + Math.random() * 21).toFixed(1) + "%";
        m.classList.add("go");
      };
      fire();
      meteorTimer = window.setInterval(fire, 1600);
    };
    const startStamps = () => {
      stampTimer = window.setInterval(() => {
        const cards = listRef.current?.querySelectorAll(".pf-card");
        if (!cards?.length) return;
        const c = cards[Math.floor(Math.random() * cards.length)];
        c.classList.remove("done", "fresh");
        void (c as HTMLElement).offsetWidth;
        c.classList.add("done", "fresh");
      }, 900);
    };
    const stopAnims = () => {
      window.clearInterval(meteorTimer);
      window.clearInterval(stampTimer);
      meteorRef.current?.classList.remove("go");
      trainRef.current?.classList.remove("go");
    };
    const scrollStress = async (ms: number) => {
      scrollOn = true;
      const el = listRef.current;
      const t0 = performance.now();
      const drive = (t: number) => {
        if (!scrollOn || !el) return;
        const max = el.scrollHeight - el.clientHeight;
        el.scrollTop = (max / 2) * (1 + Math.sin((t - t0) / 260));
        requestAnimationFrame(drive);
      };
      requestAnimationFrame(drive);
      const stats = await meter(ms);
      scrollOn = false;
      return stats;
    };
    const typeTest = async (n: number) => {
      const el = inputRef.current;
      if (!el) return { medianMs: -1, p95Ms: -1 };
      el.focus();
      el.value = "";
      const arr: number[] = [];
      for (let i = 0; i < n; i++) {
        const t0 = performance.now();
        el.value += "測";
        el.dispatchEvent(new InputEvent("input", { bubbles: true }));
        await doubleRaf();
        arr.push(performance.now() - t0);
        await sleep(28);
      }
      arr.sort((a, b) => a - b);
      const q = (p: number) => Math.round(arr[Math.floor(arr.length * p)] * 100) / 100;
      return { medianMs: q(0.5), p95Ms: q(0.95) };
    };

    const run = async () => {
      const result: Record<string, unknown> = {
        startedAt: new Date().toISOString(),
        ua: navigator.userAgent,
        dpr: devicePixelRatio,
        viewport: `${innerWidth}x${innerHeight}`,
        cards: 30,
      };
      await sleep(1500); // 暖機

      for (const sc of ["base", "c2", "c1"] as Scenario[]) {
        setScenario(sc);
        await doubleRaf();
        await sleep(600);
        const block: Record<string, unknown> = { epochStart: Date.now() };

        setPhase(`${sc} · idle`);
        block.idle = await meter(6000);
        setPhase(`${sc} · typing`);
        block.typing = await typeTest(30);
        setPhase(`${sc} · scroll`);
        block.scroll = await scrollStress(6000);

        if (sc !== "base") {
          setPhase(`${sc} · anim`);
          startMeteors();
          startStamps();
          if (sc === "c1" || sc === "c2") trainRef.current?.classList.add("go");
          block.anim = await meter(6000);
          stopAnims();
        }
        block.epochEnd = Date.now();
        result[sc] = block;
      }

      setPhase("完成 ✅（結果送出中）");
      const json = JSON.stringify(result, null, 2);
      setOutput(json);
      // eslint-disable-next-line no-console
      console.log("PERF_RESULT", json);
      try {
        await fetch("http://127.0.0.1:14260/result", { method: "POST", body: json });
        setPhase("完成 ✅（結果已送出）");
      } catch {
        setPhase("完成 ✅（POST 失敗，結果僅在畫面／console）");
      }
    };
    void run();
    return stopAnims;
  }, []);

  const cards = Array.from({ length: 30 }, (_, i) => (
    <div className="pf-card" key={i}>
      <div className="pf-stub"><span className="pf-badge">E1</span><span>全端開發</span><span>No.{1000 + i}</span></div>
      <div className="pf-body">
        <p className="pf-title">效能測試車票 第 {i + 1} 張</p>
        <p className="pf-meta">進行中 ・ 車票 2/3 ・ 預計 45 分</p>
      </div>
      <div className="pf-zone"><span className="pf-seal">済</span></div>
    </div>
  ));

  return (
    <div className={`pf-root pf-${scenario}`}>
      <style>{CSS}</style>
      <div className="pf-sky" ref={skyRef}>
        {scenario === "c2" && (
          <>
            <div className="pf-halo" />
            <div className="pf-bokeh" style={{ ["--s" as string]: "340px", ["--c" as string]: "rgba(255,255,255,.30)", left: "14%", top: "18%" }} />
            <div className="pf-bokeh" style={{ ["--s" as string]: "220px", ["--c" as string]: "rgba(255,214,228,.34)", left: "58%", top: "30%" }} />
            <div className="pf-bokeh" style={{ ["--s" as string]: "420px", ["--c" as string]: "rgba(207,224,255,.30)", left: "66%", top: "-8%" }} />
            <div className="pf-bokeh" style={{ ["--s" as string]: "180px", ["--c" as string]: "rgba(255,240,214,.30)", left: "30%", top: "56%" }} />
            <div className="pf-bokeh" style={{ ["--s" as string]: "280px", ["--c" as string]: "rgba(255,222,236,.26)", left: "80%", top: "58%" }} />
            <div className="pf-bokeh" style={{ ["--s" as string]: "150px", ["--c" as string]: "rgba(255,255,255,.34)", left: "46%", top: "72%" }} />
            <div className="pf-bokeh" style={{ ["--s" as string]: "260px", ["--c" as string]: "rgba(214,226,255,.28)", left: "8%", top: "66%" }} />
          </>
        )}
        <div className="pf-meteor" ref={meteorRef} style={{ display: scenario === "base" ? "none" : "" }}><i /></div>
        <svg
          className="pf-train" ref={trainRef} viewBox="0 0 262 26"
          style={{ display: scenario === "base" ? "none" : "", color: scenario === "c1" ? "#070a12" : "#2a2b49" }}
        >
          <g fill="currentColor">
            <path d="M4 22 V11 q0-3 3-3 h77 v14 Z" /><rect x="89" y="8" width="84" height="14" />
            <path d="M178 8 h77 q3 0 3 3 v11 h-80 Z" />
            <rect x="12" y="22" width="16" height="3" rx="1" /><rect x="60" y="22" width="16" height="3" rx="1" />
            <rect x="97" y="22" width="16" height="3" rx="1" /><rect x="149" y="22" width="16" height="3" rx="1" />
            <rect x="186" y="22" width="16" height="3" rx="1" /><rect x="234" y="22" width="16" height="3" rx="1" />
          </g>
          <g fill="rgba(255,236,200,.9)">
            {Array.from({ length: 14 }, (_, i) => (
              <rect key={i} x={12 + i * 17} y="11" width="9" height="6" rx="1" />
            ))}
          </g>
        </svg>
      </div>
      <div className="pf-hud">
        <b>WebView2 效能驗證</b><br />
        情境：{scenario}<br />
        階段：{phase}<br />
        請保持視窗可見約 70 秒
      </div>
      <input className="pf-input" ref={inputRef} placeholder="輸入延遲測試欄" />
      <div className="pf-list" ref={listRef}>{cards}</div>
      {output && <pre className="pf-out">{output}</pre>}
    </div>
  );
}
