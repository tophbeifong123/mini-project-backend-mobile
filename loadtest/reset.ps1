# Reset all 20 products to seed defaults, clear orders, flush Redis.
# PowerShell version (Windows-native).
#
# Usage:
#   .\loadtest\reset.ps1

$ErrorActionPreference = 'Stop'

$ComposeCmd = $null
foreach ($candidate in @('docker', 'docker.exe')) {
    $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($cmd -and (& $candidate version 2>&1 | Out-Null)) {
        $ComposeCmd = $candidate
        break
    }
}

if (-not $ComposeCmd) {
    Write-Host "ERROR: docker (or docker.exe) not found / not responding." -ForegroundColor Red
    Write-Host "  Is Docker Desktop running?" -ForegroundColor Red
    exit 1
}

$env:POSTGRES_USER = if ($env:POSTGRES_USER) { $env:POSTGRES_USER } else { 'app' }
$env:POSTGRES_PASSWORD = if ($env:POSTGRES_PASSWORD) { $env:POSTGRES_PASSWORD } else { 'app123' }
$env:POSTGRES_DB = if ($env:POSTGRES_DB) { $env:POSTGRES_DB } else { 'flashsale' }

$SeedFile = Join-Path $PSScriptRoot '..\products-seed.json'
if (-not (Test-Path $SeedFile)) {
    Write-Host "ERROR: $SeedFile not found." -ForegroundColor Red
    exit 1
}

$Seed = Get-Content $SeedFile -Raw | ConvertFrom-Json

$ResultsDir = Join-Path $PSScriptRoot 'results'
if (-not (Test-Path $ResultsDir)) {
    New-Item -ItemType Directory -Force -Path $ResultsDir | Out-Null
}

Write-Host "Using: $ComposeCmd compose"
Write-Host "Resetting all $($Seed.Count) products from products-seed.json..."

$CaseStatements = ($Seed | ForEach-Object {
    "WHEN '$($_.productId)' THEN $($_.availableStock)"
}) -join ' '

$UpdateSql = "UPDATE products SET `"remainingStock`" = CASE `"productId`" $CaseStatements END;"

Write-Host "-> Updating stock for $($Seed.Count) products..."
& $ComposeCmd compose exec -T -e "PGPASSWORD=$($env:POSTGRES_PASSWORD)" postgres-primary `
    psql -h 127.0.0.1 -U $env:POSTGRES_USER -d $env:POSTGRES_DB -c $UpdateSql

Write-Host "-> Truncating orders table..."
& $ComposeCmd compose exec -T -e "PGPASSWORD=$($env:POSTGRES_PASSWORD)" postgres-primary `
    psql -h 127.0.0.1 -U $env:POSTGRES_USER -d $env:POSTGRES_DB -c 'TRUNCATE TABLE "orders";'

Write-Host "-> Flushing Redis cache + counters..."
& $ComposeCmd compose exec -T redis redis-cli FLUSHDB | Out-Null

Write-Host "-> Verifying reset..."
& $ComposeCmd compose exec -T -e "PGPASSWORD=$($env:POSTGRES_PASSWORD)" postgres-primary `
    psql -h 127.0.0.1 -U $env:POSTGRES_USER -d $env:POSTGRES_DB -tA -c `
    "SELECT `"productId`" || ' | remaining=' || `"remainingStock`" || ' | available=' || `"availableStock`" FROM products ORDER BY `"productId`";"

& $ComposeCmd compose exec -T -e "PGPASSWORD=$($env:POSTGRES_PASSWORD)" postgres-primary `
    psql -h 127.0.0.1 -U $env:POSTGRES_USER -d $env:POSTGRES_DB -tA -c `
    "SELECT 'orders count: ' || count(*) FROM orders;"

Write-Host "Reset complete. Ready for k6 run." -ForegroundColor Green
Write-Host "  Run: k6 run --env BASE_URL=http://localhost --out json=loadtest\results\summary.json loadtest\flash-sale.js"
Write-Host "  Then: .\loadtest\verify.ps1"
