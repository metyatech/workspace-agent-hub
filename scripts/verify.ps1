Set-StrictMode -Version Latest

$lintScriptPath = Join-Path $PSScriptRoot 'lint.ps1'
$testScriptPath = Join-Path $PSScriptRoot 'test.ps1'
$buildScriptPath = Join-Path $PSScriptRoot 'build.ps1'
$launcherScriptPath = Join-Path $PSScriptRoot 'agent-session-launcher.ps1'
$processCleanupScriptPath = Join-Path $PSScriptRoot 'process-cleanup.ps1'
$processWatchdogScriptPath = Join-Path $PSScriptRoot 'process-watchdog.ps1'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$packageJsonPath = Join-Path $repoRoot 'package.json'
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('workspace-agent-hub-verify-' + [guid]::NewGuid().ToString('N'))

. (Join-Path $PSScriptRoot 'npm-bootstrap.ps1')
. $processCleanupScriptPath

foreach ($scriptPath in @(
    $lintScriptPath,
    $testScriptPath,
    $buildScriptPath,
    $launcherScriptPath,
    $processCleanupScriptPath,
    $processWatchdogScriptPath
)) {
    if (-not (Test-Path -Path $scriptPath)) {
        throw "Missing script: $scriptPath"
    }
}

function ConvertTo-QuotedArgumentString {
    param(
        [string[]]$ArgumentList = @()
    )

    $quoted = foreach ($argument in $ArgumentList) {
        $value = [string]$argument
        if (-not $value.Length) {
            '""'
            continue
        }
        if ($value -notmatch '[\s"]') {
            $value
            continue
        }

        $escaped = $value -replace '(\\*)"', '$1$1\"'
        $escaped = $escaped -replace '(\\+)$', '$1$1'
        '"' + $escaped + '"'
    }

    return ($quoted -join ' ')
}

function Invoke-VerifyScript {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [string]$ScriptPath
    )

    $stdoutPath = Join-Path $tempRoot ($Name + '.stdout.log')
    $stderrPath = Join-Path $tempRoot ($Name + '.stderr.log')
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = Get-PowerShellPathForCleanup
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardOutputEncoding = [Text.Encoding]::UTF8
    $startInfo.StandardErrorEncoding = [Text.Encoding]::UTF8

    $argumentList = @(
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        $ScriptPath
    )
    if ($startInfo.PSObject.Properties.Name -contains 'ArgumentList') {
        foreach ($argument in $argumentList) {
            [void]$startInfo.ArgumentList.Add([string]$argument)
        }
    } else {
        $startInfo.Arguments = ConvertTo-QuotedArgumentString -ArgumentList $argumentList
    }

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    $watchdogProcess = $null
    try {
        [void]$process.Start()
        $watchdogProcess = Start-ParentProcessWatchdog -ParentPid $PID -ChildProcess $process

        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $process.WaitForExit()

        $stdoutText = $stdoutTask.GetAwaiter().GetResult()
        $stderrText = $stderrTask.GetAwaiter().GetResult()
        [System.IO.File]::WriteAllText($stdoutPath, $stdoutText, [Text.UTF8Encoding]::new($false))
        [System.IO.File]::WriteAllText($stderrPath, $stderrText, [Text.UTF8Encoding]::new($false))

        if ($process.ExitCode -eq 0) {
            return
        }

        $detail = if ($stderrText.Trim()) { $stderrText.Trim() } elseif ($stdoutText.Trim()) { $stdoutText.Trim() } else { '' }
        if ($detail) {
            throw "$Name failed. $detail"
        }

        throw "$Name failed with exit code $($process.ExitCode)."
    } finally {
        Stop-ManagedProcessTree -Process $process
        Stop-ManagedWatchdogProcess -Process $watchdogProcess
        $process.Dispose()
    }
}

[System.IO.Directory]::CreateDirectory($tempRoot) | Out-Null

try {
    Push-Location $repoRoot
    try {
        if ((Test-Path -Path $packageJsonPath) -and (-not (Test-NpmDependencySurfaceReady -RepoRoot $repoRoot))) {
            Invoke-NpmDependencySurfaceRepair -RepoRoot $repoRoot -LogPrefix '[verify]'
        }
    } finally {
        Pop-Location
    }

    Invoke-VerifyScript -Name 'lint' -ScriptPath $lintScriptPath
    Invoke-VerifyScript -Name 'test' -ScriptPath $testScriptPath

    & $buildScriptPath
    if ($LASTEXITCODE -ne 0) {
        throw 'scripts/build.ps1 failed.'
    }

    & $launcherScriptPath -SmokeTest
    if ($LASTEXITCODE -ne 0) {
        throw 'scripts/agent-session-launcher.ps1 -SmokeTest failed.'
    }
} finally {
    if (Test-Path -Path $tempRoot) {
        [System.IO.Directory]::Delete($tempRoot, $true)
    }
}

Write-Output 'Verify OK.'
