package app.shitetsu.nextstop

import android.content.pm.ApplicationInfo
import android.os.Bundle
import android.view.View
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding

private const val PROD_PACKAGE = "app.shitetsu.nextstop"

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // 磨光⑤ 甲：dev 包與沙盒包開 WebView 遠端偵錯，真機才接得上 CDP（/proc/net/unix 出現 webview_devtools_remote_<pid>）。
    // 手機 dev 包跟正式版同一個套件名、只有 versionName 帶 -dev（release 簽章）；沙盒包是 debug 建置＋applicationIdSuffix。
    // 正式版＝正式套件名、沒有 -dev、不是 debuggable ⇒ 不開。要在 super.onCreate 建 WebView 之前呼叫。
    if (isDevBuild()) WebView.setWebContentsDebuggingEnabled(true)
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // 磨光①（AVD 回報 F1）：targetSdk 35 起 edge-to-edge 強制，manifest 的 adjustResize 不再替 App 縮視窗，
    // 軟鍵盤直接疊在 WebView 上、WebView 的 innerHeight／visualViewport 都不變（Android 16 AVD 實測）。
    // 官方做法＝App 自己套 IME inset：鍵盤開著時內容區底部墊鍵盤高，WebView 跟著變矮；鍵盤收起＝0。
    // 不吃掉 insets（原樣往下傳），狀態列、導覽列的處理照舊交給網頁端的 safe-area。
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { v, insets ->
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      v.updatePadding(bottom = ime.bottom)
      insets
    }
  }

  // 磨光①（AVD 回報 F2）：網頁端的返回堆疊空了、拆掉監聽之後，Tauri 的 AppPlugin 把自己的 callback 關掉、
  // 再叫 activity.onBackPressed() 交給 Android 預設——預設只對「從桌面開的 task」退到背景，其他來源（通知、分享、am start）
  // 會 finish＝下次冷啟動。改成一律退到背景、狀態保留（契約「今日最上層按返回＝退到背景」）。
  // ⚠ 不能無條件攔：Android 15 以下系統按返回本來就先進這裡，要靠 super 交給 OnBackPressedDispatcher，
  //   Tauri 的 callback（返回堆疊的入口）才收得到。只有「沒有任何 callback 接手」（＝Tauri 已經放手）才退到背景。
  @Deprecated("Deprecated in Java")
  override fun onBackPressed() {
    if (onBackPressedDispatcher.hasEnabledCallbacks()) {
      @Suppress("DEPRECATION")
      super.onBackPressed()
      return
    }
    moveTaskToBack(true)
  }

  private fun isDevBuild(): Boolean {
    val debuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
    return debuggable || packageName != PROD_PACKAGE || BuildConfig.VERSION_NAME.endsWith("-dev")
  }
}
