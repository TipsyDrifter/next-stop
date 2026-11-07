// ⑬ 外部入口：小工具的今日張數與格子（"ns_widget"，JS 用 widget_sync 整份換掉；外部入口契約第四、九節）。
// 形狀：{ counts: [{ until: epoch ms, left: number }], tiles: NoticeTile[] }。運行中那班不在這裡，讀 tt_notice 的 state.running。
// 只有整份讀、整份寫，SharedPreferences 本身就是原子的，不必另外上鎖（TtQuickOps 持著 TtNoticeStore.lock 時也會讀這裡）。
// Kotlin 只碰這份 SharedPreferences，絕不寫 SQLite（Plan 技術底線 5）。

package app.shitetsu.nextstop.ttnotice

import android.annotation.SuppressLint
import android.content.Context
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

@SuppressLint("ApplySharedPref")
object NsWidgetStore {
  const val PREFS_NAME = "ns_widget"
  const val KEY_STATE = "state"

  private fun prefs(ctx: Context) = ctx.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

  private fun read(ctx: Context): JSONObject? {
    val raw = prefs(ctx).getString(KEY_STATE, null) ?: return null
    return try {
      JSONObject(raw)
    } catch (_: JSONException) {
      null
    }
  }

  /** 不是 JSON 物件 ⇒ 回 false、什麼都不動 */
  fun write(ctx: Context, raw: String): Boolean {
    try {
      JSONObject(raw)
    } catch (_: JSONException) {
      return false
    }
    prefs(ctx).edit().putString(KEY_STATE, raw).commit()
    return true
  }

  fun tiles(ctx: Context): JSONArray {
    return read(ctx)?.optJSONArray("tiles") ?: JSONArray()
  }

  fun findTile(ctx: Context, categoryId: String): JSONObject? {
    val tiles = tiles(ctx)
    for (i in 0 until tiles.length()) {
      val t = tiles.optJSONObject(i) ?: continue
      if (t.optString("categoryId", "") == categoryId) return t
    }
    return null
  }

  /** 第一筆還沒過期的 counts；App 太久沒開、全部過期了就沒有（畫面顯示「－」，不拿舊數字騙人） */
  private fun currentCount(ctx: Context, now: Long): JSONObject? {
    val counts = read(ctx)?.optJSONArray("counts") ?: return null
    for (i in 0 until counts.length()) {
      val c = counts.optJSONObject(i) ?: continue
      if (c.optLong("until", 0L) > now) return c
    }
    return null
  }

  fun currentLeft(ctx: Context, now: Long): Int? {
    return currentCount(ctx, now)?.optInt("left", 0)
  }

  /** 現在這筆有效到幾點＝下一次該重畫的時刻 */
  fun nextUntil(ctx: Context, now: Long): Long? {
    return currentCount(ctx, now)?.optLong("until", 0L)
  }
}
