# 清掉已結束的 Claude 對話留下的孤兒 powershell.exe（PowerShell 工具的常駐殼，對話被收掉時沒跟著退）
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts/clean-orphan-shells.ps1 [-OlderThanHours 1] [-DryRun]
# 判準（三條都要符合才殺）：
#   1. 行程名 powershell.exe，命令列只有 exe 本身、沒有任何參數（工具殼的特徵；使用者自己開的視窗、排程器跑的腳本都帶參數）
#   2. 父行程已經不存在（對話被收掉時 CLI 行程結束、殼變孤兒；現役對話的殼父行程都活著）＋建立時間超過 N 小時（預設 1，保險）
#   3. 不是本行程自己的祖先（避免殺到正在跑這支腳本的殼）
# 每顆約 57MB；10-17～10-18 曾累積 14 顆（約 800MB）。
param(
  [double]$OlderThanHours = 1,
  [switch]$DryRun
)
$cut = (Get-Date).AddHours(-$OlderThanHours)
$me = $PID
$ancestors = @()
$p = Get-CimInstance Win32_Process -Filter "ProcessId=$me"
while ($p) { $ancestors += $p.ProcessId; $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)" -ErrorAction SilentlyContinue; if ($ancestors.Count -gt 20) { break } }
$victims = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object {
  $cl = ($_.CommandLine | ForEach-Object { $_.Trim().Trim('"') })
  ($cl -match 'powershell\.exe$') -and ($_.CreationDate -lt $cut) -and ($ancestors -notcontains $_.ProcessId)
}
$victims | Select-Object ProcessId, CreationDate, @{n='MB';e={[math]::Round($_.WorkingSetSize/1MB)}} | Format-Table -AutoSize
Write-Host ("要清 {0} 顆（父行程已不在、{1} 小時前起、無參數、非本行程祖先）" -f @($victims).Count, $OlderThanHours)
if ($DryRun) { Write-Host '-DryRun：沒殺任何東西'; exit 0 }
$ok = 0
foreach ($v in $victims) { try { Stop-Process -Id $v.ProcessId -Force -ErrorAction Stop; $ok++ } catch { Write-Host ("殺不掉 {0}：{1}" -f $v.ProcessId, $_.Exception.Message) } }
Write-Host ("清了 {0} 顆" -f $ok)
