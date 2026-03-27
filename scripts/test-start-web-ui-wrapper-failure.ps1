Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$wrapperScriptPath = Join-Path $PSScriptRoot 'start-web-ui.ps1'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$stdoutPath = Join-Path $env:TEMP 'workspace-agent-hub-wrapper-failure-out.txt'
$stderrPath = Join-Path $env:TEMP 'workspace-agent-hub-wrapper-failure-err.txt'
$failingCliPath = Join-Path $env:TEMP 'workspace-agent-hub-wrapper-failure.js'

function Remove-TempFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if ([IO.File]::Exists($Path)) {
        for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
            try {
                if (-not [IO.File]::Exists($Path)) {
                    break
                }
                [IO.File]::SetAttributes($Path, [IO.FileAttributes]::Normal)
                if (-not [IO.File]::Exists($Path)) {
                    break
                }
                [IO.File]::Delete($Path)
                break
            } catch {
                if (-not [IO.File]::Exists($Path)) {
                    break
                }
                if ($attempt -eq 19) {
                    throw
                }
                Start-Sleep -Milliseconds 100
            }
        }
    }
}

function Get-PowerShellPath {
    $pwsh = Get-Command 'pwsh.exe' -ErrorAction SilentlyContinue
    if ($pwsh) {
        return $pwsh.Source
    }

    return (Get-Command 'powershell.exe' -ErrorAction Stop).Source
}

Remove-TempFile -Path $stdoutPath
Remove-TempFile -Path $stderrPath
Remove-TempFile -Path $failingCliPath

$process = $null

try {
    [IO.File]::WriteAllText(
        $failingCliPath,
        "console.error('synthetic start-web-ui failure'); process.exit(42);",
        [Text.UTF8Encoding]::new($false)
    )
    $env:WORKSPACE_AGENT_HUB_TEST_CLI_PATH = $failingCliPath

    $process = Start-Process `
        -FilePath (Get-PowerShellPath) `
        -ArgumentList @(
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            $wrapperScriptPath,
            '-PhoneReady',
            '-NoOpenBrowser',
            '-JsonOutput',
            '-Port',
            '0',
            '-AuthToken',
            'secret-token'
        ) `
        -WorkingDirectory $repoRoot `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -WindowStyle Hidden `
        -Wait `
        -PassThru

    if ($process.ExitCode -ne 42) {
        throw "Expected wrapper exit code 42. Actual: $($process.ExitCode)"
    }

    $stderrText = if ([IO.File]::Exists($stderrPath)) {
        (Get-Content -Path $stderrPath -Raw -Encoding utf8).Trim()
    } else {
        ''
    }
    if ($stderrText -notmatch 'synthetic start-web-ui failure') {
        throw "Expected child stderr in wrapper log. Actual stderr: $stderrText"
    }
    if ($stderrText -notmatch 'Workspace Agent Hub web UI exited with code 42\.') {
        throw "Expected wrapper stderr to include exit code detail. Actual stderr: $stderrText"
    }
    if ($stderrText -match 'Workspace Agent Hub web UI exited with an error\.') {
        throw "Expected wrapper stderr to avoid the old generic error text. Actual stderr: $stderrText"
    }

    Write-Output 'Wrapper failure logging OK.'
} finally {
    if ($process) {
        $process.Dispose()
    }
    Remove-Item Env:WORKSPACE_AGENT_HUB_TEST_CLI_PATH -ErrorAction SilentlyContinue
    Remove-TempFile -Path $stdoutPath
    Remove-TempFile -Path $stderrPath
    Remove-TempFile -Path $failingCliPath
}
