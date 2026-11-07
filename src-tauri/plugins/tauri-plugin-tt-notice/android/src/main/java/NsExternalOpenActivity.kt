// ⑬ 外部入口的中繼頁（外部入口契約第二、五、六節）：連結、NFC 貼紙、別的 App 分享進來都先到這裡。
// 把內容存進 SharedPreferences 再開 App，自己不畫任何東西、馬上結束；手法與理由同 NsNoticeOpenActivity（那支 exported=false，外面叫不到，所以另開這支）：
// MainActivity 的 intent 永遠不帶東西，系統重建 MainActivity 時就沒有東西可以重放，新內容也不會在 plugin 還沒載入時丟掉。
//
// - VIEW：連結進 NsExternalStore、開 App、叫 JS 來取。
// - NDEF_DISCOVERED：「不開 App」的連結當場處理（寫待處理佇列、更新通知與小工具、震一下加一句 Toast），手機留在原本的畫面。
//   處理不了（App 從沒開過所以沒有 state、找不到這個分類又沒帶名字）或其他連結 ⇒ 照 VIEW。
//   只有貼紙走這條：瀏覽器、捷徑點的連結看不到 Toast 以外的回饋，照契約開 App。
// - SEND：分享的文字進 NsShareStore、開 App、叫 JS 來取。從 MainActivity 搬來，理由見 TtNoticePlugin.load 上面的註解。

package app.shitetsu.nextstop.ttnotice

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.nfc.NfcAdapter
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.widget.Toast
import org.json.JSONObject

class NsExternalOpenActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val i = intent
    when (i?.action) {
      Intent.ACTION_VIEW -> openWithLink(i.dataString)
      NfcAdapter.ACTION_NDEF_DISCOVERED -> onTagRead(i)
      Intent.ACTION_SEND -> onShare(i)
    }
    finish()
  }

  private fun openApp() {
    TtNoticeRenderer.launchIntent(this)?.let { startActivity(it) }
  }

  /** 不合格的連結不存，App 照開：使用者點了東西，至少要看到 App 起來 */
  private fun openWithLink(url: String?) {
    val count = if (url != null && NsExternalStore.isAcceptable(url)) NsExternalStore.append(this, url) else -1
    openApp()
    if (count >= 0) TtNoticePlugin.notifyExternal(count)
  }

  private fun onTagRead(i: Intent) {
    val url = i.dataString
    // 這頁 exported，任何 App 都能顯式送 NDEF_DISCOVERED；不開 App 就動作只給真的貼紙，沒帶 Tag 的當一般連結開 App。
    // debuggable 建置放行：模擬器的 am start 帶不了 Tag，AVD 要靠這條驗。
    val debuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
    if (!i.hasExtra(NfcAdapter.EXTRA_TAG) && !debuggable) {
      openWithLink(url)
      return
    }
    val silent = if (url != null) NsExternalLink.silentOf(url) else null
    if (url == null || silent == null) {
      openWithLink(url)
      return
    }
    if (NsExternalStore.touchSilent(this, url, System.currentTimeMillis())) {
      toast(getString(R.string.ns_nfc_repeat))
      return
    }
    if (!applySilent(silent)) openWithLink(url)
  }

  /** 回 false＝這裡處理不了，要開 App */
  private fun applySilent(link: NsExternalLink.Silent): Boolean {
    val st = TtNoticeStore.readState(this) ?: return false
    val running = st.optJSONObject("running")
    val categoryId = link.categoryId
    if (categoryId == null && running == null) {
      // 到着貼紙、沒有車在跑：已經是使用者要的結果，講一句就好，不必為此開 App
      toast(textOf(st, "idleTitle", R.string.tt_idle_title))
      return true
    }
    // 到着貼紙，或碰了正在跑的那個分類 ⇒ 到着
    if (categoryId == null || (running != null && running.optString("categoryId", "") == categoryId)) {
      if (!TtQuickOps.arrive(this)) return false
      buzz()
      toast(textOf(st, "arrive", R.string.tt_arrive))
      return true
    }
    val next = TtQuickOps.tile(this, categoryId, link.name) ?: return false
    buzz()
    toast(next.optString("name", "") + " " + next.optString("startedLabel", ""))
    return true
  }

  private fun textOf(st: JSONObject, key: String, fallback: Int): String {
    val text = st.optJSONObject("text")
    if (text == null || !text.has(key) || text.isNull(key)) return getString(fallback)
    return text.optString(key, getString(fallback))
  }

  private fun onShare(i: Intent) {
    val text = i.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
    val subject = i.getCharSequenceExtra(Intent.EXTRA_SUBJECT)?.toString()
    val count = if (text.isNullOrBlank()) -1 else NsShareStore.append(this, text, subject)
    openApp()
    if (count >= 0) TtNoticePlugin.notifyShared(count)
  }

  /** 用 applicationContext：這一頁馬上就 finish 了 */
  private fun toast(text: String) {
    Toast.makeText(applicationContext, text, Toast.LENGTH_SHORT).show()
  }

  @Suppress("DEPRECATION")
  private fun buzz() {
    val v = getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator ?: return
    if (!v.hasVibrator()) return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      v.vibrate(VibrationEffect.createOneShot(BUZZ_MS, VibrationEffect.DEFAULT_AMPLITUDE))
    } else {
      v.vibrate(BUZZ_MS)
    }
  }

  private companion object {
    const val BUZZ_MS = 60L
  }
}
