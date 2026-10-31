# run-prod.ps1 —— 生产构建并启动，输出写 prod.log
$ErrorActionPreference = "Continue"
$root = "E:\tools\Easycode"
$log  = Join-Path $root "prod.log"
Set-Location $root

Get-NetTCPConnection -LocalPort 5180 -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

"" | Set-Content -Path $log -Encoding utf8

Write-Host "[prod] 构建中(vite build + build:electron)..." -ForegroundColor Yellow
& npm run build 2>&1 | Tee-Object -FilePath $log -Append

Write-Host "[prod] 启动 Electron(生产模式,无 VITE_DEV_SERVER_URL)..." -ForegroundColor Green
$env:VITE_DEV_SERVER_URL = $null
Remove-Item Env:VITE_DEV_SERVER_URL -ErrorAction SilentlyContinue

# 直接跑 npx electron .，加载 dist/index.html
& npx electron . 2>&1 | Tee-Object -FilePath $log -Append

Write-Host "[prod] 已退出，日志在 $log" -ForegroundColor Yellow
