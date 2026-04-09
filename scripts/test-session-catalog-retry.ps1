Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$launcherScript = Join-Path $PSScriptRoot 'agent-session-launcher.ps1'
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('workspace-agent-hub-session-catalog-' + [guid]::NewGuid().ToString('N'))
$catalogPath = Join-Path $tempRoot 'session-catalog.json'
$liveDirPath = Join-Path $tempRoot 'session-live'
$validCatalogSnapshotPath = Join-Path $tempRoot 'session-catalog.valid.json'
$writerScriptPath = Join-Path $tempRoot 'recover-session-catalog.ps1'
$encoding = [System.Text.UTF8Encoding]::new($false)

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

[System.IO.Directory]::CreateDirectory($liveDirPath) | Out-Null
[System.IO.File]::WriteAllText($catalogPath, "[]`n", $encoding)

$previousCatalogPath = $env:AI_AGENT_SESSION_CATALOG_PATH
$previousLiveDirPath = $env:AI_AGENT_SESSION_LIVE_DIR_PATH

$env:AI_AGENT_SESSION_CATALOG_PATH = $catalogPath
$env:AI_AGENT_SESSION_LIVE_DIR_PATH = $liveDirPath

$writerProcess = $null
try {
    $validCatalogText = @'
[
  {
    "session_name": "shell-session-catalog-retry",
    "session_type": "shell",
    "title": "Session Catalog Retry",
    "working_directory_windows": "D:\\ghws\\workspace-agent-hub",
    "archived": false,
    "created_utc": "2026-01-01T00:00:00.000Z",
    "updated_utc": "2026-01-01T00:00:00.000Z"
  }
]
'@.Trim() + "`n"

    [System.IO.File]::WriteAllText($catalogPath, "[`n", $encoding)
    [System.IO.File]::WriteAllText($validCatalogSnapshotPath, $validCatalogText, $encoding)

    $writerScript = @'
param(
    [Parameter(Mandatory = $true)]
    [string]$CatalogPath,
    [Parameter(Mandatory = $true)]
    [string]$ValidCatalogPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

[System.Threading.Thread]::Sleep(250)
$encoding = [System.Text.UTF8Encoding]::new($false)
$text = [System.IO.File]::ReadAllText($ValidCatalogPath, $encoding)
[System.IO.File]::WriteAllText($CatalogPath, $text, $encoding)
'@
    [System.IO.File]::WriteAllText($writerScriptPath, $writerScript.Trim() + "`n", $encoding)

    $writerStartInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $writerStartInfo.FileName = Get-PowerShellPath
    $writerStartInfo.UseShellExecute = $false
    $writerStartInfo.CreateNoWindow = $true
    $writerStartInfo.RedirectStandardError = $true
    $writerStartInfo.RedirectStandardOutput = $true
    $writerArgumentList = @(
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        $writerScriptPath,
        '-CatalogPath',
        $catalogPath,
        '-ValidCatalogPath',
        $validCatalogSnapshotPath
    )
    if ($writerStartInfo.PSObject.Properties.Name -contains 'ArgumentList') {
        foreach ($argument in $writerArgumentList) {
            [void]$writerStartInfo.ArgumentList.Add([string]$argument)
        }
    } else {
        $writerStartInfo.Arguments = ConvertTo-QuotedArgumentString -ArgumentList $writerArgumentList
    }

    $writerProcess = [System.Diagnostics.Process]::new()
    $writerProcess.StartInfo = $writerStartInfo
    [void]$writerProcess.Start()

    $listOutput = & $launcherScript -Mode list -IncludeArchived -Json
    $writerProcess.WaitForExit()

    if ($writerProcess.ExitCode -ne 0) {
        $writerError = $writerProcess.StandardError.ReadToEnd().Trim()
        if (-not $writerError) {
            $writerError = $writerProcess.StandardOutput.ReadToEnd().Trim()
        }
        if (-not $writerError) {
            $writerError = 'Writer process exited without error details.'
        }
        throw "The delayed catalog recovery writer failed. $writerError"
    }

    if ($LASTEXITCODE -ne 0) {
        throw 'agent-session-launcher list failed while the catalog file was recovering from a transient partial write.'
    }

    $parsed = ($listOutput | Out-String).Trim() | ConvertFrom-Json
    $items = if ($parsed -is [System.Array]) { @($parsed) } else { @($parsed) }
    $matched = $items | Where-Object { [string]$_.DisplayTitle -eq 'Session Catalog Retry' } | Select-Object -First 1
    if (-not $matched) {
        throw 'Expected agent-session-launcher to recover from a transient partial catalog write and return the catalog-backed session title.'
    }

    Write-Output 'PASS'
} finally {
    foreach ($entry in @(
            @{ Name = 'AI_AGENT_SESSION_CATALOG_PATH'; Value = $previousCatalogPath },
            @{ Name = 'AI_AGENT_SESSION_LIVE_DIR_PATH'; Value = $previousLiveDirPath }
        )) {
        if ($null -eq $entry.Value) {
            [Environment]::SetEnvironmentVariable($entry.Name, $null, 'Process')
        } else {
            [Environment]::SetEnvironmentVariable($entry.Name, $entry.Value, 'Process')
        }
    }

    if ($writerProcess) {
        try {
            if (-not $writerProcess.HasExited) {
                $writerProcess.Kill()
                $writerProcess.WaitForExit()
            }
        } catch {
        }
        $writerProcess.Dispose()
    }

    if (Test-Path -Path $tempRoot) {
        [System.IO.Directory]::Delete($tempRoot, $true)
    }
}
