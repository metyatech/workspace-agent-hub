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
            -Port $Port `
            -AuthToken 'secret-token' `
            -PublicUrl 'https://hub.example.test/connect'
    } -ArgumentList $wrapperScriptPath, $port

    $serverReady = $false
    for ($i = 0; $i -lt 100; $i += 1) {
        Start-Sleep -Milliseconds 200
        try {
            $response = Invoke-WebRequest `
                -Uri "http://127.0.0.1:$port/" `
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
        throw 'Expected the PowerShell wrapper to start the web UI server in PhoneReady mode.'
    }

    Write-Output 'Wrapper startup path OK.'
} finally {
    if ($null -ne $job) {
        Stop-Job -Job $job -ErrorAction SilentlyContinue | Out-Null
        Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    }
}
