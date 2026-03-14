Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$stdoutPath = Join-Path $env:TEMP 'workspace-agent-hub-web-ui-json-out.txt'
$stderrPath = Join-Path $env:TEMP 'workspace-agent-hub-web-ui-json-err.txt'

function Remove-TempFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if ([IO.File]::Exists($Path)) {
        for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
            try {
                [IO.File]::SetAttributes($Path, [IO.FileAttributes]::Normal)
                [IO.File]::Delete($Path)
                break
            } catch {
                if ($attempt -eq 19) {
                    throw
                }
                Start-Sleep -Milliseconds 200
            }
        }
    }
}

Remove-TempFile -Path $stdoutPath
Remove-TempFile -Path $stderrPath

$process = $null

try {
    $process = Start-Process `
        -FilePath 'node' `
        -ArgumentList @(
            'dist/cli.js',
            'web-ui',
            '--host', '127.0.0.1',
            '--port', '0',
            '--auth-token', 'secret-token',
            '--public-url', 'https://hub.example.test/connect',
            '--json',
            '--no-open-browser'
        ) `
        -WorkingDirectory $repoRoot `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -PassThru

    $jsonLine = ''
    for ($i = 0; $i -lt 100; $i += 1) {
        Start-Sleep -Milliseconds 200
        if ([IO.File]::Exists($stdoutPath)) {
            $jsonLine = (Get-Content $stdoutPath | Select-Object -First 1)
            if ($jsonLine) {
                break
            }
        }
    }

    if (-not $jsonLine) {
        throw 'Expected JSON launch metadata on stdout.'
    }

    $payload = $jsonLine | ConvertFrom-Json
    if ($payload.listenUrl -notmatch '^http://127\.0\.0\.1:\d+$') {
        throw "Unexpected listenUrl: $($payload.listenUrl)"
    }
    if ($payload.preferredConnectUrl -ne 'https://hub.example.test/connect') {
        throw "Unexpected preferredConnectUrl: $($payload.preferredConnectUrl)"
    }
    if ($payload.authRequired -ne $true) {
        throw "Expected authRequired=true. Actual: $($payload.authRequired)"
    }
    if ($payload.accessCode -ne 'secret-token') {
        throw "Unexpected accessCode: $($payload.accessCode)"
    }
    if (
        $payload.oneTapPairingLink -ne
        'https://hub.example.test/connect#accessCode=secret-token'
    ) {
        throw "Unexpected oneTapPairingLink: $($payload.oneTapPairingLink)"
    }

    Write-Output 'JSON launch metadata OK.'
} finally {
    if ($null -ne $process -and -not $process.HasExited) {
        Stop-Process -Id $process.Id -Force
        Wait-Process -Id $process.Id -ErrorAction SilentlyContinue
    }
    Remove-TempFile -Path $stdoutPath
    Remove-TempFile -Path $stderrPath
}
