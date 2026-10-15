// 時刻表 ①c：開機／App 更新／改時間／改時區 ⇒ 重貼常駐通知＋重排提醒（①b①c 契約 §5.10.7 系統廣播）。
// - state.enabled ⇒ render（Chronometer 的 base 依新的 elapsedRealtime 重算，秒數才對）。
// - reminder 存在且未響：fireAt 還沒到 ⇒ arm；已過（重開機期間錯過）⇒ 立刻 fire（fire 自己判「運行中仍是它」）。
// 不收 LOCKED_BOOT_COMPLETED（manifest 沒宣告）：SharedPreferences 在解鎖前讀不到；保險起見這裡也判一次解鎖。
// 不 goAsync、絕不寫 SQLite。

package app.shitetsu.nextstop.ttnotice

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.UserManager

class TtSystemReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    when (intent.action) {
      Intent.ACTION_BOOT_COMPLETED,
      Intent.ACTION_MY_PACKAGE_REPLACED,
      Intent.ACTION_TIME_CHANGED,
      Intent.ACTION_TIMEZONE_CHANGED -> Unit
      else -> return
    }
    val ctx = context.applicationContext
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      val um = ctx.getSystemService(UserManager::class.java)
      if (um != null && !um.isUserUnlocked) return
    }
    val st = TtNoticeStore.readState(ctx)
    if (st != null && st.optBoolean("enabled", false)) TtNoticeRenderer.render(ctx)

    val r = TtNoticeStore.readReminder(ctx) ?: return
    if (r.optBoolean("fired", false)) return
    if (r.optLong("fireAt", 0L) > System.currentTimeMillis()) TtReminder.arm(ctx) else TtReminder.fire(ctx)
  }
}
