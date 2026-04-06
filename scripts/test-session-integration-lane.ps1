Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$primaryPathMatrixOutput = & (Join-Path $PSScriptRoot 'test-primary-path-matrix.ps1')
if (($primaryPathMatrixOutput | Out-String).Trim() -notmatch 'PASS') {
    throw 'Expected the PC-side primary path matrix verification to pass for start, inventory, and resume availability.'
}

$mobileSshOutput = python (Join-Path $PSScriptRoot 'test-mobile-ssh.py')
if (($mobileSshOutput | Out-String).Trim() -notmatch 'PASS') {
    throw 'Expected the SSH -> WSL mobile menu path to pass the mobile primary path matrix verification.'
}

$sessionManagementOutput = & (Join-Path $PSScriptRoot 'test-session-management.ps1')
if (($sessionManagementOutput | Out-String).Trim() -notmatch 'PASS') {
    throw 'Expected the launcher session management commands to rename, archive, close, and delete sessions.'
}

$webSessionBridgeOutput = & (Join-Path $PSScriptRoot 'test-web-session-bridge.ps1')
if (($webSessionBridgeOutput | Out-String).Trim() -notmatch 'PASS') {
    throw 'Expected the web-session bridge to start, send to, capture, interrupt, close, and delete a shell session.'
}

Write-Output 'PASS'
