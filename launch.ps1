# launch.ps1 —— Easycode 自举启动器(带编译检查 + 启动 watchdog + 失败回滚)
#
# 用法:
#   powershell -ExecutionPolicy Bypass -File launch.ps1           # 不强制重建(仅当源码变新时)
#   powershell -ExecutionPolicy Bypass -File launch.ps1 -Build    # 强制重建
#
# 机制:
#   1. 检测 src/ 与 dist*/ 时间戳,判断需要 build:electron 还是完整 build
#   2. 用 git stash create 建检查点（不改工作区，不产生 18MB 快照）
#   3. 启动 electron,监听 [startup] ready-to-show
#   4. 成功 -> 把检查点写入 refs/easycode/lastgood
#      失败 -> 现场存入 stash + 恢复到 lastgood + 重建 + 再启动
#   5. 写入 .easycode/need_restart 后,主进程检测到会调用本脚本接管重启

param([switch]$Build)

$ErrorActionPreference = "Continue"
$root = "E:\tools\Easycode"
$easycodeDir = Join-Path $root ".easycode"
$lastgoodRef = "refs/easycode/lastgood"
$launchLog = Join-Path $easycodeDir "launch.log"
$crashMarker = Join-Path $easycodeDir "crashed.json"

New-Item -ItemType Directory -Force -Path $easycodeDir | Out-Null

function Log($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format "HH:mm:ss.fff"), $msg
    Write-Host $line
    try { Add-Content -Path $launchLog -Value $line -Encoding utf8 } catch {}
}

function New-Checkpoint {
    # git stash create：记录已追踪文件的当前改动，不改工作区；干净时用 HEAD
    Push-Location $root
    try {
        $sha = (& git stash create 2>$null)
        if (-not $sha) { $sha = (& git rev-parse HEAD 2>$null) }
        if ($sha) { Log "  checkpoint = $sha" } else { Log "  checkpoint: git 不可用" }
        return $sha
    } finally { Pop-Location }
}

function Get-LastGood {
    Push-Location $root
    try {
        return (& git rev-parse --verify $lastgoodRef 2>$null)
    } finally { Pop-Location }
}

function Set-LastGood($sha) {
    if (-not $sha) { return }
    Push-Location $root
    try {
        & git update-ref $lastgoodRef $sha 2>$null
        Log "  lastgood <- $sha"
    } finally { Pop-Location }
}

function Restore-LastGood {
    $lg = Get-LastGood
    if (-not $lg) { Log "  no lastgood ref"; return $false }
    Log "  restore lastgood $lg"
    Push-Location $root
    try {
        $tag = "easycode-crashed-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        & git stash push -u -m $tag 2>&1 | Out-Null
        Log "  现场已存入 stash: $tag"
        & git checkout $lg -- . 2>&1 | Out-Null
        Log "  已恢复 lastgood 的已追踪文件（dist 需重建）"
    } finally { Pop-Location }
    return $true
}

function Get-NewestMtime($path) {
    if (-not (Test-Path $path)) { return $null }
    $items = Get-ChildItem $path -Recurse -File -ErrorAction SilentlyContinue
    if (-not $items) { return $null }
    return ($items | Measure-Object -Property LastWriteTime -Maximum).Maximum
}

function Smart-Build {
    $srcMain = Get-NewestMtime (Join-Path $root "src\main")
    $srcRenderer = Get-NewestMtime (Join-Path $root "src\renderer")
    $distElectron = Get-NewestMtime (Join-Path $root "dist-electron")
    $distRenderer = Get-NewestMtime (Join-Path $root "dist")

    $needMain = (-not $distElectron) -or ($srcMain -and $srcMain -gt $distElectron)
    $needRenderer = (-not $distRenderer) -or ($srcRenderer -and $srcRenderer -gt $distRenderer)

    if ($needMain -and -not $needRenderer) {
        Log "  only main changed -> build:electron (~2s)"
        Push-Location $root
        try { & npm run build:electron 2>&1 | Out-File (Join-Path $easycodeDir "build.log") -Encoding utf8; $rc = $LASTEXITCODE }
        finally { Pop-Location }
        if ($rc -ne 0) { Log "  BUILD FAILED rc=$rc"; return $false }
        Log "  BUILD OK"; return $true
    }
    if ($needRenderer -or ($needMain -and $needRenderer) -or (-not $distRenderer)) {
        Log "  renderer changed (or no dist) -> full build (~60s)"
        Push-Location $root
        try { & npm run build 2>&1 | Out-File (Join-Path $easycodeDir "build.log") -Encoding utf8; $rc = $LASTEXITCODE }
        finally { Pop-Location }
        if ($rc -ne 0) { Log "  BUILD FAILED rc=$rc"; return $false }
        Log "  BUILD OK"; return $true
    }
    Log "  no source changes, skip build"
    return $true
}

function Launch-Electron {
    $env:EASYCODE_SUPERVISED = "1"
    Log "  launching electron..."
    $outLog = Join-Path $easycodeDir "electron.out.log"
    $errLog = Join-Path $easycodeDir "electron.err.log"
    "" | Out-File $outLog -Encoding utf8
    "" | Out-File $errLog -Encoding utf8
    $proc = Start-Process -FilePath "npx.cmd" -ArgumentList "electron", "." `
        -WorkingDirectory $root -PassThru `
        -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    Log "  PID=$($proc.Id), wait ready-to-show (max 25s)..."
    $deadline = (Get-Date).AddSeconds(25)
    $ready = $false
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 300
        if ($proc.HasExited) {
            Log "  electron exited early code=$($proc.ExitCode)"
            return @{ok=$false; reason="early exit code=$($proc.ExitCode)"}
        }
        foreach ($f in @($outLog, $errLog)) {
            if (Test-Path $f) {
                $c = Get-Content $f -Raw -ErrorAction SilentlyContinue
                if ($c -and $c -match '\[startup\] ready-to-show') { $ready = $true; break }
            }
        }
        if ($ready) { break }
    }
    if (-not $ready) {
        Log "  timeout waiting for ready-to-show"
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        return @{ok=$false; reason="timeout"}
    }
    Log "  ready-to-show detected, survival check 3s..."
    Start-Sleep -Seconds 3
    if ($proc.HasExited) {
        Log "  electron exited during survival check code=$($proc.ExitCode)"
        return @{ok=$false; reason="survival check failed"}
    }
    Log "  startup OK (PID=$($proc.Id))"
    return @{ok=$true; proc=$proc}
}

# ---- Main ----
Log "=== launch.ps1 begin ==="
if (-not (Test-Path (Join-Path $root "package.json"))) {
    Log "ABORT: $root is not an Easycode project"; exit 1
}

# 清理可能存在的其他 Easycode 实例
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500

# 清理残留 need_restart
$flag = Join-Path $easycodeDir "need_restart"
if (Test-Path $flag) { Remove-Item $flag -Force -ErrorAction SilentlyContinue }

# 检查点（git stash create，不改工作区）
$checkpoint = New-Checkpoint

# 编译(强制 / 智能)
if ($Build) {
    if (-not (Smart-Build)) {
        Log "Build failed. Try rollback from lastgood..."
        if (Restore-LastGood) {
            if (-not (Smart-Build)) {
                Log "ABORT: build failed after rollback"; exit 1
            }
        } else {
            Log "ABORT: no lastgood to rollback to"; exit 1
        }
    }
} else {
    if (-not (Smart-Build)) {
        Log "Build failed. Try rollback from lastgood..."
        if (Restore-LastGood) {
            if (-not (Smart-Build)) {
                Log "ABORT: build failed after rollback"; exit 1
            }
        } else {
            Log "ABORT: no lastgood to rollback to"; exit 1
        }
    }
}

# 尝试 1
$r1 = Launch-Electron
if ($r1.ok) {
    Log "Attempt 1 OK, lastgood <- checkpoint"
    Set-LastGood $checkpoint
    Log "=== launch.ps1 done (success) ==="
    exit 0
}

# 尝试 2: 回滚
Log "Attempt 1 FAILED ($($r1.reason)). Rolling back..."
if (-not (Restore-LastGood)) {
    Log "ABORT: no lastgood to rollback to"
    @{
        failed_at = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
        reason = $r1.reason
        note = "first launch failed and no lastgood exists"
    } | ConvertTo-Json | Out-File $crashMarker -Encoding utf8
    exit 1
}
Log "Rebuild after rollback..."
if (-not (Smart-Build)) {
    Log "ABORT: build failed after rollback"
    @{
        failed_at = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
        reason = "build failed after rollback"
    } | ConvertTo-Json | Out-File $crashMarker -Encoding utf8
    exit 1
}
$r2 = Launch-Electron
if ($r2.ok) {
    Log "Attempt 2 (rollback) OK"
    @{
        rolled_back = $true
        failed_at = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
        reason = $r1.reason
        note = "Easycode auto-rolled back to lastgood and launched"
    } | ConvertTo-Json | Out-File $crashMarker -Encoding utf8
    Log "=== launch.ps1 done (rolled back) ==="
    exit 0
}
Log "ABORT: rollback also crashed ($($r2.reason))"
@{
    failed_at = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
    reason = "rollback also crashed: $($r2.reason)"
} | ConvertTo-Json | Out-File $crashMarker -Encoding utf8
exit 1
