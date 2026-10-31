# measure-startup.ps1 —— 测量 Electron 窗口从启动到 ready-to-show 的时间
$ErrorActionPreference = "Stop"
$env:VITE_DEV_SERVER_URL = "http://localhost:5180"
$root = "E:\tools\Easycode"
Set-Location $root

$sw = [System.Diagnostics.Stopwatch]::StartNew()
# 启动 electron，把 stdout/stderr 重定向到文件
$proc = Start-Process -FilePath "npx" -ArgumentList "electron ." -NoNewWindow -PassThru `
    -RedirectStandardOutput "$root\startup-out.log" -RedirectStandardError "$root\startup-err.log"

# 轮询窗口出现（通过主进程日志里的标记）
$timeout = 30
$appeared = $false
while ($sw.Elapsed.TotalSeconds -lt $timeout) {
    if (Test-Path "$root\startup-err.log") {
        $content = Get-Content "$root\startup-err.log" -Raw -ErrorAction SilentlyContinue
        if ($content -and ($content -match "ready-to-show|window.*created|did-finish-load")) {
            $appeared = $true
            break
        }
    }
    Start-Sleep -Milliseconds 50
}
$elapsed = $sw.Elapsed.TotalSeconds
Write-Host ("启动耗时: {0:N2} 秒  (窗口就绪={1})" -f $elapsed, $appeared)

if (-not $appeared) {
    Write-Host "未检测到就绪标记，可能超时。看 startup-err.log 排查。"
}

Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
