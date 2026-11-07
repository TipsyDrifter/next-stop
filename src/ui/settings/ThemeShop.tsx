/**
 * ThemeShop——商店（第三梯 ⑩，D-主-435）：四套主題＋手寫字型。桌機在設定〈一般〉換頁、手機是「更多」的子頁，兩端同一份本體。
 * 即選即存（同主題三選）：點一張卡整個 App 就換上；回粉彩、銀河、跟隨系統＝上一頁的主題三選。
 * 縮圖不是截圖：`.ns-shop-mini[data-skin]` 就地掛那套 token，畫的是真值，改色不用重拍。
 */
import { useUiStore } from "../../store/uiStore";
import { useHandFontStore } from "../../store/handFontStore";
import { SKINS, type Skin } from "../../lib/themeShop";
import { DOWNLOADABLE_FONTS, type DownloadableFont } from "../../lib/handFonts";
import { openLink } from "../notes/openLink";
import chenyuSample from "../../assets/fonts/chenyu-sample.png";
import "./themeShop.css";

const SAMPLE = "今天也搭上下一班車";
const SAMPLE_IMAGE: Record<string, string> = { chenyu: chenyuSample };

function SkinCard({ skin, on, onPick }: { skin: Skin; on: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      className={"ns-shop-card" + (on ? " is-on" : "")}
      onClick={onPick}
    >
      <span className="ns-shop-mini" data-skin={skin.id} aria-hidden="true">
        <span className="ns-shop-mini-book" />
        <span className="ns-shop-mini-page">
          <span className="ns-shop-mini-ticket">
            <span className="ns-shop-mini-line" />
            <span className="ns-shop-mini-line is-short" />
            <span className="ns-shop-mini-seal">済</span>
          </span>
          <span className="ns-shop-mini-btn">到着</span>
        </span>
      </span>
      <span className="ns-shop-card-name">{skin.name}</span>
      <span className="ns-shop-card-note">{on ? "使用中" : skin.note}</span>
    </button>
  );
}

function FontRow({ font }: { font: DownloadableFont }) {
  const active = useHandFontStore((s) => s.active === font.id);
  const ready = useHandFontStore((s) => s.downloaded.includes(font.id));
  const progress = useHandFontStore((s) => (s.progress?.id === font.id ? s.progress.ratio : null));
  const error = useHandFontStore((s) => (s.error?.id === font.id ? s.error.kind : null));
  const use = useHandFontStore((s) => s.use);
  const remove = useHandFontStore((s) => s.remove);
  const busy = progress !== null;

  return (
    <div className={"ns-shop-font" + (active ? " is-on" : "")}>
      <div className="ns-shop-font-main">
        <span className="ns-shop-font-name">{font.name}</span>
        {ready ? (
          <span className="ns-shop-font-sample" style={{ fontFamily: `"${font.family}", var(--font-hand)` }}>
            {SAMPLE}
          </span>
        ) : (
          <img className="ns-shop-font-img" src={SAMPLE_IMAGE[font.id]} alt={SAMPLE} />
        )}
        <span className="ns-shop-font-credit">
          {font.credit}
          <button type="button" className="ns-shop-font-link" onClick={() => void openLink(font.licenseUrl)}>
            授權
          </button>
        </span>
        {error && (
          <span className="ns-shop-font-error" role="alert">
            {error === "network" ? "下載失敗，請確認網路後再試一次" : "下載到的檔案不對，沒有存下來"}
          </span>
        )}
      </div>
      <div className="ns-shop-font-acts">
        {active ? (
          <span className="ns-shop-font-state">使用中</span>
        ) : (
          <button type="button" className="btn-ghost ns-btn" disabled={busy} onClick={() => void use(font.id)}>
            {busy ? `正在下載 ${Math.round((progress ?? 0) * 100)}%` : ready ? "使用" : "下載並使用"}
          </button>
        )}
        {ready ? (
          <button type="button" className="ns-shop-font-link" onClick={() => void remove(font.id)}>
            刪除檔案
          </button>
        ) : (
          !busy && <span className="ns-shop-font-size">{(font.bytes / 1e6).toFixed(1)} MB</span>
        )}
      </div>
    </div>
  );
}

export function ThemeShop({ backLabel, backClassName, onBack }: { backLabel: string; backClassName: string; onBack: () => void }) {
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const iansuiActive = useHandFontStore((s) => s.active === "iansui");
  const useFont = useHandFontStore((s) => s.use);

  return (
    <div className="ns-shop">
      <button type="button" className={backClassName} onClick={onBack}>
        ← {backLabel}
      </button>

      <section>
        <span className="techo-label block mb-2.5">主題</span>
        <div className="ns-shop-grid" role="radiogroup" aria-label="商店主題">
          {SKINS.map((s) => (
            <SkinCard key={s.id} skin={s} on={theme === s.id} onPick={() => void setTheme(s.id)} />
          ))}
        </div>
      </section>

      <section>
        <span className="techo-label block mb-2.5">手寫字型</span>
        <div className={"ns-shop-font" + (iansuiActive ? " is-on" : "")}>
          <div className="ns-shop-font-main">
            <span className="ns-shop-font-name">芫荽</span>
            <span className="ns-shop-font-sample" style={{ fontFamily: '"Iansui"' }}>
              {SAMPLE}
            </span>
            <span className="ns-shop-font-credit">內建</span>
          </div>
          <div className="ns-shop-font-acts">
            {iansuiActive ? (
              <span className="ns-shop-font-state">使用中</span>
            ) : (
              <button type="button" className="btn-ghost ns-btn" onClick={() => void useFont("iansui")}>
                使用
              </button>
            )}
          </div>
        </div>
        {DOWNLOADABLE_FONTS.map((f) => (
          <FontRow key={f.id} font={f} />
        ))}
      </section>
    </div>
  );
}
