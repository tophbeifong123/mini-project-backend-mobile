# PowerShell wrapper calling the cross-platform Node.js runner
param (
    [string]$BaseUrl = "http://localhost:8080"
)

$ScriptPath = Join-Path $PSScriptRoot "run-all.js"
node $ScriptPath $BaseUrl
