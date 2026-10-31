# run-dev.ps1 —— 启动 Easycode dev 并把全部输出写入 dev.log
$ErrorActionPreference = "Continue"
$root = "E:\tools\Easycode"
$log  = Join-Path $root "dev.log"
Set-Location $root

Write-Host "[run-dev] 清理 5180 端口残留..." -ForegroundColor Yellow
Get-NetTCPConnection -LocalPort 5180 -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Get-Process node,electron -ErrorAction SilentlyContinue |
    Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500

# 清空旧日志
"" | Set-Content -Path $log -Encoding utf8

Write-Host "[run-dev] 启动 npm run dev，日志 -> $log" -ForegroundColor Green
Write-Host "[run-dev] 等待 Easycode 窗口出现。测完后按 Ctrl+C 结束。" -ForegroundColor Green

# 2>&1 合并 stderr，Tee-Object 同时显示和写文件
& npm run dev 2>&1 | Tee-Object -FilePath $log

Write-Host ""
Write-Host "[run-dev] dev 已退出。日志在 $log" -ForegroundColor Yellow
