// 時刻表 ①c：跑太久提醒的鬧鐘到了（①b①c 契約 §5.10.7 REMINDER）。條件判斷都在 TtReminder.fire。
// ⑨ 截止提醒的鬧鐘也走這支（同樣只是「鬧鐘到了」，manifest 不必多一個 receiver），用 action 分流；判斷都在 NsReminders.fire。
// 不 goAsync、絕不寫 SQLite。

package app.shitetsu.nextstop.ttnotice

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class TtReminderReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    when (intent.action) {
      TtNoticeRenderer.ACTION_REMINDER -> TtReminder.fire(context.applicationContext)
      TtNoticeRenderer.ACTION_NS_REMINDER -> NsReminders.fire(context.applicationContext)
    }
  }
}
