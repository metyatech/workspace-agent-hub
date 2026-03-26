Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$wrapperScriptPath = Join-Path $PSScriptRoot 'start-web-ui.ps1'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$rebuildSourcePath = Join-Path $repoRoot 'src\cli.ts'
$originalRebuildSourceWriteTimeUtc = (Get-Item -LiteralPath $rebuildSourcePath).LastWriteTimeUtc
$job = $null

function Wait-ForSingleJsonOutput {
    param(
        [Parameter(Mandatory = $true)]
        $Job,
        [int]$TimeoutMilliseconds = 60000
    )

    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
    $observedCount = 0
    do {
        $output = @(Receive-Job -Job $Job -Keep)
        if ($output.Count -gt $observedCount) {
            for ($index = $observedCount; $index -lt $output.Count; $index += 1) {
                $line = [string]$output[$index]
                if (-not $line.Trim()) {
                    continue
                }
                try {
                    return ($line | ConvertFrom-Json)
                } catch {
                    throw "Expected the wrapper to emit JSON only. Actual stdout: $line"
                }
            }
            $observedCount = $output.Count
        }

        if ($Job.State -in @('Completed', 'Failed', 'Stopped')) {
            break
        }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)

    $stdoutPreview = (@(Receive-Job -Job $Job -Keep) | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
    $stderrPreview = (
        $Job.ChildJobs |
            ForEach-Object { $_.Error } |
            ForEach-Object { $_.ToString() }
    ) -join [Environment]::NewLine
    throw "Expected the wrapper to emit exactly one JSON line on stdout. Actual stdout: $stdoutPreview Actual stderr: $stderrPreview"
}

try {
    (Get-Item -LiteralPath $rebuildSourcePath).LastWriteTimeUtc = [DateTime]::UtcNow.AddMinutes(1)

    $job = Start-Job -ScriptBlock {
        param(
            [Parameter(Mandatory = $true)]
            [string]$ScriptPath
        )

        & $ScriptPath `
            -PhoneReady `
            -NoOpenBrowser `
            -JsonOutput `
            -Port 0 `
            -AuthToken 'secret-token' `
            -PublicUrl 'https://hub.example.test/connect'
    } -ArgumentList $wrapperScriptPath

    $payload = Wait-ForSingleJsonOutput -Job $job
    if ($payload.listenUrl -notmatch '^http://(127\.0\.0\.1|0\.0\.0\.0):\d+$') {
        throw "Unexpected listenUrl: $($payload.listenUrl)"
    }
    if ($payload.preferredConnectUrl -ne 'https://hub.example.test/connect') {
        throw "Unexpected preferredConnectUrl: $($payload.preferredConnectUrl)"
    }
    if ($payload.preferredConnectUrlSource -ne 'public-url') {
        throw "Unexpected preferredConnectUrlSource: $($payload.preferredConnectUrlSource)"
    }
    if ($payload.authRequired -ne $true) {
        throw "Expected authRequired=true. Actual: $($payload.authRequired)"
    }
    if ($payload.accessCode -ne 'secret-token') {
        throw "Unexpected accessCode: $($payload.accessCode)"
    }

    $listenUrlForRequest = ([string]$payload.listenUrl) -replace '^http://0\.0\.0\.0:', 'http://127.0.0.1:'
    $response = Invoke-WebRequest `
        -Uri (($listenUrlForRequest.TrimEnd('/')) + '/api/sessions?includeArchived=true') `
        -Headers @{ 'X-Workspace-Agent-Hub-Token' = 'secret-token' } `
        -Method Get `
        -TimeoutSec 3 `
        -UseBasicParsing `
        -ErrorAction Stop
    if ($response.StatusCode -ne 200) {
        throw "Expected the PowerShell wrapper to start the web UI server. Actual status: $($response.StatusCode)"
    }

    Write-Output 'Wrapper startup path OK.'
} finally {
    if (Test-Path -LiteralPath $rebuildSourcePath) {
        (Get-Item -LiteralPath $rebuildSourcePath).LastWriteTimeUtc = $originalRebuildSourceWriteTimeUtc
    }
    if ($null -ne $job) {
        Stop-Job -Job $job -ErrorAction SilentlyContinue | Out-Null
        Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    }
}
