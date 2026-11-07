// ⑬ 外部入口：主畫面小工具（外部入口契約第四節；長相照原型 prototypes/外部入口.html 第 2 節）。
// 4×1＝ns_widget_small、拉高＝ns_widget_large（兩份版面的 id 共用；API 31+ 兩份都交給系統挑，舊版自己看高度）。資料全在 SharedPreferences：運行中讀 tt_notice 的 state.running，
// 今日張數與格子讀 ns_widget（JS 用 widget_sync 寫）。Kotlin 只碰通知、鬧鐘、SharedPreferences，絕不寫 SQLite。
//
// - 按鈕：到着、格子走 TtActionReceiver（跟通知上同一條路，App 沒開也記得住）；左半邊、発車、今日走 NsNoticeOpenActivity（落點先落地再開 App）。
// - 計時用 Chronometer：系統跳秒，App 不必醒著。
// - 更新時機：TtNoticeRenderer.render 尾端（狀態一變都經過它）、widget_sync、TtSystemReceiver、換日鬧鐘；
//   updatePeriodMillis 30 分鐘當保險。換日鬧鐘排在 counts 裡下一個 until，不必精準：螢幕關著沒人看，RTC 等下次醒來才送正好。
// - 分類色：API 31+ 兩組色都交給系統（setColorInt），換深淺色時版面的字色與圓牌一起變；更舊的版本等下一次重畫（同常駐通知，已知、接受）。

package app.shitetsu.nextstop.ttnotice

import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.util.SizeF
import android.view.View
import android.widget.RemoteViews
import org.json.JSONArray
import org.json.JSONObject

class NsWidget : AppWidgetProvider() {
  override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
    refresh(context)
  }

  override fun onAppWidgetOptionsChanged(context: Context, appWidgetManager: AppWidgetManager, appWidgetId: Int, newOptions: Bundle) {
    // API 31+ 兩份版面都給過系統了，尺寸變了它自己換；舊版才要照新的高度重畫
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) refresh(context)
  }

  /** 最後一個小工具被移掉：換日鬧鐘沒有用處了 */
  override fun onDisabled(context: Context) {
    cancelRollover(context)
  }

  companion object {
    const val ACTION_ROLLOVER = "app.shitetsu.nextstop.ttnotice.WIDGET_ROLLOVER"

    /**
     * API 31 以下：OPTION_APPWIDGET_MAX_HEIGHT 高過這個就畫 4×2（dp；一格約 50–70dp、兩格 110dp 起）。
     * 看 MAX 不看 MIN：MIN_HEIGHT 是橫向時的高度，直向的 4×2 可能被當成 4×1。
     */
    private const val LARGE_MIN_HEIGHT_DP = 100

    /** API 31+ 系統依實際尺寸挑版面的門檻（dp） */
    private val SIZE_SMALL = SizeF(250f, 40f)
    private val SIZE_LARGE = SizeF(250f, 110f)
    private const val TILE_SLOTS = 4

    /** request code 接在 TtNoticeRenderer 的表後面（100–700）。同一個 Activity、不同 extras 一定要不同 code，否則 PendingIntent 會互相蓋掉 */
    private const val RC_ARRIVE = 800
    private const val RC_OPEN = 810
    private const val RC_TODAY = 811
    private const val RC_ROLLOVER = 820
    private const val RC_TILE = 830

    /** parseTarget 認得的落點（reminders.ts）：開今日 */
    private const val TARGET_TODAY = "{\"kind\":\"today\"}"

    private class TileIds(val root: Int, val disc: Int, val glyph: Int)

    private val tileIds: Array<TileIds> by lazy {
      arrayOf(
        TileIds(R.id.ns_w_tile_0, R.id.ns_w_tile_disc_0, R.id.ns_w_tile_glyph_0),
        TileIds(R.id.ns_w_tile_1, R.id.ns_w_tile_disc_1, R.id.ns_w_tile_glyph_1),
        TileIds(R.id.ns_w_tile_2, R.id.ns_w_tile_disc_2, R.id.ns_w_tile_glyph_2),
        TileIds(R.id.ns_w_tile_3, R.id.ns_w_tile_disc_3, R.id.ns_w_tile_glyph_3),
      )
    }

    /** 重畫所有已放置的小工具。沒放小工具的人（多數）到這裡就結束，不多花一點功夫 */
    fun refresh(ctx: Context) {
      val app = ctx.applicationContext
      // 沒有小工具功能的機型（電視版）是 null
      val mgr = AppWidgetManager.getInstance(app) ?: return
      val ids = mgr.getAppWidgetIds(ComponentName(app, NsWidget::class.java))
      if (ids == null || ids.isEmpty()) return
      val now = System.currentTimeMillis()
      val st = TtNoticeStore.readState(app)
      for (id in ids) {
        mgr.updateAppWidget(id, viewsFor(app, mgr, id, st, now))
      }
      armRollover(app, now)
    }

    /** API 31+ 兩份都給，系統照實際尺寸挑（直向橫向各用各的）；更舊的版本只能給一份，自己猜 */
    private fun viewsFor(app: Context, mgr: AppWidgetManager, id: Int, st: JSONObject?, now: Long): RemoteViews {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        return RemoteViews(mapOf(SIZE_SMALL to build(app, st, false, now), SIZE_LARGE to build(app, st, true, now)))
      }
      val maxHeight = mgr.getAppWidgetOptions(id).getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 0)
      return build(app, st, maxHeight >= LARGE_MIN_HEIGHT_DP, now)
    }

    /** resolve 給 widget_status */
    fun installedCount(ctx: Context): Int {
      val app = ctx.applicationContext
      val mgr = AppWidgetManager.getInstance(app) ?: return 0
      return mgr.getAppWidgetIds(ComponentName(app, NsWidget::class.java))?.size ?: 0
    }

    /** launcher 能不能接「請加入小工具」的要求；不能時設定頁改一句「從桌面長按加入」 */
    fun pinSupported(ctx: Context): Boolean {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false
      val mgr = AppWidgetManager.getInstance(ctx.applicationContext) ?: return false
      return mgr.isRequestPinAppWidgetSupported
    }

    fun requestPin(ctx: Context): Boolean {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false
      val app = ctx.applicationContext
      val mgr = AppWidgetManager.getInstance(app) ?: return false
      return mgr.isRequestPinAppWidgetSupported && mgr.requestPinAppWidget(ComponentName(app, NsWidget::class.java), null, null)
    }

    /* ───────── 畫面 ───────── */

    private fun build(ctx: Context, st: JSONObject?, large: Boolean, now: Long): RemoteViews {
      val rv = RemoteViews(ctx.packageName, if (large) R.layout.ns_widget_large else R.layout.ns_widget_small)
      val running = st?.optJSONObject("running")
      val tiles = NsWidgetStore.tiles(ctx)

      rv.setOnClickPendingIntent(R.id.ns_w_left, openPi(ctx))
      rv.setOnClickPendingIntent(R.id.ns_w_today, todayPi(ctx))
      val left = NsWidgetStore.currentLeft(ctx, now)
      rv.setTextViewText(R.id.ns_w_count, left?.toString() ?: ctx.getString(R.string.ns_widget_no_count))

      if (running != null) {
        bindRunning(ctx, rv, st, running, tiles, large)
      } else {
        bindIdle(ctx, rv, st, tiles, large)
      }
      if (large) bindTiles(ctx, rv, tiles, if (running != null) str(running, "categoryId", "") else null)
      return rv
    }

    private fun bindRunning(ctx: Context, rv: RemoteViews, st: JSONObject?, running: JSONObject, tiles: JSONArray, large: Boolean) {
      rv.setViewVisibility(R.id.ns_w_badge, View.VISIBLE)
      paintDisc(ctx, rv, R.id.ns_w_disc, running)
      rv.setTextViewText(R.id.ns_w_glyph, str(running, "glyph", "・"))

      val (category, task) = splitRunName(st, running, tiles)
      rv.setTextViewText(R.id.ns_w_name, category)
      if (large) {
        rv.setTextViewText(R.id.ns_w_task, if (task.isEmpty()) "" else "・$task")
        rv.setViewVisibility(R.id.ns_w_task, if (task.isEmpty()) View.GONE else View.VISIBLE)
      }

      rv.setViewVisibility(R.id.ns_w_line2, View.VISIBLE)
      rv.setTextViewText(R.id.ns_w_started, str(running, "startedLabel", ""))
      val base = SystemClock.elapsedRealtime() - (System.currentTimeMillis() - running.optLong("startedAt"))
      rv.setChronometer(R.id.ns_w_chrono, base, null, true)

      rv.setViewVisibility(R.id.ns_w_action, View.VISIBLE)
      rv.setTextViewText(R.id.ns_w_action, str(st?.optJSONObject("text"), "arrive", ctx.getString(R.string.tt_arrive)))
      rv.setOnClickPendingIntent(R.id.ns_w_action, arrivePi(ctx))
    }

    private fun bindIdle(ctx: Context, rv: RemoteViews, st: JSONObject?, tiles: JSONArray, large: Boolean) {
      rv.setViewVisibility(R.id.ns_w_badge, View.GONE)
      rv.setViewVisibility(R.id.ns_w_line2, View.GONE)
      rv.setChronometer(R.id.ns_w_chrono, SystemClock.elapsedRealtime(), null, false)
      rv.setTextViewText(R.id.ns_w_name, str(st?.optJSONObject("text"), "idleTitle", ctx.getString(R.string.tt_idle_title)))
      if (large) rv.setViewVisibility(R.id.ns_w_task, View.GONE)
      // 拉高版平常靠下面的格子発車；還沒有格子（App 沒同步過）時留著這顆，才不會一個入口都沒有
      val showDepart = !large || tiles.length() == 0
      rv.setViewVisibility(R.id.ns_w_action, if (showDepart) View.VISIBLE else View.GONE)
      if (showDepart) {
        rv.setTextViewText(R.id.ns_w_action, ctx.getString(R.string.ns_widget_depart))
        rv.setOnClickPendingIntent(R.id.ns_w_action, openPi(ctx))
      }
    }

    /** 正在跑的那個分類不放進格子：它的動作是到着，按格子不會有反應 */
    private fun bindTiles(ctx: Context, rv: RemoteViews, tiles: JSONArray, runCat: String?) {
      var slot = 0
      for (i in 0 until tiles.length()) {
        if (slot >= TILE_SLOTS) break
        val t = tiles.optJSONObject(i) ?: continue
        val categoryId = str(t, "categoryId", "")
        if (categoryId.isEmpty() || categoryId == runCat) continue
        val ids = tileIds[slot]
        rv.setViewVisibility(ids.root, View.VISIBLE)
        paintDisc(ctx, rv, ids.disc, t)
        rv.setTextViewText(ids.glyph, str(t, "glyph", "・"))
        rv.setContentDescription(ids.root, str(t, "name", ""))
        rv.setOnClickPendingIntent(ids.root, tilePi(ctx, slot, categoryId))
        slot++
      }
      while (slot < TILE_SLOTS) {
        rv.setViewVisibility(tileIds[slot].root, View.GONE)
        slot++
      }
    }

    /**
     * running.name 是「分類・任務名」（buildNoticeState 的 noticeRunName），沒有分開的欄位。
     * 分類名本身可能就帶「・」，所以先拿格子裡的分類名去切；這班的分類不在任何格子裡才退回切第一個「・」。
     */
    private fun splitRunName(st: JSONObject?, running: JSONObject, tiles: JSONArray): Pair<String, String> {
      val full = str(running, "name", "")
      val categoryId = str(running, "categoryId", "")
      val known = nameIn(st?.optJSONArray("tiles"), categoryId) ?: nameIn(tiles, categoryId)
      if (known != null) {
        if (full == known) return Pair(full, "")
        if (full.startsWith("$known・")) return Pair(known, full.substring(known.length + 1))
      }
      val cut = full.indexOf('・')
      return if (cut > 0) Pair(full.substring(0, cut), full.substring(cut + 1)) else Pair(full, "")
    }

    private fun nameIn(tiles: JSONArray?, categoryId: String): String? {
      if (tiles == null) return null
      for (i in 0 until tiles.length()) {
        val t = tiles.optJSONObject(i) ?: continue
        if (t.optString("categoryId", "") == categoryId) return str(t, "name", "")
      }
      return null
    }

    private fun paintDisc(ctx: Context, rv: RemoteViews, viewId: Int, o: JSONObject) {
      val light = parseColor(o, "colorLight", TtQuickOps.FALLBACK_COLOR_LIGHT)
      val dark = parseColor(o, "colorDark", TtQuickOps.FALLBACK_COLOR_DARK)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        rv.setColorInt(viewId, "setColorFilter", light, dark)
      } else {
        val mode = ctx.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK
        rv.setInt(viewId, "setColorFilter", if (mode == Configuration.UI_MODE_NIGHT_YES) dark else light)
      }
    }

    private fun parseColor(o: JSONObject, key: String, fallback: String): Int {
      return try {
        Color.parseColor(str(o, key, fallback))
      } catch (_: IllegalArgumentException) {
        Color.parseColor(fallback)
      }
    }

    /** 字串欄位：沒有或是 JSON null ⇒ fallback */
    private fun str(o: JSONObject?, key: String, fallback: String): String {
      if (o == null || !o.has(key) || o.isNull(key)) return fallback
      return o.optString(key, fallback)
    }

    /* ───────── PendingIntent（一律 FLAG_IMMUTABLE） ───────── */

    private const val PI_FLAGS = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT

    private fun arrivePi(ctx: Context): PendingIntent {
      val i = Intent(ctx, TtActionReceiver::class.java).setAction(TtNoticeRenderer.ACTION_ARRIVE)
      return PendingIntent.getBroadcast(ctx, RC_ARRIVE, i, PI_FLAGS)
    }

    private fun tilePi(ctx: Context, slot: Int, categoryId: String): PendingIntent {
      val i = Intent(ctx, TtActionReceiver::class.java)
        .setAction(TtNoticeRenderer.ACTION_TILE)
        .putExtra(TtNoticeRenderer.EXTRA_CATEGORY, categoryId)
      return PendingIntent.getBroadcast(ctx, RC_TILE + slot, i, PI_FLAGS)
    }

    private fun openerIntent(ctx: Context): Intent {
      return Intent(ctx, NsNoticeOpenActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }

    /** 開時刻表分頁（左半邊、発車鈕） */
    private fun openPi(ctx: Context): PendingIntent {
      val i = openerIntent(ctx).putExtra(TtNoticeRenderer.EXTRA_OPEN, true)
      return PendingIntent.getActivity(ctx, RC_OPEN, i, PI_FLAGS)
    }

    /** 開今日 */
    private fun todayPi(ctx: Context): PendingIntent {
      val i = openerIntent(ctx).putExtra(TtNoticeRenderer.EXTRA_NS_REM_TARGET, TARGET_TODAY)
      return PendingIntent.getActivity(ctx, RC_TODAY, i, PI_FLAGS)
    }

    /* ───────── 換日 ───────── */

    private fun rolloverIntent(ctx: Context): Intent {
      return Intent(ctx, TtReminderReceiver::class.java).setAction(ACTION_ROLLOVER)
    }

    private fun armRollover(app: Context, now: Long) {
      val am = app.getSystemService(Context.ALARM_SERVICE) as AlarmManager? ?: return
      val until = NsWidgetStore.nextUntil(app, now)
      if (until == null) {
        // 全部過期：畫面已經是「－」，要等 App 開起來給新的數字才有下一次
        cancelRollover(app)
        return
      }
      am.setAndAllowWhileIdle(AlarmManager.RTC, until, PendingIntent.getBroadcast(app, RC_ROLLOVER, rolloverIntent(app), PI_FLAGS))
    }

    private fun cancelRollover(ctx: Context) {
      val app = ctx.applicationContext
      val am = app.getSystemService(Context.ALARM_SERVICE) as AlarmManager? ?: return
      val pi = PendingIntent.getBroadcast(app, RC_ROLLOVER, rolloverIntent(app), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_NO_CREATE)
      if (pi != null) {
        am.cancel(pi)
        pi.cancel()
      }
    }
  }
}
