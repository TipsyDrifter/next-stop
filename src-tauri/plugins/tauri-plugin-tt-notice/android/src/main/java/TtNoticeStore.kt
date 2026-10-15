// 時刻表 ①c：plugin 自己的 SharedPreferences（①b①c 契約 §5.10.4）。
// 檔名 "tt_notice"、MODE_PRIVATE；App allowBackup="false" ⇒ 不進系統備份。
// 「重新開始」「改用另一台的」只清資料庫、不清這份（佇列裡指到不存在分類的発車由 JS 丟掉＝unknownCategory）。
//
// 五把鍵（scripts/tests/timetable-notice.test.ts 的 D9 對帳字面值）：
//   "state"        NoticeState JSON（JS post 寫；receiver 樂觀更新時改 running）
//   "pending"      PendingAction[] JSON（receiver 追加；ackPending 刪）
//   "reminder"     { blockId, fireAt, title, body, fired }（scheduleReminder 寫；receiver 樂觀更新；fire 設 fired）
//   "launch"       { ask: blockId | null, open: Boolean }（captureLaunch 寫；takePending 讀完刪）
//   "last_render"  "running:<id>@<epoch>"／"idle@…"／"off@…"／"denied@…"（renderer 寫；status() 回給 JS 對帳）
//
// 全部讀寫包在 synchronized(lock)（@Command 由 JNI 執行緒呼叫、receiver 在主執行緒，兩邊可能同時動）；寫一律 commit()。
// Kotlin 只碰：通知、AlarmManager、這份 SharedPreferences。絕不寫 SQLite（Plan 技術底線 5）。

package app.shitetsu.nextstop.ttnotice

import android.annotation.SuppressLint
import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

@SuppressLint("ApplySharedPref")
object TtNoticeStore {
  const val PREFS_NAME = "tt_notice"
  const val KEY_STATE = "state"
  const val KEY_PENDING = "pending"
  const val KEY_REMINDER = "reminder"
  const val KEY_LAUNCH = "launch"
  const val KEY_LAST_RENDER = "last_render"

  /** 所有讀寫共用的鎖（JVM 監視器可重入：外層已持有時內層照樣進得去） */
  val lock = Any()

  private fun prefs(ctx: Context): SharedPreferences {
    return ctx.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
  }

  private fun parseObject(raw: String?): JSONObject? {
    if (raw == null) return null
    return try {
      JSONObject(raw)
    } catch (_: JSONException) {
      null
    }
  }

  private fun putOrRemove(ctx: Context, key: String, value: String?) {
    val e = prefs(ctx).edit()
    if (value == null) e.remove(key) else e.putString(key, value)
    e.commit()
  }

  /* ───────── state ───────── */

  fun readState(ctx: Context): JSONObject? {
    synchronized(lock) {
      return parseObject(prefs(ctx).getString(KEY_STATE, null))
    }
  }

  fun writeState(ctx: Context, state: JSONObject?) {
    synchronized(lock) {
      putOrRemove(ctx, KEY_STATE, state?.toString())
    }
  }

  /* ───────── pending（只讀不清；ackPending 才刪，契約 0-6） ───────── */

  /** 這一項 JS 讀得到 id 嗎（ttNoticeBridge.normAction：物件、id 是非空字串）；讀不到的永遠 ack 不到 */
  private fun hasAckableId(o: JSONObject): Boolean {
    val id = o.opt("id")
    return id is String && id.isNotEmpty()
  }

  /**
   * 讀佇列。順手清掉 JS 永遠 ack 不到的垃圾項（不是物件、沒有 id、id 不是非空字串；只有資料損壞時才會有——
   * Kotlin 自己寫的都有 UUID）：不清的話 pendingCount 一直 > 0，post 一直保留樂觀更新、提醒排程一直不動。
   */
  fun readPending(ctx: Context): JSONArray {
    synchronized(lock) {
      val raw = prefs(ctx).getString(KEY_PENDING, null) ?: return JSONArray()
      val arr = try {
        JSONArray(raw)
      } catch (_: JSONException) {
        putOrRemove(ctx, KEY_PENDING, null)
        return JSONArray()
      }
      val out = JSONArray()
      for (i in 0 until arr.length()) {
        val o = arr.optJSONObject(i) ?: continue
        if (hasAckableId(o)) out.put(o)
      }
      if (out.length() != arr.length()) {
        putOrRemove(ctx, KEY_PENDING, if (out.length() == 0) null else out.toString())
      }
      return out
    }
  }

  fun pendingCount(ctx: Context): Int {
    synchronized(lock) {
      return readPending(ctx).length()
    }
  }

  /** 追加一筆；回追加後的筆數 */
  fun appendPending(ctx: Context, action: JSONObject): Int {
    synchronized(lock) {
      val arr = readPending(ctx)
      arr.put(action)
      putOrRemove(ctx, KEY_PENDING, arr.toString())
      return arr.length()
    }
  }

  /** 刪掉這些 id（空清單＝什麼都不刪）；垃圾項已在 readPending 清掉。回剩下的筆數 */
  fun ackPending(ctx: Context, ids: Collection<String>): Int {
    synchronized(lock) {
      val arr = readPending(ctx)
      if (ids.isEmpty()) return arr.length()
      val drop = HashSet(ids)
      val out = JSONArray()
      for (i in 0 until arr.length()) {
        val o = arr.optJSONObject(i) ?: continue
        if (!drop.contains(o.optString("id", ""))) out.put(o)
      }
      putOrRemove(ctx, KEY_PENDING, if (out.length() == 0) null else out.toString())
      return out.length()
    }
  }

  /* ───────── reminder ───────── */

  fun readReminder(ctx: Context): JSONObject? {
    synchronized(lock) {
      return parseObject(prefs(ctx).getString(KEY_REMINDER, null))
    }
  }

  fun writeReminder(ctx: Context, reminder: JSONObject?) {
    synchronized(lock) {
      putOrRemove(ctx, KEY_REMINDER, reminder?.toString())
    }
  }

  /* ───────── launch（點通知本體／點提醒回 App） ───────── */

  fun writeLaunch(ctx: Context, launch: JSONObject?) {
    synchronized(lock) {
      putOrRemove(ctx, KEY_LAUNCH, launch?.toString())
    }
  }

  /** 讀完即刪 */
  fun takeLaunch(ctx: Context): JSONObject? {
    synchronized(lock) {
      val l = parseObject(prefs(ctx).getString(KEY_LAUNCH, null))
      if (l != null) putOrRemove(ctx, KEY_LAUNCH, null)
      return l
    }
  }

  /* ───────── last_render ───────── */

  fun setLastRender(ctx: Context, value: String) {
    synchronized(lock) {
      putOrRemove(ctx, KEY_LAST_RENDER, value)
    }
  }

  fun lastRender(ctx: Context): String {
    synchronized(lock) {
      return prefs(ctx).getString(KEY_LAST_RENDER, null) ?: ""
    }
  }
}
