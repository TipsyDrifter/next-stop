// 點通知的中繼頁（⑨ E15）：把落點存進 SharedPreferences 再開 App，自己不畫任何東西、馬上結束。
// 走這一頁的有三種：提醒（ns_rem_target）、點跑太久提醒（tt_ask）、點常駐通知本體（tt_open）。
//
// 為什麼不把落點直接放在開 MainActivity 的 Intent 上（AVD 重現）：
// - 會重放：App 在背景被系統收掉、任務還留著時，系統重建 MainActivity 用的是它存著的那份 root intent。
//   在行程裡 removeExtra 改不到系統那份，所以冷啟動開過的舊落點，之後每次重建（含從最近任務回來）都會再跳一次。
// - 會丟掉：同一種重建，新的 intent 走 onNewIntent，那時 WebView 與 plugin 還沒載入，
//   Tauri 的 PluginManager 只轉給已載入的 plugin，新落點就沒了。
// 改走這一頁之後 MainActivity 的 intent 永遠不帶落點；落點先落地，App 不管活著、重建還是冷啟動都由 JS 取一次
// （提醒＝rem_take_launch、另兩種＝take_pending 的 launch，都是讀完即刪）。
//
// Android 12 禁止的通知跳板只限 service／receiver，activity 不受限。manifest 上 noHistory＋excludeFromRecents＋空 taskAffinity：
// 不留在任何任務裡、不會從最近任務回來，也不會把 App 的任務帶起來又疊在上面。

package app.shitetsu.nextstop.ttnotice

import android.app.Activity
import android.os.Bundle
import org.json.JSONObject

class NsNoticeOpenActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val target = intent.getStringExtra(TtNoticeRenderer.EXTRA_NS_REM_TARGET)
    val ask = intent.getStringExtra(TtNoticeRenderer.EXTRA_ASK)
    val open = intent.getBooleanExtra(TtNoticeRenderer.EXTRA_OPEN, false)
    val hasLaunch = !ask.isNullOrEmpty() || open

    if (!target.isNullOrEmpty()) TtNoticeStore.writeRemLaunch(this, target)
    if (hasLaunch) {
      TtNoticeStore.writeLaunch(
        this,
        JSONObject().put("ask", if (ask.isNullOrEmpty()) JSONObject.NULL else ask).put("open", true),
      )
    }
    TtNoticeRenderer.launchIntent(this)?.let { startActivity(it) }

    // App 活著、JS 在聽 ⇒ 叫它來取；沒活著就什麼都不做（JS 啟動時自己會取）
    if (!target.isNullOrEmpty()) TtNoticePlugin.notifyReminderOpen(target)
    if (hasLaunch) TtNoticePlugin.notifyPending(TtNoticeStore.pendingCount(this))
    finish()
  }
}
