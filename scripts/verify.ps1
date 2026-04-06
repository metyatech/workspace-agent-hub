Set-StrictMode -Version Latest

$lintScriptPath = Join-Path $PSScriptRoot 'lint.ps1'
$testScriptPath = Join-Path $PSScriptRoot 'test.ps1'
$buildScriptPath = Join-Path $PSScriptRoot 'build.ps1'
$launcherScriptPath = Join-Path $PSScriptRoot 'agent-session-launcher.ps1'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$packageJsonPath = Join-Path $repoRoot 'package.json'
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('workspace-agent-hub-verify-' + [guid]::NewGuid().ToString('N'))

. (Join-Path $PSScriptRoot 'npm-bootstrap.ps1')

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

function Get-PowerShellPath {
    $pwsh = Get-Command 'pwsh.exe' -ErrorAction SilentlyContinue
    if ($pwsh) {
        return $pwsh.Source
    }

    return (Get-Command 'powershell.exe' -ErrorAction Stop).Source
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

function Start-VerifyScriptProcess {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [string]$ScriptPath
    )

    $stdoutPath = Join-Path $tempRoot ($Name + '.stdout.log')
    $stderrPath = Join-Path $tempRoot ($Name + '.stderr.log')
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = Get-PowerShellPath
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
    [void]$process.Start()

    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()

    return [pscustomobject]@{
        Name = $Name
        Process = $process
        StdOutTask = $stdoutTask
        StdErrTask = $stderrTask
        StdOutPath = $stdoutPath
        StdErrPath = $stderrPath
    }
}

function Wait-ForVerifyScriptProcess {
    param(
        [Parameter(Mandatory = $true)]
        $ProcessInfo
    )

    $ProcessInfo.Process.WaitForExit()
    $stdoutText = $ProcessInfo.StdOutTask.GetAwaiter().GetResult()
    $stderrText = $ProcessInfo.StdErrTask.GetAwaiter().GetResult()
    [System.IO.File]::WriteAllText($ProcessInfo.StdOutPath, $stdoutText, [Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText($ProcessInfo.StdErrPath, $stderrText, [Text.UTF8Encoding]::new($false))

    if ($ProcessInfo.Process.ExitCode -eq 0) {
        return
    }

    $detail = if ($stderrText.Trim()) { $stderrText.Trim() } elseif ($stdoutText.Trim()) { $stdoutText.Trim() } else { '' }
    if ($detail) {
        throw "$($ProcessInfo.Name) failed. $detail"
    }

    throw "$($ProcessInfo.Name) failed with exit code $($ProcessInfo.Process.ExitCode)."
}

function Dispose-VerifyScriptProcess {
    param(
        [Parameter(Mandatory = $true)]
        $ProcessInfo
    )

    try {
        if ($ProcessInfo.Process -and -not $ProcessInfo.Process.HasExited) {
            $ProcessInfo.Process.Kill()
            $ProcessInfo.Process.WaitForExit()
        }
    } catch {
    }

    if ($ProcessInfo.Process) {
        $ProcessInfo.Process.Dispose()
    }
}

[System.IO.Directory]::CreateDirectory($tempRoot) | Out-Null
$processInfos = @()

try {
    Push-Location $repoRoot
    try {
        if ((Test-Path -Path $packageJsonPath) -and (-not (Test-NpmDependencySurfaceReady -RepoRoot $repoRoot))) {
            npm ci
            if ($LASTEXITCODE -ne 0) {
                throw 'npm ci failed.'
            }
        }
    } finally {
        Pop-Location
    }

    $processInfos = @(
        (Start-VerifyScriptProcess -Name 'lint' -ScriptPath $lintScriptPath),
        (Start-VerifyScriptProcess -Name 'test' -ScriptPath $testScriptPath)
    )

    Wait-Process -Id (@($processInfos | ForEach-Object { $_.Process.Id }))
    foreach ($processInfo in $processInfos) {
        Wait-ForVerifyScriptProcess -ProcessInfo $processInfo
    }

    & $buildScriptPath
    if ($LASTEXITCODE -ne 0) {
        throw 'scripts/build.ps1 failed.'
    }

    & $launcherScriptPath -SmokeTest
    if ($LASTEXITCODE -ne 0) {
        throw 'scripts/agent-session-launcher.ps1 -SmokeTest failed.'
    }
} finally {
    foreach ($processInfo in @($processInfos)) {
        Dispose-VerifyScriptProcess -ProcessInfo $processInfo
    }
    if (Test-Path -Path $tempRoot) {
        [System.IO.Directory]::Delete($tempRoot, $true)
    }
}

Write-Output 'Verify OK.'
