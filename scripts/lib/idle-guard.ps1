# idle-guard.ps1 — 關 App 之前的禮貌檢查（restart-app.ps1／install-dev.ps1 共用，dot-source 進來用）
# 用法：. "$PSScriptRoot\lib\idle-guard.ps1"
#       if (<真的有 next-stop 行程要關> -and -not (Test-UserIdle -IdleMinSeconds $IdleMinSeconds -WaitForIdle:$WaitForIdle -WaitMaxSeconds $WaitMaxSeconds -Force:$Force)) { exit 3 }
# 規則：鍵鼠閒置不到 IdleMinSeconds＝使用者正在用電腦。正在用時：
#   - 沒帶 -WaitForIdle：印一行提示、回傳 $false（呼叫端以 exit code 3 結束，不關、不裝）
#   - 帶 -WaitForIdle：每 15 秒再量一次，最多等 WaitMaxSeconds；等到閒置回傳 $true，等不到回傳 $false
#   - 帶 -Force：跳過檢查，直接回傳 $true
# 閒置秒數用 Win32 GetLastInputInfo 量；量不到（API 失敗）時不擋，印警告後放行。

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

# 目前鍵鼠閒置秒數（整數）；量不到回 -1
function Get-IdleSeconds {
  $ms = [NextStopIdle]::IdleMs()
  if ($ms -lt 0) { return -1 }
  return [int][math]::Floor($ms / 1000)
}

# 可以動手關 App 就回傳 $true；使用者正在用（且不等或等不到）回傳 $false
function Test-UserIdle {
  param(
    [int]$IdleMinSeconds = 120,
    [switch]$WaitForIdle,
    [int]$WaitMaxSeconds = 1800,
    [switch]$Force
  )
  if ($Force) { return $true }
  $idle = Get-IdleSeconds
  if ($idle -lt 0) { Write-Host "警告：量不到鍵鼠閒置秒數（GetLastInputInfo 失敗），略過禮貌檢查"; return $true }
  if ($idle -ge $IdleMinSeconds) { return $true }
  if (-not $WaitForIdle) {
    Write-Host "使用者正在用電腦（閒置 $idle 秒），改時機再跑，或加 -WaitForIdle／-Force"
    return $false
  }
  $deadline = (Get-Date).AddSeconds($WaitMaxSeconds)
  while ($idle -lt $IdleMinSeconds) {
    if ((Get-Date) -ge $deadline) {
      Write-Host "等了 $WaitMaxSeconds 秒使用者仍在用電腦（閒置 $idle 秒），不關 App；改時機再跑，或加 -Force"
      return $false
    }
    Write-Host "使用者正在用電腦（閒置 $idle 秒 < $IdleMinSeconds），15 秒後再量"
    Start-Sleep -Seconds 15
    $idle = Get-IdleSeconds
    if ($idle -lt 0) { Write-Host "警告：量不到鍵鼠閒置秒數，略過禮貌檢查"; return $true }
  }
  return $true
}
