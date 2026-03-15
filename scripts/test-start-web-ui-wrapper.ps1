Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$wrapperScriptPath = Join-Path $PSScriptRoot 'start-web-ui.ps1'
$job = $null

function Get-FreeTcpPort {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    try {
        $listener.Start()
        return ([int]$listener.LocalEndpoint.Port)
    } finally {
        $listener.Stop()
    }
}

try {
    $port = Get-FreeTcpPort
    $job = Start-Job -ScriptBlock {
        param(
            [Parameter(Mandatory = $true)]
            [string]$ScriptPath,
            [Parameter(Mandatory = $true)]
            [int]$Port
        )

        & $ScriptPath `
            -PhoneReady `
            -NoOpenBrowser `
            -ListenHost '127.0.0.1' `
            -Port $Port `
            -AuthToken 'secret-token' `
            -PublicUrl 'https://hub.example.test/connect'
    } -ArgumentList $wrapperScriptPath, $port

    $serverReady = $false
    $listenUrl = "http://127.0.0.1:$port/"
    $apiUrl = "http://127.0.0.1:$port/api/sessions"
    for ($i = 0; $i -lt 100; $i += 1) {
        Start-Sleep -Milliseconds 200

        $jobState = (Get-Job -Id $job.Id).State
        if ($jobState -eq 'Failed') {
            break
        }

        try {
            $response = Invoke-WebRequest `
                -Uri $listenUrl `
                -Method Get `
                -TimeoutSec 2 `
                -UseBasicParsing `
                -ErrorAction Stop
            if (
                $response.StatusCode -eq 200 -and
                $response.Content -match 'Workspace Agent Hub'
            ) {
                $serverReady = $true
                break
            }
        } catch {
        }
    }

    if (-not $serverReady) {
        $jobState = (Get-Job -Id $job.Id).State
        $details = (Receive-Job -Job $job -Keep -ErrorAction SilentlyContinue | Out-String).Trim()
        $errorText = (($job.ChildJobs | ForEach-Object { $_.Error | ForEach-Object { $_.ToString() } }) -join [Environment]::NewLine).Trim()
        throw "Expected the PowerShell wrapper to start the web UI server. State: $jobState Details: $details Errors: $errorText"
    }

    try {
        Invoke-WebRequest `
            -Uri $apiUrl `
            -Method Get `
            -TimeoutSec 2 `
            -UseBasicParsing `
            -ErrorAction Stop | Out-Null
        throw 'Expected /api/sessions to require an access code.'
    } catch {
        $statusCode = $_.Exception.Response.StatusCode.value__
        if ($statusCode -ne 401) {
            throw "Expected /api/sessions to return 401. Actual: $statusCode"
        }
    }

    Write-Output 'Wrapper startup path OK.'
} finally {
    if ($null -ne $job) {
        Stop-Job -Job $job -ErrorAction SilentlyContinue | Out-Null
        Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    }
}
