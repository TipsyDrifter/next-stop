// ⑬ 外部入口：從 App 外面進來的 nextstop:// 連結，先排在這裡等 JS 取（"ns_external"，跟 "tt_notice"、"ns_share" 分開）。
// 取＋確認兩段（手法同 NsShareStore）：ext_take 只讀不清、JS 做完 ext_ack 才刪——App 中途被殺不丟連結。
// Kotlin 只碰這份 SharedPreferences，絕不寫 SQLite（Plan 技術底線 5）。

package app.shitetsu.nextstop.ttnotice

import android.annotation.SuppressLint
import android.content.Context
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.util.UUID

@SuppressLint("ApplySharedPref")
object NsExternalStore {
  const val PREFS_NAME = "ns_external"
  const val KEY_QUEUE = "queue"
  /** 上一次碰貼紙的 { url, at }，判 8 秒內重複讀 */
  const val KEY_LAST_SILENT = "last_silent"

  /** 同 externalLink.ts：長度上限與 scheme 的寫法 */
  private const val MAX_URL_LENGTH = 2048
  /** 同桌機 external.rs：JS 一直沒來取時不讓佇列無限長，超過丟最舊的 */
  private const val MAX_QUEUE = 64
  private val SCHEME = Regex("^nextstop(-[a-z0-9-]+)?$", RegexOption.IGNORE_CASE)

  /** 手機留在貼紙上可能重複讀，8 秒內同一個連結不算（外部入口契約第五節） */
  private const val SILENT_REPEAT_MS = 8_000L

  private val lock = Any()

  private fun prefs(ctx: Context) = ctx.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

  private fun write(ctx: Context, arr: JSONArray) {
    val e = prefs(ctx).edit()
    if (arr.length() == 0) e.remove(KEY_QUEUE) else e.putString(KEY_QUEUE, arr.toString())
    e.commit()
  }

  /** 收不收這個連結。只看形狀：認不認得內容由 JS 判，認不得的開 App 後講一句 */
  fun isAcceptable(url: String): Boolean {
    if (url.length > MAX_URL_LENGTH) return false
    val sep = url.indexOf("://")
    return sep > 0 && SCHEME.matches(url.substring(0, sep))
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

  /** 追加一筆 { id, url, at }；回追加後筆數。滿了丟最舊的 */
  fun append(ctx: Context, url: String): Int {
    synchronized(lock) {
      val arr = read(ctx)
      while (arr.length() >= MAX_QUEUE) arr.remove(0)
      arr.put(JSONObject().put("id", UUID.randomUUID().toString()).put("url", url).put("at", System.currentTimeMillis()))
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

  /**
   * 記下這次碰貼紙，回它算不算重複讀。每次都更新時間（連重複的也算）：手機一直留在貼紙上時，
   * 固定窗口會在第 8 秒過後把下一次重複讀當成真的，發車馬上變到着。
   */
  fun touchSilent(ctx: Context, url: String, now: Long): Boolean {
    synchronized(lock) {
      val last = try {
        prefs(ctx).getString(KEY_LAST_SILENT, null)?.let { JSONObject(it) }
      } catch (_: JSONException) {
        null
      }
      markSilent(ctx, url, now)
      if (last == null || last.optString("url", "") != url) return false
      val gap = now - last.optLong("at", 0L)
      return gap in 0 until SILENT_REPEAT_MS
    }
  }

  /** 只記不判：剛寫好貼紙時手機還靠在上面，寫完的那張不要被讀成一次発車（NsNfc） */
  fun markSilent(ctx: Context, url: String, now: Long) {
    synchronized(lock) {
      prefs(ctx).edit().putString(KEY_LAST_SILENT, JSONObject().put("url", url).put("at", now).toString()).commit()
    }
  }
}

/**
 * 「不開 App」的判斷（Kotlin 這一份；另兩份是 externalLink.ts 的 parseExternalLink＋isSilentAction 與桌機 Rust，案例表在 scripts/tests/fixtures/external-links.json）。
 * 切法逐行照 externalLink.ts、手拆字串：android.net.Uri 的 host 不轉小寫、不透明 URI 查 query 還會丟例外，用它就跟另兩份對不齊。
 */
object NsExternalLink {
  /** categoryId＝null 是到着 */
  class Silent(val categoryId: String?, val name: String?)

  fun silentOf(url: String): Silent? {
    if (!NsExternalStore.isAcceptable(url)) return null
    val rest = url.substring(url.indexOf("://") + 3).substringBefore('#')
    val path = rest.substringBefore('?').removeSuffix("/")
    if (path.contains('/')) return null
    if (path.equals("arrive", ignoreCase = true)) return Silent(null, null)
    if (!path.equals("depart", ignoreCase = true)) return null
    val params = queryOf(rest.substringAfter('?', ""))
    val category = params["category"]
    // 同時帶 ticket 時 category 優先（同 externalLink.ts）
    if (category.isNullOrEmpty()) return null
    return Silent(category, params["name"]?.takeIf { it.isNotEmpty() })
  }

  /** 同名取第一個；解不開百分比編碼＝null */
  private fun queryOf(query: String): Map<String, String?> {
    val out = HashMap<String, String?>()
    for (kv in query.split("&")) {
      val at = kv.indexOf('=')
      if (at <= 0) continue
      val key = kv.substring(0, at)
      if (!out.containsKey(key)) out[key] = decode(kv.substring(at + 1))
    }
    return out
  }

  /**
   * 嚴格解碼，判斷要跟 externalLink.ts（decodeURIComponent）、external.rs（percent_decodes）一致。
   * 不用 URLDecoder：它遇到非法 UTF-8 不丟例外，換成替代字元就過了，同一條壞連結這裡會判成能動作、另兩份判成認不得。
   * + 轉空白同 externalLink.ts；原字串裡的非 ASCII 字元照 UTF-8 編進去，才能跟 %XX 接成同一條 byte 流一起驗。
   */
  private fun decode(s: String): String? {
    val bytes = ByteArrayOutputStream(s.length)
    var i = 0
    while (i < s.length) {
      val c = s[i]
      when {
        c == '+' -> {
          bytes.write(0x20)
          i++
        }
        c == '%' -> {
          if (i + 2 >= s.length) return null
          val hi = hexOf(s[i + 1])
          val lo = hexOf(s[i + 2])
          if (hi < 0 || lo < 0) return null
          bytes.write(hi * 16 + lo)
          i += 3
        }
        c.code < 0x80 -> {
          bytes.write(c.code)
          i++
        }
        else -> {
          val end = i + Character.charCount(s.codePointAt(i))
          bytes.write(s.substring(i, end).toByteArray(Charsets.UTF_8))
          i = end
        }
      }
    }
    val decoder = Charsets.UTF_8.newDecoder()
      .onMalformedInput(CodingErrorAction.REPORT)
      .onUnmappableCharacter(CodingErrorAction.REPORT)
    return try {
      decoder.decode(ByteBuffer.wrap(bytes.toByteArray())).toString()
    } catch (_: CharacterCodingException) {
      null
    }
  }

  /** 不用 Character.digit：它連全形數字都收，另兩份只收 ASCII */
  private fun hexOf(c: Char): Int {
    return when (c) {
      in '0'..'9' -> c - '0'
      in 'a'..'f' -> c - 'a' + 10
      in 'A'..'F' -> c - 'A' + 10
      else -> -1
    }
  }
}
