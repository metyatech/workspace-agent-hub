Set-StrictMode -Version Latest

$lintScriptPath = Join-Path $PSScriptRoot 'lint.ps1'
$testScriptPath = Join-Path $PSScriptRoot 'test.ps1'
$buildScriptPath = Join-Path $PSScriptRoot 'build.ps1'
$launcherScriptPath = Join-Path $PSScriptRoot 'agent-session-launcher.ps1'

foreach ($scriptPath in @(
    $lintScriptPath,
    $testScriptPath,
    $buildScriptPath,
    $launcherScriptPath
)) {
    if (-not (Test-Path -Path $scriptPath)) {
        throw "Missing script: $scriptPath"
    }
}

& $lintScriptPath
if ($LASTEXITCODE -ne 0) {
    throw 'scripts/lint.ps1 failed.'
}

& $testScriptPath
if ($LASTEXITCODE -ne 0) {
    throw 'scripts/test.ps1 failed.'
}

& $buildScriptPath
if ($LASTEXITCODE -ne 0) {
    throw 'scripts/build.ps1 failed.'
}

& $launcherScriptPath -SmokeTest
if ($LASTEXITCODE -ne 0) {
    throw 'scripts/agent-session-launcher.ps1 -SmokeTest failed.'
}

Write-Output 'Verify OK.'
