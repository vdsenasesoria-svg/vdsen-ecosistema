# Thin wrapper: the only implementation is the portable Node runner.
$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is required for T476.' }
node (Join-Path $PSScriptRoot 'test-auto-apply-emulator.cjs')
exit $LASTEXITCODE
