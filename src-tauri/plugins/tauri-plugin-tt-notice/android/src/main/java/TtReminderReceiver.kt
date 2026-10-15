// 時刻表 ①c：跑太久提醒的鬧鐘到了（①b①c 契約 §5.10.7 REMINDER）。條件判斷都在 TtReminder.fire。
// 不 goAsync、絕不寫 SQLite。

package app.shitetsu.nextstop.ttnotice

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class TtReminderReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != TtNoticeRenderer.ACTION_REMINDER) return
    TtReminder.fire(context.applicationContext)
  }
}
