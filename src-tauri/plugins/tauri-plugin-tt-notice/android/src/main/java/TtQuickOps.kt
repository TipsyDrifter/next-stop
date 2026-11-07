// ⑬ 外部入口：不開 App 的発車與到着（樂觀更新＋待處理佇列＋提醒重排）。原本是 TtActionReceiver 的本體，
// 抽出來讓通知上的格子、主畫面小工具、NFC 貼紙走同一條路：動作先進佇列（SharedPreferences "pending"），
// 畫面當場換成新的樣子（不等 JS），App 活著就叫 JS（TtNoticePlugin.notifyPending ⇒ ttOnPending ⇒ drainPending("event")），
// App 沒開就等回前景／冷啟動時套。絕不寫 SQLite。
//
// 不看 state.enabled：常駐通知關著，小工具與貼紙還是要能按（TtNoticeRenderer.render 在 disabled 時本來就會收掉通知）。

package app.shitetsu.nextstop.ttnotice

import android.content.Context
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID

object TtQuickOps {
  /** 合成一格（貼紙上的分類還沒進過任何格子）用的顏色：＝timetableNotice.ts CAT_PALETTE 第 8 色 */
  const val FALLBACK_COLOR_LIGHT = "#5c5b7d"
  const val FALLBACK_COLOR_DARK = "#a3a9b8"

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

  /** 貼紙帶的分類名（name）：這個分類不在任何格子裡時，至少畫得出名字與圓牌。發車後 JS 套佇列時會換回真的（分類不在了就丟掉，由 JS 講一句） */
  private fun synthTile(categoryId: String, name: String): JSONObject {
    return JSONObject()
      .put("categoryId", categoryId)
      .put("name", name)
      .put("glyph", name.substring(0, name.offsetByCodePoints(0, 1)))
      .put("colorLight", FALLBACK_COLOR_LIGHT)
      .put("colorDark", FALLBACK_COLOR_DARK)
      .put("thresholdMin", JSONObject.NULL)
      .put("reminderTitle", JSONObject.NULL)
  }

  /** 找這一格：常駐通知的格子 → 小工具的格子（兩份不一定一樣多）→ 有名字就合成 */
  private fun resolveTile(ctx: Context, st: JSONObject, categoryId: String, name: String?): JSONObject? {
    return findTile(st, categoryId)
      ?: NsWidgetStore.findTile(ctx, categoryId)
      ?: if (name.isNullOrEmpty()) null else synthTile(categoryId, name)
  }

  /**
   * TILE：同分類正在跑 ⇒ 只重貼。否則追加 depart、state.running 換成這一格（id＝"pending:<actionId>"、startedAt＝按下那一刻）、
   * reminder 依這格的門檻重排（跑太久提醒關掉或沒有門檻 ⇒ 刪）。找不到這一格（PendingIntent 過期）⇒ 只重貼。
   * name＝只有貼紙會帶的分類名。回新的 running；沒有發車（已在跑、找不到格子、App 從沒開過）回 null。
   */
  fun tile(ctx: Context, categoryId: String?, name: String? = null): JSONObject? {
    var count = -1
    var departed: JSONObject? = null
    if (!categoryId.isNullOrEmpty()) {
      synchronized(TtNoticeStore.lock) {
        val st = TtNoticeStore.readState(ctx)
        val running = st?.optJSONObject("running")
        val tile = if (st != null) resolveTile(ctx, st, categoryId, name) else null
        if (st != null && tile != null &&
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
          departed = next

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
    return departed
  }

  /** ARRIVE：沒有運行中 ⇒ 只重貼。否則追加 arrive、state.running＝null、刪提醒、畫成停車中。回有沒有到着 */
  fun arrive(ctx: Context): Boolean {
    var count = -1
    synchronized(TtNoticeStore.lock) {
      val st = TtNoticeStore.readState(ctx)
      val running = st?.optJSONObject("running")
      if (st != null && running != null) {
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
    return count >= 0
  }
}
