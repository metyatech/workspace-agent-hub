Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$sessionManagementOutput = & (Join-Path $PSScriptRoot 'test-session-management.ps1')
if (($sessionManagementOutput | Out-String).Trim() -notmatch 'PASS') {
    throw 'Expected the launcher session management commands to rename, archive, close, and delete sessions.'
}

$webSessionBridgeOutput = & (Join-Path $PSScriptRoot 'test-web-session-bridge.ps1')
if (($webSessionBridgeOutput | Out-String).Trim() -notmatch 'PASS') {
    throw 'Expected the web-session bridge to start, send to, capture, interrupt, close, and delete a shell session.'
}

Write-Output 'PASS'
