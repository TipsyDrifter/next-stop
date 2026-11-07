// 時刻表 ①c：通知上的格子／到着／滑掉（①b①c 契約 §5.10.6–§5.10.7）；⑬ 起主畫面小工具的按鈕也送到這裡。
// 格子與到着的本體在 TtQuickOps（NFC 貼紙也走它）。
// 不開 App（Android 12 trampoline 限制）、不 goAsync（全部是同步的小動作）、絕不寫 SQLite。

package app.shitetsu.nextstop.ttnotice

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class TtActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val ctx = context.applicationContext
    when (intent.action) {
      TtNoticeRenderer.ACTION_TILE -> TtQuickOps.tile(ctx, intent.getStringExtra(TtNoticeRenderer.EXTRA_CATEGORY))
      TtNoticeRenderer.ACTION_ARRIVE -> TtQuickOps.arrive(ctx)
      TtNoticeRenderer.ACTION_DISMISSED -> onDismissed(ctx)
    }
  }

  /** DISMISSED（Android 14+ 使用者可滑掉 ongoing）：還開著就貼回來（〈開工決定〉三-4） */
  private fun onDismissed(ctx: Context) {
    val st = TtNoticeStore.readState(ctx)
    if (st != null && st.optBoolean("enabled", false)) TtNoticeRenderer.render(ctx)
  }
}
