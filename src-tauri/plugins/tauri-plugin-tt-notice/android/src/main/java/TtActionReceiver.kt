// 時刻表 ①c：通知上的格子／到着／滑掉（①b①c 契約 §5.10.6–§5.10.7）。
// 樂觀更新：先把動作追加進佇列（SharedPreferences "pending"），通知當場換成新的樣子（不等 JS），
// App 活著就叫 JS（TtNoticePlugin.notifyPending ⇒ ttOnPending ⇒ drainPending("event")）；App 沒開就等回前景／冷啟動時套。
// 不開 App（Android 12 trampoline 限制）、不 goAsync（全部是同步的小動作）、絕不寫 SQLite。

package app.shitetsu.nextstop.ttnotice

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID

class TtActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val ctx = context.applicationContext
    when (intent.action) {
      TtNoticeRenderer.ACTION_TILE -> onTile(ctx, intent.getStringExtra(TtNoticeRenderer.EXTRA_CATEGORY))
      TtNoticeRenderer.ACTION_ARRIVE -> onArrive(ctx)
      TtNoticeRenderer.ACTION_DISMISSED -> onDismissed(ctx)
    }
  }

  private fun hhmm(ms: Long): String {
    return SimpleDateFormat("HH:mm", Locale.US).format(Date(ms))
  }

  private fun findTile(st: JSONObject, categoryId: String): JSONObject? {
    val tiles = st.optJSONArray("tiles") ?: return null
    for (i in 0 until tiles.length()) {
      val t = tiles.optJSONObject(i) ?: continue
      if (t.optString("categoryId", "") == categoryId) return t
    }
    return null
  }

  /**
   * TILE：同分類正在跑 ⇒ 只重貼。否則追加 depart、state.running 換成這一格（id＝"pending:<actionId>"、startedAt＝按下那一刻）、
   * reminder 依這格的門檻重排（跑太久提醒關掉或沒有門檻 ⇒ 刪）。找不到這一格（PendingIntent 過期）⇒ 只重貼。
   */
  private fun onTile(ctx: Context, categoryId: String?) {
    var count = -1
    if (!categoryId.isNullOrEmpty()) {
      synchronized(TtNoticeStore.lock) {
        val st = TtNoticeStore.readState(ctx)
        val running = st?.optJSONObject("running")
        val tile = if (st != null) findTile(st, categoryId) else null
        if (st != null && st.optBoolean("enabled", false) && tile != null &&
          (running == null || running.optString("categoryId", "") != categoryId)
        ) {
          val now = System.currentTimeMillis()
          val actionId = UUID.randomUUID().toString()
          val action = JSONObject()
            .put("id", actionId)
            .put("kind", "depart")
            .put("categoryId", categoryId)
            .put("at", now)
            .put("expectRunningId", if (running != null) running.optString("id", "") else JSONObject.NULL)
          count = TtNoticeStore.appendPending(ctx, action)

          val text = st.optJSONObject("text")
          val suffix = text?.optString("startedSuffix", " 発") ?: " 発"
          val startedLabel = hhmm(now) + suffix
          val pendingId = "pending:$actionId"
          val next = JSONObject(tile.toString())
            .put("id", pendingId)
            .put("startedAt", now)
            .put("startedLabel", startedLabel)
            .put("subText", tile.optString("name", "") + "・" + startedLabel)
            .put("estimateText", JSONObject.NULL) // 剛在通知上發車：還沒有預估
          st.put("running", next)
          TtNoticeStore.writeState(ctx, st)

          val th = if (tile.has("thresholdMin") && !tile.isNull("thresholdMin")) tile.optLong("thresholdMin", 0L) else 0L
          val title = if (tile.has("reminderTitle") && !tile.isNull("reminderTitle")) tile.optString("reminderTitle", "") else ""
          if (st.optBoolean("longRunEnabled", true) && th > 0L && title.isNotEmpty()) {
            TtNoticeStore.writeReminder(
              ctx,
              JSONObject()
                .put("blockId", pendingId)
                .put("fireAt", now + th * 60_000L)
                .put("title", title)
                .put("body", text?.optString("reminderBody", "") ?: "")
                .put("fired", false),
            )
          } else {
            TtNoticeStore.writeReminder(ctx, null)
          }
        }
      }
    }
    TtNoticeRenderer.render(ctx)
    if (count >= 0) {
      TtReminder.arm(ctx)
      TtNoticeRenderer.cancelReminderNotice(ctx) // 上一班的「跑太久」已經不相干
      TtNoticePlugin.notifyPending(count)
    }
  }

  /** ARRIVE：沒有運行中 ⇒ 只重貼。否則追加 arrive、state.running＝null、刪提醒、畫成停車中 */
  private fun onArrive(ctx: Context) {
    var count = -1
    synchronized(TtNoticeStore.lock) {
      val st = TtNoticeStore.readState(ctx)
      val running = st?.optJSONObject("running")
      if (st != null && st.optBoolean("enabled", false) && running != null) {
        val action = JSONObject()
          .put("id", UUID.randomUUID().toString())
          .put("kind", "arrive")
          .put("categoryId", JSONObject.NULL)
          .put("at", System.currentTimeMillis())
          .put("expectRunningId", running.optString("id", ""))
        count = TtNoticeStore.appendPending(ctx, action)
        st.put("running", JSONObject.NULL)
        TtNoticeStore.writeState(ctx, st)
        TtNoticeStore.writeReminder(ctx, null)
      }
    }
    TtNoticeRenderer.render(ctx)
    if (count >= 0) {
      TtReminder.disarm(ctx)
      TtNoticeRenderer.cancelReminderNotice(ctx)
      TtNoticePlugin.notifyPending(count)
    }
  }

  /** DISMISSED（Android 14+ 使用者可滑掉 ongoing）：還開著就貼回來（〈開工決定〉三-4） */
  private fun onDismissed(ctx: Context) {
    val st = TtNoticeStore.readState(ctx)
    if (st != null && st.optBoolean("enabled", false)) TtNoticeRenderer.render(ctx)
  }
}
