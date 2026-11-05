// ⑨ 截止提醒（契約 docs/research/2026-11-04-主線-截止提醒-契約.md §3、§4）：JS 算好整份清單（reminders.ts buildReminderPlan），這裡只照貼。
// Kotlin 只看清單、不查資料：手機 App 沒開時排程是舊的，可能響一則別台已經做完的（契約 §3 明載、接受）。絕不寫 SQLite（Plan 技術底線 5）。
//
// - 項目（rem_items 的一格）：{ key, kind, memberKeys: [...], fireAt, expireAt, title, body, target }。target 是 JS JSON.stringify 過的字串，這裡當不透明字串。
// - 到期規則與 reminders.ts dueNow 同一條：fireAt <= now && now < expireAt。
// - arm：一次只排最近一個還沒到、還沒響、沒過期的鬧鐘（request code 700；receiver 沿用 TtReminderReceiver，用 action 分流）。
//   只排未來的：到期卻貼不出去的（沒通知權限）若也排，鬧鐘會立刻響、貼不出去、再排，繞成死迴圈。
// - fire：貼出所有到期且未過期、還沒響過的，記進 rem_fired，再排下一個。sync、鬧鐘、系統廣播都走這一支。
//
// rem_fired ＝ { members: { memberKey: at }, inbox: [ { key, kind, memberKeys, at, title, body, target } ] }：
// - inbox：響過、JS 還沒取的。rem_sync 回傳後清空，JS 記進帳本（reminder_sent）與「最近的提醒」。清單不經 sync 不會變，每項只響一次，所以 inbox 不會超過清單大小。
// - members：判「這則響過了沒」的依據，看成員不看 key。JS 的總結 key 是「kind:日:張數」（三張響過之後，同一天又來另外三張，key 一模一樣），
//   只看 key 的話這第二批永遠響不出來；看成員則同一則不重響、新的一批照響。一則的成員全部響過才算響過（沒有成員就拿 key 當成員）。
//   sync 時保留還在新清單裡的成員（JS 算清單時還不知道它響過的那個空檔，不重響），不在清單裡的交給 JS 的帳本。

package app.shitetsu.nextstop.ttnotice

import android.annotation.SuppressLint
import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

object NsReminders {
  private const val FIELD_MEMBERS = "members"
  private const val FIELD_INBOX = "inbox"

  private fun alarmManager(ctx: Context): AlarmManager? {
    return ctx.applicationContext.getSystemService(Context.ALARM_SERVICE) as AlarmManager?
  }

  private fun alarmIntent(ctx: Context): Intent {
    return Intent(ctx.applicationContext, TtReminderReceiver::class.java).setAction(TtNoticeRenderer.ACTION_NS_REMINDER)
  }

  private fun readFired(ctx: Context): JSONObject {
    val fired = TtNoticeStore.readRemFired(ctx) ?: JSONObject()
    if (fired.optJSONObject(FIELD_MEMBERS) == null) fired.put(FIELD_MEMBERS, JSONObject())
    if (fired.optJSONArray(FIELD_INBOX) == null) fired.put(FIELD_INBOX, JSONArray())
    return fired
  }

  /** 這一則的成員（「響過了沒」的單位）；JS 一定會給，缺的話拿 key 頂 */
  private fun membersOf(item: JSONObject): List<String> {
    val out = ArrayList<String>()
    val arr = item.optJSONArray("memberKeys")
    if (arr != null) {
      for (i in 0 until arr.length()) {
        val m = arr.optString(i, "")
        if (m.isNotEmpty()) out.add(m)
      }
    }
    if (out.isEmpty()) out.add(item.optString("key", ""))
    return out
  }

  private fun alreadyFired(item: JSONObject, members: JSONObject): Boolean {
    return membersOf(item).all { members.has(it) }
  }

  /**
   * 存 JS 算好的清單 → 貼已經到期的 → 排下一個。itemsJson 不是 JSON 陣列 ⇒ 回 false、什麼都不動。
   * 到期的在這裡直接貼，不靠排一個過去時刻的鬧鐘：這樣同一趟 rem_sync 回傳的 fired 就帶得到，JS 馬上記帳。
   */
  fun sync(ctx: Context, itemsJson: String): Boolean {
    val app = ctx.applicationContext
    val items = try {
      JSONArray(itemsJson)
    } catch (_: JSONException) {
      return false
    }
    synchronized(TtNoticeStore.lock) {
      TtNoticeStore.writeRemItems(app, items)
      val fired = readFired(app)
      val members = fired.getJSONObject(FIELD_MEMBERS)
      val keep = JSONObject()
      for (i in 0 until items.length()) {
        val item = items.optJSONObject(i) ?: continue
        for (m in membersOf(item)) {
          if (members.has(m)) keep.put(m, members.optLong(m))
        }
      }
      fired.put(FIELD_MEMBERS, keep)
      TtNoticeStore.writeRemFired(app, fired)
      fire(app)
    }
    return true
  }

  /** 排最近一個還沒到、還沒響、沒過期的鬧鐘；沒有 ⇒ 取消 */
  @SuppressLint("MissingPermission", "ScheduleExactAlarm")
  fun arm(ctx: Context) {
    val app = ctx.applicationContext
    val now = System.currentTimeMillis()
    var next = Long.MAX_VALUE
    synchronized(TtNoticeStore.lock) {
      val items = TtNoticeStore.readRemItems(app)
      val members = readFired(app).getJSONObject(FIELD_MEMBERS)
      for (i in 0 until items.length()) {
        val item = items.optJSONObject(i) ?: continue
        val fireAt = item.optLong("fireAt", 0L)
        if (fireAt > now && fireAt < next && now < item.optLong("expireAt", 0L) && !alreadyFired(item, members)) next = fireAt
      }
    }
    if (next == Long.MAX_VALUE) {
      disarm(app)
      return
    }
    val am = alarmManager(app) ?: return
    val pi = PendingIntent.getBroadcast(app, TtNoticeRenderer.RC_NS_REMINDER_ALARM, alarmIntent(app), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    try {
      if (TtReminder.canExact(app)) {
        am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next, pi)
      } else {
        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next, pi)
      }
    } catch (_: SecurityException) {
      // 判斷與排之間權限被收回（API 31–32 使用者可撤 SCHEDULE_EXACT_ALARM）：退回不精準
      am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next, pi)
    }
  }

  /** 取消鬧鐘（不動 SharedPreferences、不收畫面上的通知） */
  fun disarm(ctx: Context) {
    val app = ctx.applicationContext
    val am = alarmManager(app) ?: return
    val pi = PendingIntent.getBroadcast(app, TtNoticeRenderer.RC_NS_REMINDER_ALARM, alarmIntent(app), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_NO_CREATE)
    if (pi != null) {
      am.cancel(pi)
      pi.cancel()
    }
  }

  /**
   * 鬧鐘到（或 sync、開機後補）：貼到期的、記 fired、排下一個。
   * 整段持鎖：receiver 在主執行緒、@Command 在 JNI 執行緒，「查沒響過 → 貼 → 記」不一氣呵成就可能同一則貼兩次。
   */
  fun fire(ctx: Context) {
    val app = ctx.applicationContext
    synchronized(TtNoticeStore.lock) {
      postDue(app, System.currentTimeMillis())
      arm(app)
    }
  }

  /** 開機、更新、改時間、改時區（TtSystemReceiver）：重排並貼出到期的 */
  fun onSystemEvent(ctx: Context) {
    fire(ctx)
  }

  /**
   * 通知送不出去（權限被關、「提醒」頻道被關）就不標 fired：標了之後權限回來也不會再響，帳本還會記成響過，
   * 「最近的提醒」與誤點「只響一次」都會是假的；留著的話權限回來後，還沒過期的下一次 fire 照響，過期的本來就不補。
   */
  private fun postDue(app: Context, now: Long) {
    val items = TtNoticeStore.readRemItems(app)
    val fired = readFired(app)
    val members = fired.getJSONObject(FIELD_MEMBERS)
    val inbox = fired.getJSONArray(FIELD_INBOX)
    var checked = false
    var changed = false
    for (i in 0 until items.length()) {
      val item = items.optJSONObject(i) ?: continue
      val key = item.optString("key", "")
      if (key.isEmpty()) continue
      if (item.optLong("fireAt", Long.MAX_VALUE) > now || now >= item.optLong("expireAt", 0L)) continue
      if (alreadyFired(item, members)) continue
      if (!checked) {
        if (!TtNoticeRenderer.canPostNsReminder(app)) return
        checked = true
      }
      val title = item.optString("title", "")
      val body = item.optString("body", "")
      val target = item.optString("target", "")
      if (!TtNoticeRenderer.postNsReminder(app, key, title, body, target)) break
      for (m in membersOf(item)) members.put(m, now)
      inbox.put(
        JSONObject()
          .put("key", key)
          .put("kind", item.optString("kind", ""))
          .put("memberKeys", JSONArray(membersOf(item)))
          .put("at", now)
          .put("title", title)
          .put("body", body)
          .put("target", target),
      )
      changed = true
    }
    if (changed) TtNoticeStore.writeRemFired(app, fired)
  }

  /** 取走 inbox（rem_sync 回傳用）；members 留著 */
  fun takeFired(ctx: Context): JSONArray {
    val app = ctx.applicationContext
    synchronized(TtNoticeStore.lock) {
      val fired = readFired(app)
      val inbox = fired.getJSONArray(FIELD_INBOX)
      if (inbox.length() > 0) {
        fired.put(FIELD_INBOX, JSONArray())
        TtNoticeStore.writeRemFired(app, fired)
      }
      return inbox
    }
  }
}
