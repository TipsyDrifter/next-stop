/**
 * 車窓・理想手札——新增與編輯風景卡對話框／底部面板（第六本第四梯 v1.30；決定 1-B）。
 *
 * 桌機走 `DialogShell`（size="M"）、手機走 `MSheet`（backId="core.ideal.card"＋useBackLayer 守門）。
 */
import { useRef, useState, type ChangeEvent, type FormEvent } from "react";
import {
  IDEAL_ART_PRESETS,
  IDEAL_THEMES,
  defaultArtForTheme,
  type IdealArtPresetId,
  type IdealTheme,
} from "../../domain/idealTecho";
import { useIdealStore, type CardDialogState } from "../../store/idealStore";
import { useUiStore } from "../../store/uiStore";
import { DialogShell } from "../common/DialogShell";
import { MSheet } from "../common/MSheet";
import { Segmented } from "../common/Segmented";
import { useBackLayer } from "../mobile/backStack";
import { IdealArtSvg } from "./IdealArtSvg";
import { compressIdealPhoto } from "./compressPhoto";

interface IdealCardDialogProps {
  dialog: CardDialogState;
  shell: "desktop" | "mobile";
  onClose: () => void;
}

const THEME_OPTIONS = IDEAL_THEMES.map((t) => ({
  value: t.id,
  label: t.label,
  title: t.hint,
}));

export function IdealCardDialog({ dialog, shell, onClose }: IdealCardDialogProps) {
  const saveCard = useIdealStore((s) => s.saveCard);
  const initialCard = dialog.mode === "edit" ? dialog.card : null;
  const initialTheme: IdealTheme = dialog.mode === "edit" ? dialog.card.theme : dialog.defaultTheme;

  const [theme, setTheme] = useState<IdealTheme>(initialTheme);
  const [title, setTitle] = useState<string>(initialCard?.title ?? "");
  const [body, setBody] = useState<string>(initialCard?.body ?? "");
  const [motto, setMotto] = useState<string>(initialCard?.motto ?? "");
  const [artPreset, setArtPreset] = useState<IdealArtPresetId>(
    initialCard?.art_preset ?? defaultArtForTheme(initialTheme),
  );
  const [artTouched, setArtTouched] = useState<boolean>(Boolean(initialCard));
  const [photoData, setPhotoData] = useState<string | null>(initialCard?.photo_data ?? null);
  const [pinned, setPinned] = useState<boolean>(Boolean(initialCard?.pinned));
  const [compressing, setCompressing] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useBackLayer("core.ideal.card", shell === "mobile", onClose, "sheet");

  const handleThemeChange = (next: IdealTheme) => {
    setTheme(next);
    if (!artTouched) {
      setArtPreset(defaultArtForTheme(next));
    }
  };

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setCompressing(true);
    try {
      const encoded = await compressIdealPhoto(file);
      setPhotoData(encoded);
    } catch (err) {
      useUiStore.getState().showToast({
        message: err instanceof Error ? err.message : "相片讀取失敗",
      });
    } finally {
      setCompressing(false);
    }
  };

  const handleSubmit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (saving || compressing) return;
    if (!title.trim()) {
      useUiStore.getState().showToast({ message: "請幫這幅風景寫個標題" });
      return;
    }
    setSaving(true);
    const saved = await saveCard(
      {
        theme,
        title,
        body,
        motto,
        artPreset,
        photoData,
        pinned,
      },
      initialCard?.id,
    );
    setSaving(false);
    if (saved) onClose();
  };

  const activeThemeHint = IDEAL_THEMES.find((t) => t.id === theme)?.hint ?? "";

  const formContent = (
    <form className="ns-ideal-form" onSubmit={(e) => void handleSubmit(e)}>
      <div className="ns-ideal-field">
        <span className="ns-ideal-field-label">風景主題</span>
        <Segmented
          aria-label="風景主題"
          options={THEME_OPTIONS}
          value={theme}
          onChange={handleThemeChange}
        />
        <span className="ns-ideal-field-hint">{activeThemeHint}</span>
      </div>

      <label className="ns-ideal-field">
        <span className="ns-ideal-field-label">標題</span>
        <input
          type="text"
          className="ns-ideal-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="例：溫柔而有底氣的創造者／看得見海的小站慢旅"
          maxLength={80}
          autoFocus={shell === "desktop"}
        />
      </label>

      <label className="ns-ideal-field">
        <span className="ns-ideal-field-label">描繪這幅風景</span>
        <textarea
          className="ns-ideal-textarea"
          rows={3}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="不設期限、不打勾——寫下你想長久守住的模樣、光線、氣息或心境…"
        />
      </label>

      <label className="ns-ideal-field">
        <span className="ns-ideal-field-label">心之所向・一句題詞（選填）</span>
        <input
          type="text"
          className="ns-ideal-input"
          value={motto}
          onChange={(e) => setMotto(e.target.value)}
          placeholder="釘選在今日頂端時顯示的一句話（留白則顯示標題）"
          maxLength={90}
        />
      </label>

      <div className="ns-ideal-field">
        <div className="ns-ideal-art-head">
          <span className="ns-ideal-field-label">車窗風景（內建線畫或自選相片）</span>
          <div className="ns-ideal-art-tools">
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="ns-ideal-file-hidden"
              onChange={(e) => void handleFileChange(e)}
            />
            <button
              type="button"
              className="ns-btn btn-ghost ns-ideal-upload-btn"
              disabled={compressing}
              onClick={() => fileRef.current?.click()}
            >
              {compressing ? "壓縮中…" : photoData ? "更換相片…" : "上傳自選相片…"}
            </button>
            {photoData && (
              <button
                type="button"
                className="ns-btn btn-text"
                onClick={() => setPhotoData(null)}
              >
                換回內建插畫
              </button>
            )}
          </div>
        </div>

        {photoData ? (
          <div className="ns-ideal-photo-preview-wrap">
            <img src={photoData} alt={title || "風景相片預覽"} className="ns-ideal-photo-preview" />
            <span className="ns-ideal-field-hint">已自動縮圖壓縮，將隨手帳端到端加密同步</span>
          </div>
        ) : (
          <div className="ns-ideal-preset-grid" role="radiogroup" aria-label="內建車窗插畫">
            {IDEAL_ART_PRESETS.map((p) => {
              const selected = artPreset === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={`ns-ideal-preset-cell${selected ? " is-on" : ""}`}
                  onClick={() => {
                    setArtPreset(p.id);
                    setArtTouched(true);
                  }}
                >
                  <IdealArtSvg preset={p.id} className="ns-ideal-preset-thumb" />
                  <span className="ns-ideal-preset-name">{p.label}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <label className="ns-ideal-check-row">
        <input
          type="checkbox"
          checked={pinned}
          onChange={(e) => setPinned(e.target.checked)}
        />
        <span>釘選為今日頁頂端的「✦ 心之所向」常駐題詞</span>
      </label>
    </form>
  );

  const footButtons = (
    <>
      <button type="button" className="ns-btn btn-ghost" onClick={onClose} disabled={saving}>
        取消
      </button>
      <button
        type="button"
        className="ns-btn btn-seal"
        disabled={saving || compressing}
        onClick={() => void handleSubmit()}
      >
        {saving ? "收錄中…" : dialog.mode === "edit" ? "存檔" : "收進手札"}
      </button>
    </>
  );

  const dialogTitle = dialog.mode === "edit" ? "編輯風景卡" : "收藏一幅終點站的風景";

  if (shell === "mobile") {
    return (
      <MSheet
        backId="core.ideal.card"
        overline="車窓・理想手札"
        title={dialogTitle}
        height="full"
        onClose={onClose}
        dismissable={!saving}
        foot={footButtons}
      >
        {formContent}
      </MSheet>
    );
  }

  return (
    <DialogShell
      size="M"
      overline={{ zh: "車窓・理想手札", latin: "Frontispiece" }}
      title={dialogTitle}
      onClose={onClose}
      foot={footButtons}
    >
      {formContent}
    </DialogShell>
  );
}
