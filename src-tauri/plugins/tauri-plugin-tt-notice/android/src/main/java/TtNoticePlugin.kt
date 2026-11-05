// 時刻表 ①c：本地 plugin tt-notice 的 Kotlin 入口（①b①c 契約 §5.10.3）。
// Kotlin 只碰：通知、AlarmManager、自己的 SharedPreferences（"tt_notice"）。絕不寫 SQLite（Plan 技術底線 5）。
// JS 的 plugin:tt-notice|<cmd> 由 tauri 在 mobile 轉到這裡（snake_case → lowerCamelCase：take_pending → takePending）。
// @Command 由 PluginManager.runCommand（JNI）叫，不保證在主執行緒；receiver 在主執行緒 ⇒ SharedPreferences 一律經 TtNoticeStore 的鎖。
//
// 佇列沒清空時（receiver 樂觀更新過、JS 還沒套）JS 送來的 running 與提醒是舊的：
//   post 保留存著的 running（其餘欄位照 JS 的）、scheduleReminder／cancelReminder 不動提醒——
//   JS 套完佇列、ack 之後一定 force 重送一次，那時才以 JS 為準（noticePending.drainPending 的最後一步）。

package app.shitetsu.nextstop.ttnotice

import android.app.Activity
import android.content.Intent
import android.webkit.WebView
import androidx.core.app.NotificationManagerCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONException
import org.json.JSONObject

/** NoticeState 的 JSON 字串（JS 端 JSON.stringify；Kotlin 原樣存、用 org.json 讀） */
@InvokeArg
class PostArgs {
  lateinit var state: String
}

/** 可為空陣列（＝什麼都不刪；不同於 notification 2.3.3 的 cancel） */
@InvokeArg
class AckArgs {
  var ids: List<String> = listOf()
}

@InvokeArg
class ReminderArgs {
  lateinit var blockId: String
  var fireAt: Long = 0
  lateinit var title: String
  lateinit var body: String
}

/** ⑨ 提醒清單的 JSON 字串（JS 端 JSON.stringify）；省略或 null＝只取 fired，不動清單也不重排 */
@InvokeArg
class RemSyncArgs {
  var items: String? = null
}

@TauriPlugin
class TtNoticePlugin(private val activity: Activity) : Plugin(activity) {
  companion object {
    /** receiver 用來判斷「App 行程活著、WebView 載入了」（notification 2.3.3 NotificationPlugin.kt:86-87 同手法） */
    @Volatile
    var instance: TtNoticePlugin? = null

    /** 佇列有新動作 ⇒ 通知 JS（ttOnPending）；App 沒活著就什麼都不做（回前景／冷啟動那兩條會套） */
    fun notifyPending(count: Int) {
      instance?.trigger("pending", JSObject().put("count", count))
    }

    /** ⑨ 點了提醒（NsNoticeOpenActivity 已把落點存好）⇒ 通知 JS 來取；App 沒活著就什麼都不做（JS 啟動時自己會取） */
    fun notifyReminderOpen(target: String) {
      instance?.trigger("reminder-open", JSObject().put("target", target))
    }
  }

  override fun load(webView: WebView) {
    super.load(webView)
    instance = this
    TtNoticeRenderer.ensureChannels(activity)
    captureShare(activity.intent)
  }

  /** launchMode singleTask ⇒ App 開著時別的 App 分享進來走這裡。點通知不經過這裡（NsNoticeOpenActivity） */
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    captureShare(intent)
  }

  /**
   * 旅客筆記 ⑤：別的 App 分享文字進來（ACTION_SEND text/plain；intent-filter 在本 plugin 的 manifest，merger 併進 MainActivity）。
   * 只吃 ACTION_SEND。從最近任務清單回來會重放原 intent ⇒ 帶 LAUNCHED_FROM_HISTORY 的不收。
   * 收過就把 action／extras 拿掉，同一個 Intent（冷啟動的 activity.intent）不會被算第二次。
   */
  private fun captureShare(intent: Intent?): Boolean {
    if (intent == null || intent.action != Intent.ACTION_SEND) return false
    if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return true
    val text = intent.getStringExtra(Intent.EXTRA_TEXT)
    val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)
    intent.removeExtra(Intent.EXTRA_TEXT)
    intent.removeExtra(Intent.EXTRA_SUBJECT)
    intent.action = null
    if (text.isNullOrBlank()) return true
    val count = NsShareStore.append(activity, text, subject)
    trigger("shared", JSObject().put("count", count))
    return true
  }

  /** resolve({ items: [{ id, text, subject?, at }] })；只讀不清（ackShared 才刪） */
  @Command
  fun takeShared(invoke: Invoke) {
    invoke.resolve(JSObject().put("items", NsShareStore.read(activity)))
  }

  @Command
  fun ackShared(invoke: Invoke) {
    val args = invoke.parseArgs(AckArgs::class.java)
    NsShareStore.ack(activity, args.ids)
    invoke.resolve()
  }

  @Suppress("OVERRIDE_DEPRECATION", "DEPRECATION")
  override fun onDestroy() {
    if (instance === this) instance = null
  }

  /** 存 state → 依 state 貼或收 72501（enabled=false ⇒ 收） */
  @Command
  fun post(invoke: Invoke) {
    val args = invoke.parseArgs(PostArgs::class.java)
    val next = try {
      JSONObject(args.state)
    } catch (e: JSONException) {
      invoke.reject("tt-notice post：state 不是 JSON（${e.message}）")
      return
    }
    synchronized(TtNoticeStore.lock) {
      if (TtNoticeStore.pendingCount(activity) > 0) {
        val cur = TtNoticeStore.readState(activity)
        if (cur != null && cur.has("running")) next.put("running", cur.opt("running"))
      }
      TtNoticeStore.writeState(activity, next)
    }
    TtNoticeRenderer.render(activity)
    invoke.resolve()
  }

  /** 收 72501、state.enabled=false */
  @Command
  fun remove(invoke: Invoke) {
    synchronized(TtNoticeStore.lock) {
      val cur = TtNoticeStore.readState(activity)
      if (cur != null) {
        cur.put("enabled", false)
        TtNoticeStore.writeState(activity, cur)
      }
    }
    TtNoticeRenderer.cancel(activity)
    invoke.resolve()
  }

  /** resolve({ actions: [...], launch: { ask, open }? })；只讀 pending（契約 0-6：只讀不清）、讀完清 launch */
  @Command
  fun takePending(invoke: Invoke) {
    val res = JSObject()
    synchronized(TtNoticeStore.lock) {
      res.put("actions", TtNoticeStore.readPending(activity))
      val launch = TtNoticeStore.takeLaunch(activity)
      if (launch != null) res.put("launch", launch)
    }
    invoke.resolve(res)
  }

  /** 從 pending 刪掉 ids（commit()）；空陣列＝什麼都不刪 */
  @Command
  fun ackPending(invoke: Invoke) {
    val args = invoke.parseArgs(AckArgs::class.java)
    TtNoticeStore.ackPending(activity, args.ids)
    invoke.resolve()
  }

  /** 存 reminder → TtReminder.arm()。換了一班 ⇒ 先收掉畫面上上一班的 72502 */
  @Command
  fun scheduleReminder(invoke: Invoke) {
    val a = invoke.parseArgs(ReminderArgs::class.java)
    var apply = false
    var otherBlock = false
    synchronized(TtNoticeStore.lock) {
      if (TtNoticeStore.pendingCount(activity) == 0) {
        apply = true
        val old = TtNoticeStore.readReminder(activity)
        otherBlock = old != null && old.optString("blockId", "") != a.blockId
        // 同一班、同一時刻、已經響過 ⇒ 保留 fired（不重響）
        val keepFired = old != null && !otherBlock && old.optLong("fireAt", 0L) == a.fireAt && old.optBoolean("fired", false)
        TtNoticeStore.writeReminder(
          activity,
          JSONObject()
            .put("blockId", a.blockId)
            .put("fireAt", a.fireAt)
            .put("title", a.title)
            .put("body", a.body)
            .put("fired", keepFired),
        )
      }
    }
    if (apply) {
      if (otherBlock) TtNoticeRenderer.cancelReminderNotice(activity)
      TtReminder.arm(activity)
    }
    invoke.resolve()
  }

  /** 刪 reminder → 取消鬧鐘 → 收 72502 */
  @Command
  fun cancelReminder(invoke: Invoke) {
    var apply = false
    synchronized(TtNoticeStore.lock) {
      if (TtNoticeStore.pendingCount(activity) == 0) {
        apply = true
        TtNoticeStore.writeReminder(activity, null)
      }
    }
    if (apply) {
      TtReminder.disarm(activity)
      TtNoticeRenderer.cancelReminderNotice(activity)
    }
    invoke.resolve()
  }

  /**
   * ⑨ resolve({ fired: [{ key, kind, memberKeys, at, title, body, target }], exactAlarm })；fired＝自上次以來響過的，回傳後清空。
   * 帶 items ⇒ 存清單、貼已到期的、排下一個（這趟貼的也算在 fired 裡）；省略或 null ⇒ 只取 fired。
   * JS 每趟先空手取一次、記進帳本再算新清單，否則總結的成員變動時可能重響（reminders.ts 的 memberKeys）。
   */
  @Command
  fun remSync(invoke: Invoke) {
    val raw = invoke.parseArgs(RemSyncArgs::class.java).items
    if (raw != null && !NsReminders.sync(activity, raw)) {
      invoke.reject("tt-notice rem_sync：items 不是 JSON 陣列")
      return
    }
    val res = JSObject()
    res.put("fired", NsReminders.takeFired(activity))
    res.put("exactAlarm", TtReminder.canExact(activity))
    invoke.resolve(res)
  }

  /** ⑨ resolve({ target: string | null })；讀完即刪 */
  @Command
  fun remTakeLaunch(invoke: Invoke) {
    val target = TtNoticeStore.takeRemLaunch(activity)
    invoke.resolve(JSObject().put("target", target ?: JSONObject.NULL))
  }

  /** resolve({ exactAlarm, notificationsEnabled, pendingCount, reminderFireAt: Long?, lastRender }) */
  @Command
  fun status(invoke: Invoke) {
    val res = JSObject()
    res.put("exactAlarm", TtReminder.canExact(activity))
    res.put("notificationsEnabled", NotificationManagerCompat.from(activity).areNotificationsEnabled())
    res.put("pendingCount", TtNoticeStore.pendingCount(activity))
    val r = TtNoticeStore.readReminder(activity)
    if (r != null && !r.optBoolean("fired", false)) res.put("reminderFireAt", r.optLong("fireAt", 0L))
    res.put("lastRender", TtNoticeStore.lastRender(activity))
    invoke.resolve(res)
  }
}
