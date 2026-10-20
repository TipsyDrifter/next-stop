# install-dev.ps1 — dev 包桌機安裝的唯一入口（權限白名單只放行這支腳本）
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-dev.ps1 -Setup <NextStop_*-dev_x64-setup.exe 路徑> [-CdpPort <埠>] [-IdleMinSeconds <秒>] [-WaitForIdle] [-WaitMaxSeconds <秒>] [-Force]
# 做的事（照 v1.5.0 起歷班裝機的成功做法）：關 next-stop → WMI 在 silo 外跑 NSIS /S → 回讀 FileVersion → silo 外重啟 App（帶 -CdpPort 時附 WebView2 偵錯參數）。
# 關 App 前的禮貌檢查：鍵鼠閒置不到 -IdleMinSeconds（預設 120）＝使用者正在用，不關、不裝、exit code 3；-WaitForIdle 等到閒置（最多 -WaitMaxSeconds，預設 1800）；-Force 跳過。App 本來沒開就不檢查。細節見 scripts/lib/idle-guard.ps1。
# 安全邊界：只接受本 repo 底下、檔名符合 NextStop_*-dev_x64-setup.exe 的安裝檔；除此之外不跑任何外部指令。
param(
  [Parameter(Mandatory=$true)][string]$Setup,
  [int]$CdpPort = 0,
  [int]$IdleMinSeconds = 120,
  [switch]$WaitForIdle,
  [int]$WaitMaxSeconds = 1800,
  [switch]$Force
)
$ErrorActionPreference = 'Stop'

# ① 驗安裝檔：存在、在 repo 底下、檔名樣式正確
$setupFull = (Resolve-Path $Setup).Path
$repoRoot = (Resolve-Path "$PSScriptRoot\..").Path
if (-not $setupFull.StartsWith($repoRoot)) { throw "安裝檔必須在 repo 底下：$setupFull" }
if ($setupFull -notmatch 'NextStop_[\d\.]+-dev_x64-setup\.exe$') { throw "檔名不符 dev 安裝包樣式：$setupFull" }

# ② 關掉正在跑的 App（沒跑就略過）；真的要關之前先做禮貌檢查，使用者正在用電腦就不關、不裝
. "$PSScriptRoot\lib\idle-guard.ps1"
if (@(Get-Process next-stop -ErrorAction SilentlyContinue).Count -gt 0) {
  if (-not (Test-UserIdle -IdleMinSeconds $IdleMinSeconds -WaitForIdle:$WaitForIdle -WaitMaxSeconds $WaitMaxSeconds -Force:$Force)) { exit 3 }
}
Get-Process next-stop -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "關閉 next-stop (PID $($_.Id))"; $_ | Stop-Process -Force }
Start-Sleep -Seconds 2

# ③ WMI 在 silo 外跑靜默安裝（NSIS /S），等安裝行程結束
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = "`"$setupFull`" /S" }
if ($r.ReturnValue -ne 0) { throw "WMI 啟動安裝失敗 ReturnValue=$($r.ReturnValue)" }
$pid2 = $r.ProcessId
Write-Host "安裝中 (PID $pid2)..."
while (Get-CimInstance Win32_Process -Filter "ProcessId=$pid2" -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 3 }

# ④ 回讀版本（安裝路徑含中文，PS5.1 讀檔編碼不可靠，用 codepoint 組字）
$appName = [string]([char]0x79C1 + [char]0x9435 + [char]0x624B + [char]0x5E33)  # 私鐵手帳
$exe = Join-Path $env:LOCALAPPDATA (Join-Path $appName 'next-stop.exe')
if (-not (Test-Path $exe)) { throw "回讀失敗：$exe 不存在" }
$ver = (Get-Item $exe).VersionInfo.FileVersion
Write-Host "回讀 FileVersion=$ver（$((Get-Item $exe).Length) bytes）"

# ⑤ silo 外重啟 App（帶 CdpPort 時掛 WebView2 偵錯參數，驗完請不帶參數再跑一次本段）
$cmd = "`"$exe`""
if ($CdpPort -gt 0) {
  $envSet = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=$CdpPort"
  $cmd = "cmd /c `"set $envSet && start `"`" `"$exe`"`""
}
$r2 = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }
if ($r2.ReturnValue -ne 0) { throw "WMI 重啟 App 失敗 ReturnValue=$($r2.ReturnValue)" }
Start-Sleep -Seconds 8
$running = Get-Process next-stop -ErrorAction SilentlyContinue
if (-not $running) { throw "App 沒有跑起來" }
Write-Host "完成：$ver 在跑 (PID $($running.Id))$(if ($CdpPort -gt 0) { '，CDP 埠 ' + $CdpPort })"
