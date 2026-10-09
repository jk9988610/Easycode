# run-calc.ps1
# Purpose: run E:\tools\Easycode\calc.py

$ErrorActionPreference = "Stop"

# Directory of this script (reliable regardless of current location)
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$calcPath  = Join-Path $scriptDir "calc.py"

# Ensure calc.py exists
if (-not (Test-Path -LiteralPath $calcPath)) {
    Write-Error "calc.py not found: $calcPath"
    exit 1
}

# Locate an available Python interpreter
$python = $null
foreach ($cmd in @("python", "py", "python3")) {
    $found = Get-Command $cmd -ErrorAction SilentlyContinue
    if ($found) {
        $python = $found.Source
        break
    }
}

if (-not $python) {
    Write-Error "Python interpreter not found. Please install Python and add it to PATH."
    exit 1
}

Write-Host "Interpreter: $python"
Write-Host "Script     : $calcPath"
Write-Host ("-" * 40)

# Run calc.py and forward any arguments
& $python $calcPath @args
exit $LASTEXITCODE
