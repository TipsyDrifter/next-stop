// ⑬ 外部入口：寫 NFC 貼紙（外部入口契約第五節）。讀貼紙不在這裡：系統讀到後用 NDEF_DISCOVERED 開 NsExternalOpenActivity。
//
// - 只留一筆寫入：JS 再叫一次 nfc_write（使用者換了分類重按）⇒ 舊的 reject cancelled、新的接手；舊的那個畫面已經不在了，留著只會擋住新的。
// - App 退背景（TtNoticePlugin.onPause）就收掉：reader mode 只在前景有效，系統會在回前景時自動接回來，
//   那時畫面可能早就不是「把手機靠近貼紙」了，寫入卻還在等，下一張靠過來的貼紙會被覆寫。
// - 不設 FLAG_READER_SKIP_NDEF_CHECK：設了 Ndef.get 會拿不到東西。
// - 不設 FLAG_READER_NO_PLATFORM_SOUNDS：手機靠上去到寫好之間，系統那一聲是唯一的回饋，告訴使用者貼紙有讀到。
// - onTagDiscovered 在 binder 執行緒上（做 I/O 正好）；enable／disable 回主執行緒。

package app.shitetsu.nextstop.ttnotice

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.nfc.FormatException
import android.nfc.NdefMessage
import android.nfc.NdefRecord
import android.nfc.NfcAdapter
import android.nfc.Tag
import android.nfc.tech.Ndef
import android.nfc.tech.NdefFormatable
import android.provider.Settings
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import java.io.Closeable
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean

object NsNfc {
  private const val READER_FLAGS =
    NfcAdapter.FLAG_READER_NFC_A or NfcAdapter.FLAG_READER_NFC_B or NfcAdapter.FLAG_READER_NFC_F or NfcAdapter.FLAG_READER_NFC_V

  /** 寫好後貼紙要離開這麼久才算「再碰一次」，否則手機還靠著就會被系統讀成一次発車 */
  private const val AFTER_WRITE_DEBOUNCE_MS = 1500

  private class Session(val activity: Activity, val adapter: NfcAdapter, val invoke: Invoke, val url: String, val message: NdefMessage) {
    /** 同一次寫入只處理第一個讀到的貼紙（binder 執行緒可能同時回呼） */
    val claimed = AtomicBoolean(false)
  }

  private val lock = Any()
  private var current: Session? = null

  /** 這個 session 還是現在這一筆就拿走（之後由呼叫端負責回 JS）；已被取消或換掉回 false */
  private fun take(s: Session): Boolean {
    synchronized(lock) {
      if (current !== s) return false
      current = null
      return true
    }
  }

  fun status(ctx: Context): JSObject {
    val adapter = NfcAdapter.getDefaultAdapter(ctx)
    return JSObject().put("hardware", adapter != null).put("enabled", adapter != null && adapter.isEnabled)
  }

  fun write(activity: Activity, invoke: Invoke, url: String) {
    val adapter = NfcAdapter.getDefaultAdapter(activity)
    if (adapter == null || !adapter.isEnabled) {
      invoke.reject("no_nfc")
      return
    }
    val message = try {
      NdefMessage(arrayOf(NdefRecord.createUri(url)))
    } catch (_: IllegalArgumentException) {
      invoke.reject("io")
      return
    }
    val session = Session(activity, adapter, invoke, url, message)
    val old = synchronized(lock) {
      val o = current
      current = session
      o
    }
    old?.invoke?.reject("cancelled")
    activity.runOnUiThread {
      val stillCurrent = synchronized(lock) { current === session }
      if (stillCurrent) {
        try {
          adapter.enableReaderMode(activity, NfcAdapter.ReaderCallback { tag -> onTag(session, tag) }, READER_FLAGS, null)
        } catch (_: RuntimeException) {
          // Activity 已被銷毀（IllegalStateException）或機型不支援（UnsupportedOperationException）
          if (take(session)) invoke.reject("no_nfc")
        }
      }
    }
  }

  /** JS 按取消、App 退背景。沒有寫入中就什麼都不做 */
  fun cancel() {
    val s = synchronized(lock) {
      val c = current
      current = null
      c
    } ?: return
    stopReader(s)
    s.invoke.reject("cancelled")
  }

  fun openSettings(activity: Activity) {
    try {
      activity.startActivity(Intent(Settings.ACTION_NFC_SETTINGS))
    } catch (_: ActivityNotFoundException) {
      // 有些 ROM 把 NFC 設定頁拿掉了：退到系統設定首頁，使用者還能自己找
      activity.startActivity(Intent(Settings.ACTION_SETTINGS))
    }
  }

  private fun onTag(s: Session, tag: Tag) {
    if (!s.claimed.compareAndSet(false, true)) return
    val failure = writeTag(tag, s.message)
    if (!take(s)) return // 寫的途中被取消或換掉：JS 已經收到 cancelled
    if (failure == null) {
      NsExternalStore.markSilent(s.activity, s.url, System.currentTimeMillis())
      try {
        s.adapter.ignore(tag, AFTER_WRITE_DEBOUNCE_MS, null, null)
      } catch (_: RuntimeException) {
        // 貼紙已經離開（Tag 過期）：那也就不會被重讀
      }
    }
    stopReader(s)
    if (failure == null) s.invoke.resolve(JSObject().put("ok", true)) else s.invoke.reject(failure)
  }

  private fun stopReader(s: Session) {
    s.activity.runOnUiThread {
      // 排到這裡之前可能已經有新的一筆接手，不能把它的 reader mode 關掉
      val idle = synchronized(lock) { current == null }
      if (idle) {
        try {
          s.adapter.disableReaderMode(s.activity)
        } catch (_: IllegalStateException) {
          // Activity 已被銷毀：reader mode 跟著沒了
        } catch (_: UnsupportedOperationException) {
          // 不會走到這（開得起來才有 session），不值得因此閃退
        }
      }
    }
  }

  /** 回 reject 用的字；null＝寫好了 */
  private fun writeTag(tag: Tag, message: NdefMessage): String? {
    val ndef = Ndef.get(tag)
    if (ndef != null) {
      return withTag(ndef) {
        ndef.connect()
        when {
          !ndef.isWritable -> "readonly"
          ndef.maxSize < message.byteArrayLength -> "too_small"
          else -> {
            ndef.writeNdefMessage(message)
            null
          }
        }
      }
    }
    val formatable = NdefFormatable.get(tag) ?: return "not_ndef"
    return withTag(formatable) {
      formatable.connect()
      formatable.format(message)
      null
    }
  }

  /** IOException 含 TagLostException；SecurityException、IllegalStateException＝Tag 過期或已有別的連線，對使用者都是「再靠一次」 */
  private inline fun withTag(tech: Closeable, body: () -> String?): String? {
    return try {
      body()
    } catch (_: IOException) {
      "io"
    } catch (_: FormatException) {
      "io"
    } catch (_: SecurityException) {
      "io"
    } catch (_: IllegalStateException) {
      "io"
    } finally {
      try {
        tech.close()
      } catch (_: IOException) {
        // 寫入的結果已經定了
      }
    }
  }
}
