Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$buildPackageScriptPath = Join-Path $PSScriptRoot 'build-package.ps1'
$packageJsonPath = Join-Path $repoRoot 'package.json'
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('workspace-agent-hub-build-lock-' + [guid]::NewGuid().ToString('N'))
$fakeBuildScriptPath = Join-Path $tempRoot 'fake-build.ps1'
$fakeBuildCommandPath = Join-Path $tempRoot 'fake-build.cmd'
$logPath = Join-Path $tempRoot 'build-lock.log'

$originalTestBuildCommandPath = $env:WORKSPACE_AGENT_HUB_TEST_BUILD_COMMAND_PATH

try {
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

    $packageJson = Get-Content -Path $packageJsonPath -Raw -Encoding utf8 | ConvertFrom-Json
    if ($packageJson.scripts.build -ne 'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-package.ps1') {
        throw 'Expected package.json build script to route through scripts/build-package.ps1.'
    }

    $fakeBuildScript = @"
Set-StrictMode -Version Latest
`$ErrorActionPreference = 'Stop'
Add-Content -Path '$logPath' -Value 'start'
Start-Sleep -Milliseconds 1500
Add-Content -Path '$logPath' -Value 'end'
"@
    Set-Content -Path $fakeBuildScriptPath -Value $fakeBuildScript -Encoding utf8
    Set-Content -Path $fakeBuildCommandPath -Value "@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"$fakeBuildScriptPath`"`r`n" -Encoding ascii

    $job1 = Start-Job -ScriptBlock {
        param($BuildPackageScriptPath, $RepoRoot, $FakeBuildCommandPath)
        Set-Location $RepoRoot
        $env:WORKSPACE_AGENT_HUB_TEST_BUILD_COMMAND_PATH = $FakeBuildCommandPath
        powershell -NoProfile -ExecutionPolicy Bypass -File $BuildPackageScriptPath
    } -ArgumentList $buildPackageScriptPath, $repoRoot, $fakeBuildCommandPath
    $job2 = Start-Job -ScriptBlock {
        param($BuildPackageScriptPath, $RepoRoot, $FakeBuildCommandPath)
        Set-Location $RepoRoot
        $env:WORKSPACE_AGENT_HUB_TEST_BUILD_COMMAND_PATH = $FakeBuildCommandPath
        powershell -NoProfile -ExecutionPolicy Bypass -File $BuildPackageScriptPath
    } -ArgumentList $buildPackageScriptPath, $repoRoot, $fakeBuildCommandPath

    try {
        Wait-Job -Job $job1, $job2 | Out-Null
        if ($job1.State -ne 'Completed' -or $job2.State -ne 'Completed') {
            throw 'Expected both build-package lock jobs to complete successfully.'
        }
        [void](Receive-Job -Job $job1 -Keep)
        [void](Receive-Job -Job $job2 -Keep)
    } finally {
        Remove-Job -Job $job1, $job2 -Force -ErrorAction SilentlyContinue
    }

    $logLines = @(Get-Content -Path $logPath -Encoding utf8)
    if ($logLines.Count -ne 4) {
        throw 'Expected the build-package lock test to record two non-overlapping build executions.'
    }
    if (
        $logLines[0] -ne 'start' -or
        $logLines[1] -ne 'end' -or
        $logLines[2] -ne 'start' -or
        $logLines[3] -ne 'end'
    ) {
        throw 'Expected the build-package wrapper to serialize concurrent builds.'
    }

    Write-Output 'PASS'
} finally {
    if ($null -eq $originalTestBuildCommandPath) {
        Remove-Item Env:WORKSPACE_AGENT_HUB_TEST_BUILD_COMMAND_PATH -ErrorAction SilentlyContinue
    } else {
        $env:WORKSPACE_AGENT_HUB_TEST_BUILD_COMMAND_PATH = $originalTestBuildCommandPath
    }

    if (Test-Path -Path $tempRoot) {
        [System.IO.Directory]::Delete($tempRoot, $true)
    }
}
