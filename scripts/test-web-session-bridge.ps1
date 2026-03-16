Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$bridgeScriptPath = Join-Path $PSScriptRoot 'session-web-bridge.ps1'
$sessionLabel = 'web-test-' + ([guid]::NewGuid().ToString('N').Substring(0, 8))
$resolvedSessionName = "shell-$sessionLabel"
$preferredPowerShell = Get-Command 'pwsh.exe' -ErrorAction SilentlyContinue
$powerShellPath = if ($preferredPowerShell) { $preferredPowerShell.Source } else { (Get-Command 'powershell.exe' -ErrorAction Stop).Source }

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

function Invoke-HiddenPowerShell {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ScriptPath,
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $powerShellPath
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardOutputEncoding = [Text.Encoding]::UTF8
    $startInfo.StandardErrorEncoding = [Text.Encoding]::UTF8
    foreach ($argument in (@('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ScriptPath) + $Arguments)) {
        [void]$startInfo.ArgumentList.Add([string]$argument)
    }

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    [void]$process.Start()
    $stdoutText = $process.StandardOutput.ReadToEnd()
    $stderrText = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    return [pscustomobject]@{
        ExitCode = $process.ExitCode
        StdOut = $stdoutText
        StdErr = $stderrText
    }
}

function Invoke-BridgeJson {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $result = Invoke-HiddenPowerShell -ScriptPath $bridgeScriptPath -Arguments $Arguments
    if ($result.ExitCode -ne 0) {
        $detail = if ($result.StdErr.Trim()) { $result.StdErr.Trim() } elseif ($result.StdOut.Trim()) { $result.StdOut.Trim() } else { "Exit code $($result.ExitCode)." }
        throw "Bridge command failed. Args: $($Arguments -join ' ') $detail"
    }

    return (($result.StdOut.Trim()) | ConvertFrom-Json)
}

function New-Utf8PayloadFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Value,
        [Parameter(Mandatory = $true)]
        [string]$Prefix
    )

    $tempPath = Join-Path $env:TEMP ("workspace-agent-hub-$Prefix-" + [guid]::NewGuid().ToString('N') + '.txt')
    Set-Content -Path $tempPath -Value $Value -NoNewline -Encoding utf8
    return $tempPath
}

$titlePayloadPath = ''

try {
    $titlePayloadPath = New-Utf8PayloadFile -Value 'テスト' -Prefix 'title'
    $started = Invoke-BridgeJson -Arguments @(
        '-Action', 'start',
        '-Type', 'shell',
        '-SessionName', $sessionLabel,
        '-TitlePath', $titlePayloadPath,
        '-WorkingDirectory', 'D:\ghws',
        '-Json'
    )

    if ([string]$started.Name -ne $resolvedSessionName) {
        throw "Unexpected session name. Expected '$resolvedSessionName', got '$($started.Name)'."
    }
    if ([string]$started.DisplayTitle -ne 'テスト') {
        throw "Expected the started shell session title to preserve UTF-8 text. Got '$([string]$started.DisplayTitle)'."
    }
    if (-not [bool]$started.IsLive) {
        throw 'Expected started shell session to be live.'
    }

    $listedSessions = @(Invoke-BridgeJson -Arguments @(
        '-Action', 'list',
        '-IncludeArchived',
        '-Json'
    ))
    $listed = @($listedSessions | Where-Object { [string]$_.Name -eq $resolvedSessionName })
    if ($listed.Count -ne 1) {
        throw 'Expected the newly started shell session to appear exactly once in the web-session inventory.'
    }
    if ([string]$listed[0].DisplayTitle -ne 'テスト') {
        throw "Expected the listed shell session title to preserve UTF-8 text. Got '$([string]$listed[0].DisplayTitle)'."
    }
    if (-not [bool]$listed[0].IsLive) {
        throw 'Expected the newly started shell session to be live in the web-session inventory.'
    }

    [void](Invoke-BridgeJson -Arguments @(
        '-Action', 'send',
        '-SessionName', $resolvedSessionName,
        '-Text', 'echo web-ui-bridge-pass',
        '-Submit',
        '-Json'
    ))

    Start-Sleep -Milliseconds 500

    $output = Invoke-BridgeJson -Arguments @(
        '-Action', 'output',
        '-SessionName', $resolvedSessionName,
        '-Lines', '80',
        '-Json'
    )

    if ([string]$output.Transcript -notmatch 'web-ui-bridge-pass') {
        throw 'Expected transcript to include the sent shell output.'
    }

    [void](Invoke-BridgeJson -Arguments @(
        '-Action', 'interrupt',
        '-SessionName', $resolvedSessionName,
        '-Json'
    ))

    [void](Invoke-BridgeJson -Arguments @(
        '-Action', 'close',
        '-SessionName', $resolvedSessionName,
        '-Json'
    ))

    [void](Invoke-BridgeJson -Arguments @(
        '-Action', 'delete',
        '-SessionName', $resolvedSessionName,
        '-Json'
    ))

    Write-Output 'PASS'
} finally {
    if ($titlePayloadPath -and (Test-Path -Path $titlePayloadPath)) {
        [IO.File]::Delete($titlePayloadPath)
    }
    try {
        [void](Invoke-HiddenPowerShell -ScriptPath $bridgeScriptPath -Arguments @('-Action', 'delete', '-SessionName', $resolvedSessionName, '-Json'))
    } catch {
    }
}
