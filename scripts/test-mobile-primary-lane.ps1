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

Write-Output 'PASS'
