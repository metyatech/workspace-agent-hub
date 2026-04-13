Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'npm-bootstrap.ps1')

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('workspace-agent-hub-npm-bootstrap-' + [guid]::NewGuid().ToString('N'))
$repoRoot = Join-Path $tempRoot 'repo'

try {
    New-Item -ItemType Directory -Path $repoRoot -Force | Out-Null
    Set-Content -Path (Join-Path $repoRoot 'package.json') -Value @'
{
  "name": "fixture",
  "dependencies": {
    "@metyatech/thread-inbox": "^0.4.5",
    "commander": "^14.0.3",
    "qrcode": "^1.5.4"
  },
  "devDependencies": {
    "@playwright/test": "^1.58.2",
    "jsdom": "^28.1.0",
    "prettier": "^3.8.1",
    "tsup": "^8.5.1",
    "typescript": "^5.9.3",
    "vitest": "^4.1.0"
  }
}
'@

    $partialNodeModules = Join-Path $repoRoot 'node_modules\.vite'
    New-Item -ItemType Directory -Path $partialNodeModules -Force | Out-Null

    if (Test-NpmDependencySurfaceReady -RepoRoot $repoRoot) {
        throw 'Expected a partial node_modules surface to fail the readiness probe.'
    }

    $probePaths = Get-NpmDependencyProbePaths -RepoRoot $repoRoot
    $threadInboxProbe = Join-Path $repoRoot 'node_modules\@metyatech\thread-inbox\package.json'
    $playwrightProbe = Join-Path $repoRoot 'node_modules\@playwright\test\package.json'

    if ($probePaths -notcontains $threadInboxProbe) {
        throw 'Expected the readiness probe to include @metyatech/thread-inbox.'
    }

    if ($probePaths -notcontains $playwrightProbe) {
        throw 'Expected the readiness probe to include @playwright/test.'
    }

    foreach ($probePath in $probePaths) {
        if ($probePath -eq $threadInboxProbe) {
            continue
        }

        $probeDirectory = Split-Path -Parent $probePath
        if (-not (Test-Path -Path $probeDirectory)) {
            New-Item -ItemType Directory -Path $probeDirectory -Force | Out-Null
        }

        Set-Content -Path $probePath -Value 'ok'
    }

    if (Test-NpmDependencySurfaceReady -RepoRoot $repoRoot) {
        throw 'Expected a missing direct dependency package to fail the readiness probe.'
    }

    $threadInboxDirectory = Split-Path -Parent $threadInboxProbe
    if (-not (Test-Path -Path $threadInboxDirectory)) {
        New-Item -ItemType Directory -Path $threadInboxDirectory -Force | Out-Null
    }

    Set-Content -Path $threadInboxProbe -Value 'ok'

    if (-not (Test-NpmDependencySurfaceReady -RepoRoot $repoRoot)) {
        throw 'Expected a complete dependency surface to pass the readiness probe.'
    }

    $repairLogPath = Join-Path $tempRoot 'repair.log'
    $fakeNpmScriptPath = Join-Path $tempRoot 'fake-npm.ps1'
    $fakeNpmCommandPath = Join-Path $tempRoot 'fake-npm.cmd'
    Set-Content -Path $threadInboxProbe -Value '' -Encoding utf8
    Remove-Item -Path $threadInboxProbe -Force

    $fakeNpmScript = @"
param(
    [Parameter(ValueFromRemainingArguments = `$true)]
    [string[]]`$RemainingArguments
)

Set-StrictMode -Version Latest
`$ErrorActionPreference = 'Stop'

`$repoRoot = '$repoRoot'
`$logPath = '$repairLogPath'

. '$($PSScriptRoot -replace '\\', '\\')\npm-bootstrap.ps1'

Add-Content -Path `$logPath -Value (`$RemainingArguments -join ' ')

`$threadInboxProbe = Join-Path `$repoRoot 'node_modules\@metyatech\thread-inbox\package.json'
if (`$RemainingArguments.Count -eq 0) {
    exit 1
}

switch (`$RemainingArguments[0]) {
    'ci' {
        exit 0
    }
    'install' {
        `$probePaths = Get-NpmDependencyProbePaths -RepoRoot `$repoRoot
        foreach (`$probePath in `$probePaths) {
            `$probeDirectory = Split-Path -Parent `$probePath
            if (-not (Test-Path -Path `$probeDirectory)) {
                New-Item -ItemType Directory -Path `$probeDirectory -Force | Out-Null
            }
            Set-Content -Path `$probePath -Value 'ok' -Encoding utf8
        }
        exit 0
    }
    default {
        exit 1
    }
}
"@
    Set-Content -Path $fakeNpmScriptPath -Value $fakeNpmScript -Encoding utf8
    Set-Content -Path $fakeNpmCommandPath -Value "@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"$fakeNpmScriptPath`" %*`r`n" -Encoding ascii

    Invoke-NpmDependencySurfaceRepair -RepoRoot $repoRoot -NpmExecutable $fakeNpmCommandPath -LogPrefix '[test]'

    if (-not (Test-NpmDependencySurfaceReady -RepoRoot $repoRoot)) {
        throw 'Expected the repair helper to recover the dependency surface after falling back to npm install.'
    }

    $repairLog = Get-Content -Path $repairLogPath -Raw -Encoding utf8
    if ($repairLog -notmatch 'ci' -or $repairLog -notmatch 'install') {
        throw 'Expected the repair helper to attempt npm ci first and then fall back to npm install.'
    }

    $repairLockRepoRoot = Join-Path $tempRoot 'repo-lock'
    New-Item -ItemType Directory -Path $repairLockRepoRoot -Force | Out-Null
    Set-Content -Path (Join-Path $repairLockRepoRoot 'package.json') -Value @'
{
  "name": "fixture-lock",
  "dependencies": {
    "@metyatech/thread-inbox": "^0.4.5",
    "commander": "^14.0.3"
  },
  "devDependencies": {
    "prettier": "^3.8.1",
    "tsup": "^8.5.1",
    "typescript": "^5.9.3",
    "vitest": "^4.1.0",
    "@playwright/test": "^1.58.2"
  }
}
'@
    New-Item -ItemType Directory -Path (Join-Path $repairLockRepoRoot 'node_modules') -Force | Out-Null

    $repairLockLogPath = Join-Path $tempRoot 'repair-lock.log'
    $repairRunnerPath = Join-Path $tempRoot 'repair-runner.ps1'
    $lockingNpmScriptPath = Join-Path $tempRoot 'locking-npm.ps1'
    $lockingNpmCommandPath = Join-Path $tempRoot 'locking-npm.cmd'

    $lockingNpmScript = @"
param(
    [Parameter(ValueFromRemainingArguments = `$true)]
    [string[]]`$RemainingArguments
)

Set-StrictMode -Version Latest
`$ErrorActionPreference = 'Stop'

`$repoRoot = '$repairLockRepoRoot'
`$logPath = '$repairLockLogPath'

. '$($PSScriptRoot -replace '\\', '\\')\npm-bootstrap.ps1'

Add-Content -Path `$logPath -Value ('start ' + `$RemainingArguments[0])
Start-Sleep -Milliseconds 1500
foreach (`$probePath in (Get-NpmDependencyProbePaths -RepoRoot `$repoRoot)) {
    `$probeDirectory = Split-Path -Parent `$probePath
    if (-not (Test-Path -Path `$probeDirectory)) {
        New-Item -ItemType Directory -Path `$probeDirectory -Force | Out-Null
    }
    Set-Content -Path `$probePath -Value 'ok' -Encoding utf8
}
Add-Content -Path `$logPath -Value ('end ' + `$RemainingArguments[0])
exit 0
"@
    Set-Content -Path $lockingNpmScriptPath -Value $lockingNpmScript -Encoding utf8
    Set-Content -Path $lockingNpmCommandPath -Value "@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"$lockingNpmScriptPath`" %*`r`n" -Encoding ascii

    $repairRunnerScript = @"
Set-StrictMode -Version Latest
`$ErrorActionPreference = 'Stop'
. '$($PSScriptRoot -replace '\\', '\\')\npm-bootstrap.ps1'
Invoke-NpmDependencySurfaceRepair -RepoRoot '$repairLockRepoRoot' -NpmExecutable '$lockingNpmCommandPath' -LogPrefix '[repair-lock]'
"@
    Set-Content -Path $repairRunnerPath -Value $repairRunnerScript -Encoding utf8

    $job1 = Start-Job -ScriptBlock {
        param($RunnerPath)
        powershell -NoProfile -ExecutionPolicy Bypass -File $RunnerPath
    } -ArgumentList $repairRunnerPath
    $job2 = Start-Job -ScriptBlock {
        param($RunnerPath)
        powershell -NoProfile -ExecutionPolicy Bypass -File $RunnerPath
    } -ArgumentList $repairRunnerPath
    try {
        Wait-Job -Job $job1, $job2 | Out-Null
        $job1Output = @(Receive-Job -Job $job1 -Keep)
        $job2Output = @(Receive-Job -Job $job2 -Keep)
        if ($job1.State -ne 'Completed' -or $job2.State -ne 'Completed') {
            throw 'Expected both repair-lock jobs to complete successfully.'
        }
    } finally {
        Remove-Job -Job $job1, $job2 -Force -ErrorAction SilentlyContinue
    }

    $repairLockLog = @(Get-Content -Path $repairLockLogPath -Encoding utf8)
    if ($repairLockLog.Count -ne 2) {
        throw 'Expected the repo mutation lock to allow only one npm repair invocation for concurrent callers.'
    }
    if ($repairLockLog[0] -notmatch '^start ci$' -or $repairLockLog[1] -notmatch '^end ci$') {
        throw 'Expected the locked repair invocation to complete without overlapping a second npm command.'
    }

    if (-not (Test-NpmDependencySurfaceReady -RepoRoot $repairLockRepoRoot)) {
        throw 'Expected the locked repair invocation to leave the dependency surface ready.'
    }

    Write-Output 'PASS'
} finally {
    if (Test-Path -Path $tempRoot) {
        [System.IO.Directory]::Delete($tempRoot, $true)
    }
}
