# restart-app.ps1 — 重開桌機正式安裝版 App（代驗用完 CDP 後讓它乾淨回來；或帶 -CdpPort 開偵錯埠）
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts/restart-app.ps1 [-CdpPort <埠>]
# 使用者 2026-10-19 授權：「以後 CDP 你可以幫我重開」——只做「關 next-stop → silo 外重啟同一顆安裝版 exe」，不裝、不刪、不碰資料。
param([int]$CdpPort = 0)
$ErrorActionPreference = 'Stop'
$appName = [string]([char]0x79C1 + [char]0x9435 + [char]0x624B + [char]0x5E33)  # 私鐵手帳
$exe = Join-Path $env:LOCALAPPDATA (Join-Path $appName 'next-stop.exe')
if (-not (Test-Path $exe)) { throw "找不到安裝版：$exe" }
Get-Process next-stop -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "關閉 next-stop (PID $($_.Id))"; $_ | Stop-Process -Force }
Start-Sleep -Seconds 2
$cmd = "`"$exe`""
if ($CdpPort -gt 0) { $cmd = "cmd /c `"set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=$CdpPort && start `"`" `"$exe`"`"" }
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }
if ($r.ReturnValue -ne 0) { throw "WMI 啟動失敗 ReturnValue=$($r.ReturnValue)" }
Start-Sleep -Seconds 3
$p = Get-Process next-stop -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $p) { throw "App 沒起來" }
Write-Host ("重開完成：PID {0}，FileVersion {1}{2}" -f $p.Id, (Get-Item $exe).VersionInfo.FileVersion, $(if ($CdpPort -gt 0) { "，CDP $CdpPort" } else { "，不帶參數" }))
