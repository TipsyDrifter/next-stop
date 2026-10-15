// 時刻表 ①c：常駐通知 72501 與跑太久提醒 72502 的畫法（①b①c 契約 §5.10.5–§5.10.6；長相照原型情境 1）。
//
// - 72501（頻道 timetable-running-v2、IMPORTANCE_DEFAULT＋頻道靜音）：DecoratedCustomViewStyle＋自訂收合／展開版面。
//   收合（D-時-31）＝左邊縮小的跳秒＋分類名、右邊一排常用分類格（運行中那格亮、D-時-32），**沒有到着**；
//   格子關掉（tilesEnabled=false）時收合改畫運行那一列（圓牌＋分類＋「14:35 発」＋跳秒＋到着，＝原型「格子關掉」的樣子）。
//   展開＝運行那一列（到着在這裡）＋一排帶名稱的格子。停車中也留著（契約 0-9）；state.enabled=false ⇒ 收掉。
//   系統標題列也跳秒：setUsesChronometer＋setWhen(startedAt)（不每秒重貼）；subText＝「創作・14:35 発」。
//   鎖屏：VISIBILITY_PRIVATE＋只有「時刻表・運行中／停車中」一行的 publicVersion（D-時-29）。
// - 72502（頻道 timetable-long-run、IMPORTANCE_DEFAULT）：TtReminder.fire 叫 postReminder；點了開 App 並帶 tt_ask。
// - 同 id 接手 tauri-plugin-notification 2.3.3 以前貼的那兩則（契約 0-7）：通知 id 是全 App 共用的命名空間，
//   這裡一貼 72501 就直接取代舊的。72502 沿用 ①a 的頻道 timetable-long-run；72501 改用新頻道 timetable-running-v2
//   （既有頻道的 importance 不能從程式往上調，只能換 id），①a 的舊頻道 timetable-running 在 ensureChannels 刪掉。
// - PendingIntent 一律 FLAG_IMMUTABLE；要換 extras 的加 FLAG_UPDATE_CURRENT（§5.10.6 的 request code 表）。
//   按鈕都是 getBroadcast、不開 App（Android 12 trampoline 限制：receiver 裡不准 startActivity）。
//
// 分類色：state 裡每格都帶 colorLight／colorDark（＝timetable.css §A），依系統深淺色挑；系統換深淺色後等下一次重貼才換（已知、接受）。

package app.shitetsu.nextstop.ttnotice

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.os.Build
import android.os.SystemClock
import android.view.View
import android.widget.RemoteViews
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONArray
import org.json.JSONObject

object TtNoticeRenderer {
  const val NOTICE_ID = 72501
  const val REMINDER_ID = 72502
  /** 72501 的頻道（2026-10-14 換 v2：IMPORTANCE_DEFAULT＋頻道靜音；舊的 LOW 頻道在 HyperOS 鎖屏不顯示，決策記錄偏差段） */
  const val CHANNEL_RUNNING = "timetable-running-v2"
  /** ①a 建的舊頻道（IMPORTANCE_LOW）；既有頻道的 importance 不能從程式往上調，只能換 id，舊的在 ensureChannels 刪 */
  const val CHANNEL_RUNNING_LEGACY = "timetable-running"
  const val CHANNEL_LONG_RUN = "timetable-long-run"

  const val ACTION_TILE = "app.shitetsu.nextstop.ttnotice.TILE"
  const val ACTION_ARRIVE = "app.shitetsu.nextstop.ttnotice.ARRIVE"
  const val ACTION_DISMISSED = "app.shitetsu.nextstop.ttnotice.DISMISSED"
  const val ACTION_REMINDER = "app.shitetsu.nextstop.ttnotice.REMINDER"

  const val EXTRA_CATEGORY = "categoryId"
  const val EXTRA_OPEN = "tt_open"
  const val EXTRA_ASK = "tt_ask"

  /** §5.10.6 的 request code */
  const val RC_TILE = 100
  const val RC_ARRIVE = 200
  const val RC_DISMISSED = 300
  const val RC_OPEN = 400
  const val RC_REMINDER_ALARM = 500
  const val RC_REMINDER_OPEN = 600

  const val MAX_TILES = 5

  private const val FALLBACK_COLOR = "#5c5b7d"

  private class TileIds(val root: Int, val on: Int, val bg: Int, val glyph: Int, val dot: Int, val name: Int?)
  private class TopIds(val badgeBg: Int, val glyph: Int, val name: Int, val started: Int, val chrono: Int, val arrive: Int)

  private val collapsedTiles: Array<TileIds> by lazy {
    arrayOf(
      TileIds(R.id.tt_c_tile_0, R.id.tt_c_tile_on_0, R.id.tt_c_tile_bg_0, R.id.tt_c_tile_glyph_0, R.id.tt_c_tile_dot_0, null),
      TileIds(R.id.tt_c_tile_1, R.id.tt_c_tile_on_1, R.id.tt_c_tile_bg_1, R.id.tt_c_tile_glyph_1, R.id.tt_c_tile_dot_1, null),
      TileIds(R.id.tt_c_tile_2, R.id.tt_c_tile_on_2, R.id.tt_c_tile_bg_2, R.id.tt_c_tile_glyph_2, R.id.tt_c_tile_dot_2, null),
      TileIds(R.id.tt_c_tile_3, R.id.tt_c_tile_on_3, R.id.tt_c_tile_bg_3, R.id.tt_c_tile_glyph_3, R.id.tt_c_tile_dot_3, null),
      TileIds(R.id.tt_c_tile_4, R.id.tt_c_tile_on_4, R.id.tt_c_tile_bg_4, R.id.tt_c_tile_glyph_4, R.id.tt_c_tile_dot_4, null),
    )
  }

  private val expandedTiles: Array<TileIds> by lazy {
    arrayOf(
      TileIds(R.id.tt_e_tile_0, R.id.tt_e_tile_on_0, R.id.tt_e_tile_bg_0, R.id.tt_e_tile_glyph_0, R.id.tt_e_tile_dot_0, R.id.tt_e_tile_name_0),
      TileIds(R.id.tt_e_tile_1, R.id.tt_e_tile_on_1, R.id.tt_e_tile_bg_1, R.id.tt_e_tile_glyph_1, R.id.tt_e_tile_dot_1, R.id.tt_e_tile_name_1),
      TileIds(R.id.tt_e_tile_2, R.id.tt_e_tile_on_2, R.id.tt_e_tile_bg_2, R.id.tt_e_tile_glyph_2, R.id.tt_e_tile_dot_2, R.id.tt_e_tile_name_2),
      TileIds(R.id.tt_e_tile_3, R.id.tt_e_tile_on_3, R.id.tt_e_tile_bg_3, R.id.tt_e_tile_glyph_3, R.id.tt_e_tile_dot_3, R.id.tt_e_tile_name_3),
      TileIds(R.id.tt_e_tile_4, R.id.tt_e_tile_on_4, R.id.tt_e_tile_bg_4, R.id.tt_e_tile_glyph_4, R.id.tt_e_tile_dot_4, R.id.tt_e_tile_name_4),
    )
  }

  private val collapsedTop: TopIds by lazy {
    TopIds(R.id.tt_c_top_badge_bg, R.id.tt_c_top_glyph, R.id.tt_c_top_name, R.id.tt_c_top_started, R.id.tt_c_top_chrono, R.id.tt_c_top_arrive)
  }

  private val expandedTop: TopIds by lazy {
    TopIds(R.id.tt_e_badge_bg, R.id.tt_e_glyph, R.id.tt_e_name, R.id.tt_e_started, R.id.tt_e_chrono, R.id.tt_e_arrive)
  }

  /* ───────── 頻道 ───────── */

  /**
   * 兩個頻道都建（receiver 在 JS 沒跑時也要能建，名稱讀 tt_strings.xml），建好再刪掉 ①a 的舊頻道 timetable-running。
   * 每次貼之前都叫、可重複叫：createNotificationChannel 對已存在的頻道只改名稱／說明；舊頻道只在還在時才刪。
   * 刪舊頻道會一併收掉貼在它上面的 72501（系統行為），呼叫端緊接著就用新頻道重貼，所以先建新、後刪舊。
   */
  fun ensureChannels(ctx: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = ctx.getSystemService(NotificationManager::class.java) ?: return
    // DEFAULT 才上得了 HyperOS 鎖屏（LOW 不顯示）；DEFAULT 預設有聲音，所以頻道上明確關掉聲音與震動。
    // DEFAULT 本來就不 heads-up（要 HIGH 才跳橫幅）。
    val running = NotificationChannel(CHANNEL_RUNNING, ctx.getString(R.string.tt_channel_running), NotificationManager.IMPORTANCE_DEFAULT)
    running.setShowBadge(false)
    running.enableVibration(false)
    running.setSound(null, null)
    running.enableLights(false)
    running.lockscreenVisibility = Notification.VISIBILITY_PRIVATE
    nm.createNotificationChannel(running)
    try {
      if (nm.getNotificationChannel(CHANNEL_RUNNING_LEGACY) != null) nm.deleteNotificationChannel(CHANNEL_RUNNING_LEGACY)
    } catch (_: RuntimeException) {
      // 刪不掉只會在系統設定頁多一個舊頻道，不影響貼通知
    }
    val longRun = NotificationChannel(CHANNEL_LONG_RUN, ctx.getString(R.string.tt_channel_long_run), NotificationManager.IMPORTANCE_DEFAULT)
    longRun.lockscreenVisibility = Notification.VISIBILITY_PRIVATE
    nm.createNotificationChannel(longRun)
  }

  /* ───────── 小工具 ───────── */

  private fun isNight(ctx: Context): Boolean {
    val mode = ctx.applicationContext.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK
    return mode == Configuration.UI_MODE_NIGHT_YES
  }

  /** 一格或運行中那班的分類色（colorLight／colorDark）；壞值＝色盤第 8 色 */
  private fun colorOf(o: JSONObject, night: Boolean): Int {
    val raw = o.optString(if (night) "colorDark" else "colorLight", FALLBACK_COLOR)
    return try {
      Color.parseColor(raw)
    } catch (_: IllegalArgumentException) {
      Color.parseColor(FALLBACK_COLOR)
    }
  }

  /** 字串欄位：沒有或是 JSON null ⇒ fallback */
  private fun str(o: JSONObject?, key: String, fallback: String): String {
    if (o == null || !o.has(key) || o.isNull(key)) return fallback
    return o.optString(key, fallback)
  }

  /** 開 App 的 Intent（點通知本體／點提醒）；找不到 launch intent ⇒ null（就不掛 contentIntent） */
  private fun launchIntent(ctx: Context): Intent? {
    val i = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName) ?: return null
    i.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
    return i
  }

  private fun tilePi(ctx: Context, slot: Int, categoryId: String): PendingIntent {
    val i = Intent(ctx, TtActionReceiver::class.java).setAction(ACTION_TILE).putExtra(EXTRA_CATEGORY, categoryId)
    return PendingIntent.getBroadcast(ctx, RC_TILE + slot, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  private fun arrivePi(ctx: Context): PendingIntent {
    val i = Intent(ctx, TtActionReceiver::class.java).setAction(ACTION_ARRIVE)
    return PendingIntent.getBroadcast(ctx, RC_ARRIVE, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  private fun dismissPi(ctx: Context): PendingIntent {
    val i = Intent(ctx, TtActionReceiver::class.java).setAction(ACTION_DISMISSED)
    return PendingIntent.getBroadcast(ctx, RC_DISMISSED, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  private fun openPi(ctx: Context): PendingIntent? {
    val i = launchIntent(ctx) ?: return null
    i.putExtra(EXTRA_OPEN, true)
    return PendingIntent.getActivity(ctx, RC_OPEN, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  private fun askPi(ctx: Context, blockId: String): PendingIntent? {
    val i = launchIntent(ctx) ?: return null
    i.putExtra(EXTRA_ASK, blockId)
    return PendingIntent.getActivity(ctx, RC_REMINDER_OPEN, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  /** Chronometer 的 base：elapsedRealtime 換算（開機時間軸），改時間／重開機後重貼時重算（可行性報告 §1.1 的算法） */
  private fun chronoBase(startedAt: Long): Long {
    return SystemClock.elapsedRealtime() - (System.currentTimeMillis() - startedAt)
  }

  /* ───────── 72501 ───────── */

  /**
   * 依存著的 state 貼或收 72501。沒有 state 或 enabled=false ⇒ 收；沒有通知權限 ⇒ 不貼（last_render="denied@…"）。
   * 每次都從版面重新 inflate RemoteViews，不留上一次的殘值。
   */
  @SuppressLint("MissingPermission")
  fun render(ctx: Context) {
    val app = ctx.applicationContext
    val nm = NotificationManagerCompat.from(app)
    val now = System.currentTimeMillis()
    val st = TtNoticeStore.readState(app)
    if (st == null || !st.optBoolean("enabled", false)) {
      nm.cancel(NOTICE_ID)
      TtNoticeStore.setLastRender(app, "off@$now")
      return
    }
    if (!nm.areNotificationsEnabled()) {
      TtNoticeStore.setLastRender(app, "denied@$now")
      return
    }
    ensureChannels(app)
    val running = st.optJSONObject("running")
    val n = build(app, st, running)
    try {
      nm.notify(NOTICE_ID, n)
      TtNoticeStore.setLastRender(app, if (running != null) "running:${str(running, "id", "")}@$now" else "idle@$now")
    } catch (_: SecurityException) {
      TtNoticeStore.setLastRender(app, "denied@$now")
    }
  }

  /** 收 72501（「運行中顯示」關掉） */
  fun cancel(ctx: Context) {
    NotificationManagerCompat.from(ctx.applicationContext).cancel(NOTICE_ID)
    TtNoticeStore.setLastRender(ctx, "off@${System.currentTimeMillis()}")
  }

  private fun build(ctx: Context, st: JSONObject, running: JSONObject?): Notification {
    val night = isNight(ctx)
    val text = st.optJSONObject("text")
    val idleTitle = str(text, "idleTitle", ctx.getString(R.string.tt_idle_title))
    val tiles = st.optJSONArray("tiles") ?: JSONArray()
    val tilesOn = st.optBoolean("tilesEnabled", true) && tiles.length() > 0
    val runCat = if (running != null) str(running, "categoryId", "") else null

    val collapsed = RemoteViews(ctx.packageName, R.layout.tt_notice_collapsed)
    val expanded = RemoteViews(ctx.packageName, R.layout.tt_notice_expanded)

    // 格子（收合與展開同一個 PendingIntent：request code 100+N）
    for (i in 0 until MAX_TILES) {
      val t = if (tilesOn && i < tiles.length()) tiles.optJSONObject(i) else null
      bindTile(ctx, collapsed, collapsedTiles[i], t, runCat, night, i)
      bindTile(ctx, expanded, expandedTiles[i], t, runCat, night, i)
    }
    collapsed.setViewVisibility(R.id.tt_c_tiles, if (tilesOn) View.VISIBLE else View.GONE)
    collapsed.setViewVisibility(R.id.tt_c_run, if (tilesOn) View.VISIBLE else View.GONE)
    collapsed.setViewVisibility(R.id.tt_c_top, if (tilesOn) View.GONE else View.VISIBLE)
    expanded.setViewVisibility(R.id.tt_e_tiles, if (tilesOn) View.VISIBLE else View.GONE)

    // 收合左邊：縮小的跳秒＋分類名（停車中＝「停車中」）
    if (running != null) {
      collapsed.setViewVisibility(R.id.tt_c_chrono, View.VISIBLE)
      collapsed.setChronometer(R.id.tt_c_chrono, chronoBase(running.optLong("startedAt")), null, true)
      collapsed.setTextViewText(R.id.tt_c_runname, str(running, "name", ""))
    } else {
      collapsed.setChronometer(R.id.tt_c_chrono, SystemClock.elapsedRealtime(), null, false)
      collapsed.setViewVisibility(R.id.tt_c_chrono, View.GONE)
      collapsed.setTextViewText(R.id.tt_c_runname, ctx.getString(R.string.tt_idle_short))
    }

    // 運行那一列：展開一律畫；收合只在格子關掉時畫
    val hint = if (tilesOn) ctx.getString(R.string.tt_idle_hint) else ""
    // 預估只畫在展開版（「14:35 発・預估 1h」；收合高度不夠，原型 v-e.js ntContent 同）
    bindTop(ctx, expanded, expandedTop, running, text, idleTitle, hint, night, withEstimate = true)
    if (!tilesOn) bindTop(ctx, collapsed, collapsedTop, running, text, idleTitle, "", night, withEstimate = false)

    val publicTitle = if (running != null) str(text, "publicRunning", ctx.getString(R.string.tt_public_running))
    else str(text, "publicIdle", ctx.getString(R.string.tt_public_idle))
    val publicVersion = NotificationCompat.Builder(ctx, CHANNEL_RUNNING)
      .setSmallIcon(R.drawable.ic_tt_small)
      .setContentTitle(publicTitle)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setShowWhen(false)
      .build()

    val b = NotificationCompat.Builder(ctx, CHANNEL_RUNNING)
      .setSmallIcon(R.drawable.ic_tt_small)
      .setStyle(NotificationCompat.DecoratedCustomViewStyle())
      .setCustomContentView(collapsed)
      .setCustomBigContentView(expanded)
      // 自訂版面畫不出來的地方（部分 ROM、無障礙朗讀）退回標準標題
      .setContentTitle(if (running != null) str(running, "name", "") else idleTitle)
      .setContentText(if (running != null) str(running, "startedLabel", "") else null)
      .setSubText(if (running != null) str(running, "subText", "") else idleTitle)
      .setOngoing(true)
      // 不響不震靠頻道（setSound(null)／enableVibration(false)）＋這行（同一則重貼／換車不再提醒）。
      // 不用 setSilent(true)：AndroidX 會順手把通知塞進 group "silent"＋GROUP_ALERT_SUMMARY，怕被 ROM 歸到靜音區。
      .setOnlyAlertOnce(true)
      // < O 沒有頻道，看這個；跟頻道一樣是 DEFAULT（沒 setDefaults／setSound ⇒ 照樣無聲）
      .setPriority(NotificationCompat.PRIORITY_DEFAULT)
      .setShowWhen(running != null)
      .setUsesChronometer(running != null)
      .setDeleteIntent(dismissPi(ctx))
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setPublicVersion(publicVersion)
    if (running != null) {
      b.setWhen(running.optLong("startedAt"))
      b.setColor(colorOf(running, night))
    }
    openPi(ctx)?.let { b.setContentIntent(it) }
    val n = b.build()
    n.flags = n.flags or Notification.FLAG_NO_CLEAR or Notification.FLAG_ONGOING_EVENT
    return n
  }

  private fun bindTile(ctx: Context, rv: RemoteViews, ids: TileIds, t: JSONObject?, runCat: String?, night: Boolean, slot: Int) {
    if (t == null) {
      rv.setViewVisibility(ids.root, View.GONE)
      return
    }
    val categoryId = str(t, "categoryId", "")
    if (categoryId.isEmpty()) {
      rv.setViewVisibility(ids.root, View.GONE)
      return
    }
    val color = colorOf(t, night)
    val on = runCat != null && runCat == categoryId
    val name = str(t, "name", "")
    rv.setViewVisibility(ids.root, View.VISIBLE)
    rv.setInt(ids.bg, "setColorFilter", color)
    rv.setTextViewText(ids.glyph, str(t, "glyph", "・"))
    rv.setTextColor(ids.glyph, color)
    if (ids.name != null) rv.setTextViewText(ids.name, name)
    rv.setViewVisibility(ids.on, if (on) View.VISIBLE else View.GONE)
    if (on) rv.setInt(ids.on, "setColorFilter", color)
    rv.setViewVisibility(ids.dot, if (on) View.VISIBLE else View.GONE)
    rv.setContentDescription(ids.root, name)
    rv.setOnClickPendingIntent(ids.root, tilePi(ctx, slot, categoryId))
  }

  private fun bindTop(
    ctx: Context,
    rv: RemoteViews,
    ids: TopIds,
    running: JSONObject?,
    text: JSONObject?,
    idleTitle: String,
    idleHint: String,
    night: Boolean,
    withEstimate: Boolean,
  ) {
    if (running != null) {
      val color = colorOf(running, night)
      rv.setInt(ids.badgeBg, "setColorFilter", color)
      rv.setTextViewText(ids.glyph, str(running, "glyph", "・"))
      rv.setTextColor(ids.glyph, color)
      rv.setTextViewText(ids.name, str(running, "name", ""))
      val startedLabel = str(running, "startedLabel", "")
      // estimateText：JS buildNoticeState 給（「預估 1h」；沒預估＝null／缺鍵＝通知上剛發車那班）
      val estimate = if (withEstimate) str(running, "estimateText", "") else ""
      rv.setTextViewText(ids.started, if (estimate.isEmpty()) startedLabel else "$startedLabel・$estimate")
      rv.setViewVisibility(ids.started, View.VISIBLE)
      rv.setViewVisibility(ids.chrono, View.VISIBLE)
      rv.setChronometer(ids.chrono, chronoBase(running.optLong("startedAt")), null, true)
      rv.setTextViewText(ids.arrive, str(text, "arrive", ctx.getString(R.string.tt_arrive)))
      rv.setViewVisibility(ids.arrive, View.VISIBLE)
      rv.setOnClickPendingIntent(ids.arrive, arrivePi(ctx))
    } else {
      rv.setImageViewResource(ids.badgeBg, R.drawable.tt_badge_ph)
      rv.setTextViewText(ids.glyph, "")
      rv.setTextViewText(ids.name, idleTitle)
      rv.setTextViewText(ids.started, idleHint)
      rv.setViewVisibility(ids.started, if (idleHint.isEmpty()) View.GONE else View.VISIBLE)
      rv.setChronometer(ids.chrono, SystemClock.elapsedRealtime(), null, false)
      rv.setViewVisibility(ids.chrono, View.GONE)
      rv.setViewVisibility(ids.arrive, View.GONE)
    }
  }

  /* ───────── 72502 ───────── */

  /** 貼跑太久提醒（TtReminder.fire 判完條件才叫）：title／body＝reminder 的字、點了開 App 帶 tt_ask＝blockId */
  @SuppressLint("MissingPermission")
  fun postReminder(ctx: Context, reminder: JSONObject, st: JSONObject) {
    val app = ctx.applicationContext
    val nm = NotificationManagerCompat.from(app)
    if (!nm.areNotificationsEnabled()) return
    ensureChannels(app)
    val text = st.optJSONObject("text")
    val running = st.optJSONObject("running")
    val blockId = str(reminder, "blockId", "")
    val publicVersion = NotificationCompat.Builder(app, CHANNEL_LONG_RUN)
      .setSmallIcon(R.drawable.ic_tt_small)
      .setContentTitle(str(text, "publicRunning", app.getString(R.string.tt_public_running)))
      .build()
    val b = NotificationCompat.Builder(app, CHANNEL_LONG_RUN)
      .setSmallIcon(R.drawable.ic_tt_small)
      .setContentTitle(str(reminder, "title", ""))
      .setContentText(str(reminder, "body", ""))
      .setAutoCancel(true)
      .setCategory(NotificationCompat.CATEGORY_REMINDER)
      .setPriority(NotificationCompat.PRIORITY_DEFAULT)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setPublicVersion(publicVersion)
    if (running != null) b.setColor(colorOf(running, isNight(app)))
    askPi(app, blockId)?.let { b.setContentIntent(it) }
    try {
      nm.notify(REMINDER_ID, b.build())
    } catch (_: SecurityException) {
      // 權限在判斷與貼之間被撤掉：放棄這一則
    }
  }

  /** 收掉畫面上的 72502（換了一班、取消提醒時） */
  fun cancelReminderNotice(ctx: Context) {
    NotificationManagerCompat.from(ctx.applicationContext).cancel(REMINDER_ID)
  }
}
