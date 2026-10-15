// 時刻表 ①c：自己的精準鬧鐘「跑太久提醒」（①b①c 契約 §5.10.7、0-4）。
// - arm：讀 SharedPreferences 的 reminder；API < 31 或 canScheduleExactAlarms() ⇒ setExactAndAllowWhileIdle，
//   否則 setAndAllowWhileIdle（提醒可能晚幾分鐘；走哪條由 status().exactAlarm 回給 JS）。
//   權限：API 33+ USE_EXACT_ALARM（安裝即授予）、API 31–32 SCHEDULE_EXACT_ALARM（maxSdkVersion 32），見 plugin 的 manifest。
// - 鬧鐘的 PendingIntent 指向本 plugin 的 TtReminderReceiver（request code 500）；
//   舊的 tauri-plugin-notification 2.3.3 排過的 72502 鬧鐘由 JS 在第一次 post 前一次性收掉（契約 0-7）。
// - fire：已響過、運行中已不是這一班、跑太久提醒關掉 ⇒ 不貼；否則貼 72502、設 fired=true（同一班只響一次，重開機不補第二次）。

package app.shitetsu.nextstop.ttnotice

import android.annotation.SuppressLint
import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import org.json.JSONObject

object TtReminder {
  private fun alarmManager(ctx: Context): AlarmManager? {
    return ctx.applicationContext.getSystemService(Context.ALARM_SERVICE) as AlarmManager?
  }

  private fun alarmIntent(ctx: Context): Intent {
    return Intent(ctx.applicationContext, TtReminderReceiver::class.java).setAction(TtNoticeRenderer.ACTION_REMINDER)
  }

  /** 現在排得了精準鬧鐘嗎（status().exactAlarm） */
  fun canExact(ctx: Context): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
    val am = alarmManager(ctx) ?: return false
    return am.canScheduleExactAlarms()
  }

  /** 依存著的 reminder 排鬧鐘；沒有、已響過、時刻不合法 ⇒ 取消鬧鐘 */
  @SuppressLint("MissingPermission", "ScheduleExactAlarm")
  fun arm(ctx: Context) {
    val app = ctx.applicationContext
    val r = TtNoticeStore.readReminder(app)
    val fireAt = r?.optLong("fireAt", 0L) ?: 0L
    if (r == null || r.optBoolean("fired", false) || fireAt <= 0L) {
      disarm(app)
      return
    }
    val am = alarmManager(app) ?: return
    val pi = PendingIntent.getBroadcast(app, TtNoticeRenderer.RC_REMINDER_ALARM, alarmIntent(app), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    try {
      if (canExact(app)) {
        am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, fireAt, pi)
      } else {
        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, fireAt, pi)
      }
    } catch (_: SecurityException) {
      // 判斷與排之間權限被收回（API 31–32 使用者可撤 SCHEDULE_EXACT_ALARM）：退回不精準
      am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, fireAt, pi)
    }
  }

  /** 取消鬧鐘（不動 SharedPreferences、不收畫面上的 72502） */
  fun disarm(ctx: Context) {
    val app = ctx.applicationContext
    val am = alarmManager(app) ?: return
    val pi = PendingIntent.getBroadcast(app, TtNoticeRenderer.RC_REMINDER_ALARM, alarmIntent(app), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_NO_CREATE)
    if (pi != null) {
      am.cancel(pi)
      pi.cancel()
    }
  }

  /** 鬧鐘到（或開機後補）：條件都成立才貼 72502，並設 fired=true */
  fun fire(ctx: Context) {
    val app = ctx.applicationContext
    var toPost: Pair<JSONObject, JSONObject>? = null
    synchronized(TtNoticeStore.lock) {
      val r = TtNoticeStore.readReminder(app)
      val st = TtNoticeStore.readState(app)
      val run = st?.optJSONObject("running")
      if (r != null && st != null && run != null &&
        !r.optBoolean("fired", false) &&
        st.optBoolean("longRunEnabled", true) &&
        run.optString("id", "") == r.optString("blockId", "\u0000")
      ) {
        r.put("fired", true)
        TtNoticeStore.writeReminder(app, r)
        toPost = Pair(r, st)
      }
    }
    val p = toPost ?: return
    TtNoticeRenderer.postReminder(app, p.first, p.second)
  }
}
