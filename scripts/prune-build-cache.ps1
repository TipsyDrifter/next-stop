# 修剪共用編譯快取 C:\build：刪掉超過 N 天沒動的 hash 目錄（接縫 #70）
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts/prune-build-cache.ps1 [-Days 2] [-DryRun]
# 每個 worktree 在 C:\build 底下各有一個 hash 目錄（5～20GB），worktree 退役後就是垃圾；
# 兩天內有動的目錄一律保留（正在用的 worktree 都會每天碰到它）。
param(
  [int]$Days = 2,
  [switch]$DryRun
)
$root = 'C:\build'
if (-not (Test-Path $root)) { Write-Host "找不到 $root"; exit 0 }
$cut = (Get-Date).AddDays(-$Days)
$total = 0.0
$targets = @()
foreach ($d in Get-ChildItem $root -Directory) {
  $files = Get-ChildItem $d.FullName -Recurse -File -ErrorAction SilentlyContinue
  $last = ($files | Measure-Object LastWriteTime -Maximum).Maximum
  $gb = [math]::Round((($files | Measure-Object Length -Sum).Sum) / 1GB, 1)
  if (-not $last -or $last -lt $cut) {
    $targets += [pscustomobject]@{ Path = $d.FullName; GB = $gb; Last = $last }
    $total += $gb
  }
}
$targets | Sort-Object GB -Descending | Format-Table -AutoSize
Write-Host ("要刪 {0} 個目錄，約 {1} GB（{2} 天沒動）" -f $targets.Count, [math]::Round($total, 1), $Days)
if ($DryRun) { Write-Host '-DryRun：沒刪任何東西'; exit 0 }
$ok = 0
foreach ($t in $targets) {
  try { Remove-Item -LiteralPath $t.Path -Recurse -Force -ErrorAction Stop; $ok++ }
  catch { Write-Host ("刪不掉 {0}：{1}" -f $t.Path, $_.Exception.Message) }
}
Write-Host ("刪了 {0} 個；C: 剩 {1} GB" -f $ok, [math]::Round((Get-PSDrive C).Free / 1GB))
