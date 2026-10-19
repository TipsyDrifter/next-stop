// 旅客筆記 ⑤（D-筆-59，實驗 6）：從別的 App「分享」進來的文字，先排在這裡等 JS 取。
// 跟時刻表的 "tt_notice" 分開成另一份 SharedPreferences（"ns_share"）：不動那份的五把鍵（timetable-notice.test.ts D9 對帳）。
// 取＋確認兩段（同 pending，①c 契約 0-6）：takeShared 只讀不清、JS 寫進收件匣後 ackShared 才刪——App 中途被殺不丟字。
// Kotlin 只碰這份 SharedPreferences，絕不寫 SQLite（Plan 技術底線 5）。

package app.shitetsu.nextstop.ttnotice

import android.annotation.SuppressLint
import android.content.Context
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.util.UUID

@SuppressLint("ApplySharedPref")
object NsShareStore {
  const val PREFS_NAME = "ns_share"
  const val KEY_QUEUE = "queue"

  private val lock = Any()

  private fun prefs(ctx: Context) = ctx.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

  private fun write(ctx: Context, arr: JSONArray) {
    val e = prefs(ctx).edit()
    if (arr.length() == 0) e.remove(KEY_QUEUE) else e.putString(KEY_QUEUE, arr.toString())
    e.commit()
  }

  /** 讀佇列；壞掉的整份丟掉（只有資料損壞才會發生） */
  fun read(ctx: Context): JSONArray {
    synchronized(lock) {
      val raw = prefs(ctx).getString(KEY_QUEUE, null) ?: return JSONArray()
      return try {
        JSONArray(raw)
      } catch (_: JSONException) {
        write(ctx, JSONArray())
        JSONArray()
      }
    }
  }

  /** 追加一筆 { id, text, subject?, at }；回追加後筆數 */
  fun append(ctx: Context, text: String, subject: String?): Int {
    synchronized(lock) {
      val arr = read(ctx)
      val o = JSONObject().put("id", UUID.randomUUID().toString()).put("text", text).put("at", System.currentTimeMillis())
      if (!subject.isNullOrEmpty()) o.put("subject", subject)
      arr.put(o)
      write(ctx, arr)
      return arr.length()
    }
  }

  /** 刪掉這些 id；空清單＝什麼都不刪 */
  fun ack(ctx: Context, ids: Collection<String>) {
    if (ids.isEmpty()) return
    synchronized(lock) {
      val drop = HashSet(ids)
      val arr = read(ctx)
      val out = JSONArray()
      for (i in 0 until arr.length()) {
        val o = arr.optJSONObject(i) ?: continue
        if (!drop.contains(o.optString("id", ""))) out.put(o)
      }
      write(ctx, out)
    }
  }
}
