// 手機殼班 B5：Android 真重啟的 Kotlin 入口。
// 做法＝查證報告（2026-09-29）§3 路徑 A：前景時 startActivity(launchIntent, NEW_TASK|CLEAR_TASK) 再結束行程。
// ProcessPhoenix 另開 :phoenix 行程是為了「舊行程沒死、新 Activity 重用舊行程」的時序；這裡先走同行程版
// （startActivity 已把新任務排進 system_server，本行程隨即退出，系統會以新行程啟動新任務），
// 白畫面或殘留舊行程＝原型要回答的題目，不行再退 :phoenix 式。
// @Command 不保證在主執行緒（PluginManager.runCommand 經 JNI），startActivity 收進 runOnUiThread。
package app.shitetsu.nextstop.nsrestart

import android.app.Activity
import android.content.Intent
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import kotlin.system.exitProcess

@TauriPlugin
class NsRestartPlugin(private val activity: Activity) : Plugin(activity) {
    /** 重啟 App：呼叫端（Rust 的還原／重新開始流程）已做完 DB 收尾。
     *  **成功時刻意不 resolve**：Rust 那頭收到回應就會自己 exit(0)，若跑在 startActivity 把新任務交給 system_server 之前，
     *  就退回「只退出、像閃退」。不回應＝Rust 一直等到這裡 exitProcess 結束整個行程；只有失敗才 reject，讓 Rust 退回只退出。 */
    @Command
    fun restartApp(invoke: Invoke) {
        val ctx = activity.applicationContext
        val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
        if (launch == null) {
            invoke.reject("launch intent not found")
            return
        }
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        activity.runOnUiThread {
            try {
                ctx.startActivity(launch)
                // finishAffinity 先把舊任務收乾淨（避免最近任務殘留舊畫面），再結束整個行程
                activity.finishAffinity()
                exitProcess(0)
            } catch (e: Exception) {
                invoke.reject("restart failed: ${e.message}")
            }
        }
    }
}
