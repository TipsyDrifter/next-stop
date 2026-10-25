# idle-guard.ps1 — 關 App 之前的禮貌檢查（restart-app.ps1／install-dev.ps1 共用，dot-source 進來用）
# 用法：. "$PSScriptRoot\lib\idle-guard.ps1"
#       if (<真的有 next-stop 行程要關> -and -not (Test-UserIdle -WaitForIdle:$WaitForIdle -WaitMaxSeconds $WaitMaxSeconds -Force:$Force)) { exit 3 }
# 規則（使用者定）：擋的條件是「使用者正在用這顆 App」＝前景視窗屬於 next-stop 行程；沒在用 App（就算正在用電腦做別的事）直接放行。
#   以前的條件是「全域鍵鼠閒置滿 2 分鐘」：使用者邊用電腦邊等裝機時會互相等（一邊等裝完、一邊等閒置），空等過 45 分鐘。
#   條件要量真正衝突的資源（App 本身在不在用），不是使用者在不在電腦前。
# App 在前景時：
#   - 沒帶 -WaitForIdle：印一行提示、回傳 $false（呼叫端以 exit code 3 結束，不關、不裝）
#   - 帶 -WaitForIdle：每 15 秒再看一次，最多等 WaitMaxSeconds；等到它離開前景回傳 $true，等不到回傳 $false
#   - 帶 -Force：跳過檢查，直接回傳 $true
# 量不到前景視窗（API 失敗）時不擋，印警告後放行。
# Get-IdleSeconds（鍵鼠閒置秒數）保留給 scripts/verify/idle-reader.mjs 用，這裡的判定不再用它；-IdleMinSeconds 參數保留相容（白名單指令帶著它），判定不再使用。

if (-not ('NextStopIdle' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NextStopIdle {
  [StructLayout(LayoutKind.Sequential)]
  struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  // 回傳鍵鼠閒置毫秒數；API 失敗回 -1。TickCount 會繞回，用 uint 相減處理。
  public static long IdleMs() {
    LASTINPUTINFO lii = new LASTINPUTINFO();
    lii.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
    if (!GetLastInputInfo(ref lii)) return -1;
    uint now = unchecked((uint)Environment.TickCount);
    return (long)unchecked(now - lii.dwTime);
  }
}
'@
}

# 前景視窗查詢開新的 type，不塞進 NextStopIdle：長駐的 PowerShell 可能已編過舊版同名 class，同名擴充不會生效
if (-not ('NextStopFg' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NextStopFg {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint gaFlags);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  // 回傳前景視窗（取到頂層根，WebView2 子視窗才會歸回宿主）所屬行程的 PID；查不到回 -1
  public static long ForegroundPid() {
    IntPtr h = GetForegroundWindow();
    if (h == IntPtr.Zero) return -1;
    IntPtr root = GetAncestor(h, 2 /* GA_ROOT */);
    if (root != IntPtr.Zero) h = root;
    uint pid;
    GetWindowThreadProcessId(h, out pid);
    if (pid == 0) return -1;
    return (long)pid;
  }
}
'@
}

# 目前鍵鼠閒置秒數（整數）；量不到回 -1。verify/idle-reader.mjs 引用這支，簽名別動。
function Get-IdleSeconds {
  $ms = [NextStopIdle]::IdleMs()
  if ($ms -lt 0) { return -1 }
  return [int][math]::Floor($ms / 1000)
}

# 使用者是否正在用 App（前景視窗屬於 $AppProcessName 行程）；量不到回 $null
function Test-AppInForeground {
  param([string]$AppProcessName = 'next-stop')
  $fgPid = [NextStopFg]::ForegroundPid()
  if ($fgPid -lt 0) { return $null }
  $p = Get-Process -Id $fgPid -ErrorAction SilentlyContinue
  if (-not $p) { return $null }
  return ($p.ProcessName -eq $AppProcessName)
}

# 可以動手關 App 就回傳 $true；使用者正在用 App（且不等或等不到）回傳 $false
function Test-UserIdle {
  param(
    [int]$IdleMinSeconds = 120,   # 已不使用，保留讓既有呼叫不壞
    [switch]$WaitForIdle,
    [int]$WaitMaxSeconds = 1800,
    [switch]$Force,
    [string]$AppProcessName = 'next-stop'
  )
  if ($Force) { return $true }
  $inUse = Test-AppInForeground -AppProcessName $AppProcessName
  if ($null -eq $inUse) { Write-Host "警告：量不到前景視窗，略過禮貌檢查"; return $true }
  if (-not $inUse) { return $true }
  if (-not $WaitForIdle) {
    Write-Host "使用者正在用 App（$AppProcessName 在前景），改時機再跑，或加 -WaitForIdle／-Force"
    return $false
  }
  $deadline = (Get-Date).AddSeconds($WaitMaxSeconds)
  while ($inUse) {
    if ((Get-Date) -ge $deadline) {
      Write-Host "等了 $WaitMaxSeconds 秒 App 仍在前景，不關 App；改時機再跑，或加 -Force"
      return $false
    }
    Write-Host "使用者正在用 App（$AppProcessName 在前景），15 秒後再看"
    Start-Sleep -Seconds 15
    $inUse = Test-AppInForeground -AppProcessName $AppProcessName
    if ($null -eq $inUse) { Write-Host "警告：量不到前景視窗，略過禮貌檢查"; return $true }
  }
  return $true
}
