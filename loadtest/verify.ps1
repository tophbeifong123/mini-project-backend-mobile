# Post-loadtest verification: SQL data integrity + Redis cache state.
# PowerShell version. Prints a console report.
#
# Usage:
#   .\loadtest\verify.ps1

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
    Write-Host "ERROR: docker (or docker.exe) not found." -ForegroundColor Red
    exit 1
}

$env:POSTGRES_USER = if ($env:POSTGRES_USER) { $env:POSTGRES_USER } else { 'app' }
$env:POSTGRES_PASSWORD = if ($env:POSTGRES_PASSWORD) { $env:POSTGRES_PASSWORD } else { 'app123' }
$env:POSTGRES_DB = if ($env:POSTGRES_DB) { $env:POSTGRES_DB } else { 'flashsale' }

function Invoke-Pgsql {
    param([string]$Sql)
    & $ComposeCmd compose exec -T -e "PGPASSWORD=$($env:POSTGRES_PASSWORD)" postgres-primary `
        psql -h 127.0.0.1 -U $env:POSTGRES_USER -d $env:POSTGRES_DB -tA -c $Sql
}

function Invoke-Redis {
    param([string[]]$Args)
    $argList = @('exec', '-T', 'redis', 'redis-cli') + $Args
    & $ComposeCmd compose @argList
}

$PassCount = 0
$FailCount = 0

function Print-Header {
    param([string]$Title)
    Write-Host ''
    Write-Host '============================================================' -ForegroundColor Cyan
    Write-Host "  $Title" -ForegroundColor Cyan
    Write-Host '============================================================' -ForegroundColor Cyan
}

function Check-Pass {
    param([string]$Message)
    Write-Host "  [PASS] $Message" -ForegroundColor Green
    $script:PassCount++
}

function Check-Fail {
    param([string]$Message)
    Write-Host "  [FAIL] $Message" -ForegroundColor Red
    $script:FailCount++
}

function Check-Warn {
    param([string]$Message)
    Write-Host "  [WARN] $Message" -ForegroundColor Yellow
}

# 1. Stock integrity
Print-Header '1. Stock Integrity - All 20 Products'

Write-Host ''
Write-Host '  productId    | available | remaining | sold'
Write-Host '  -------------|-----------|-----------|------'
$Rows = Invoke-Pgsql "SELECT `"productId`", `"availableStock`", `"remainingStock`", (`"availableStock`" - `"remainingStock`") FROM products ORDER BY `"productId`";"
foreach ($row in $Rows) {
    $cols = $row -split '\|'
    if ($cols.Count -ge 4) {
        Write-Host ("  {0,-12} | {1,-9} | {2,-9} | {3}" -f $cols[0], $cols[1], $cols[2], $cols[3])
    }
}

$Negative = (Invoke-Pgsql 'SELECT COUNT(*) FROM products WHERE "remainingStock" < 0;').Trim()
if ($Negative -eq '0') {
    Check-Pass 'No product has negative remainingStock'
} else {
    Check-Fail "Found $Negative product(s) with negative remainingStock"
}

# 2. Non-target products unchanged
Print-Header '2. Non-Target Products - Stock Must Be Unchanged'

$Unchanged = (Invoke-Pgsql "SELECT COUNT(*) FROM products WHERE `"productId`" != 'p-1001' AND `"remainingStock`" != `"availableStock`";").Trim()
if ($Unchanged -eq '0') {
    Check-Pass 'All 19 non-p-1001 products have remainingStock == availableStock'
} else {
    Check-Fail "$Unchanged non-p-1001 product(s) were modified unexpectedly"
    Invoke-Pgsql "SELECT `"productId`" || ' | remaining=' || `"remainingStock`" || ' | available=' || `"availableStock`" FROM products WHERE `"productId`" != 'p-1001' AND `"remainingStock`" != `"availableStock`";"
}

# 3. p-1001 target
Print-Header '3. p-1001 (Heavy Load Target)'

$P1001Line = Invoke-Pgsql "SELECT (`"availableStock`" - `"remainingStock`"), `"remainingStock`" FROM products WHERE `"productId`" = 'p-1001';"
$P1001Cols = $P1001Line -split '\|'
$P1001Sold = $P1001Cols[0]
$P1001Remaining = $P1001Cols[1]

$SuccessP1001 = (Invoke-Pgsql "SELECT COUNT(*) FROM orders WHERE `"productId`" = 'p-1001' AND status = 'SUCCESS';").Trim()
$UniqueUsers = (Invoke-Pgsql "SELECT COUNT(DISTINCT `"userId`") FROM orders WHERE `"productId`" = 'p-1001' AND status = 'SUCCESS';").Trim()
$FailedP1001 = (Invoke-Pgsql "SELECT COUNT(*) FROM orders WHERE `"productId`" = 'p-1001' AND status = 'FAILED';").Trim()

Write-Host ''
Write-Host "  sold (DB)         : $P1001Sold"
Write-Host "  remainingStock    : $P1001Remaining"
Write-Host "  SUCCESS orders    : $SuccessP1001"
Write-Host "  unique users      : $UniqueUsers"
Write-Host "  FAILED orders     : $FailedP1001"
Write-Host ''

if ($P1001Remaining -eq '0') {
    Check-Pass 'p-1001 remainingStock = 0 (not oversold, not negative)'
} else {
    Check-Fail "p-1001 remainingStock = $P1001Remaining (expected 0)"
}

if ($P1001Sold -eq $SuccessP1001) {
    Check-Pass "p-1001 sold ($P1001Sold) == SUCCESS orders ($SuccessP1001)"
} else {
    Check-Fail "Mismatch: sold=$P1001Sold vs SUCCESS=$SuccessP1001"
}

if ($UniqueUsers -eq $SuccessP1001) {
    Check-Pass 'Each SUCCESS order belongs to a unique user'
} else {
    Check-Fail "Duplicate orders detected: SUCCESS=$SuccessP1001 but unique users=$UniqueUsers"
}

$ExpectedP1001 = 50
if ($SuccessP1001 -eq "$ExpectedP1001") {
    Check-Pass "Exactly $ExpectedP1001 SUCCESS orders for p-1001 (matches stock)"
} else {
    Check-Fail "Expected $ExpectedP1001 SUCCESS orders for p-1001, got $SuccessP1001"
}

# 4. Order integrity global
Print-Header '4. Order Integrity - Global'

$TotalOrders = (Invoke-Pgsql 'SELECT COUNT(*) FROM orders;').Trim()
$TotalSuccess = (Invoke-Pgsql "SELECT COUNT(*) FROM orders WHERE status = 'SUCCESS';").Trim()
$TotalFailed = (Invoke-Pgsql "SELECT COUNT(*) FROM orders WHERE status = 'FAILED';").Trim()
$TotalDuplicates = (Invoke-Pgsql 'SELECT COUNT(*) FROM (SELECT "userId", "productId" FROM orders GROUP BY "userId", "productId" HAVING COUNT(*) > 1) sub;').Trim()
$StockDecreased = (Invoke-Pgsql 'SELECT COALESCE(SUM("availableStock" - "remainingStock"), 0) FROM products;').Trim()

Write-Host ''
Write-Host "  total orders        : $TotalOrders"
Write-Host "  SUCCESS orders      : $TotalSuccess"
Write-Host "  FAILED orders       : $TotalFailed"
Write-Host "  duplicate pairs     : $TotalDuplicates"
Write-Host "  total stock sold    : $StockDecreased"
Write-Host ''

if ($TotalDuplicates -eq '0') {
    Check-Pass 'No duplicate (userId, productId) pairs'
} else {
    Check-Fail "$TotalDuplicates duplicate order pair(s) found"
}

if ($StockDecreased -eq $TotalSuccess) {
    Check-Pass "Stock decreased ($StockDecreased) matches SUCCESS orders ($TotalSuccess)"
} else {
    Check-Fail "Mismatch: stock_decreased=$StockDecreased vs SUCCESS=$TotalSuccess"
}

# 5. Redis cache state
Print-Header '5. Redis Cache State'

try {
    $CacheStats = & $ComposeCmd compose exec -T nest-1 curl -s http://localhost:3000/api/v1/products/admin/cache-stats 2>$null
} catch {
    $CacheStats = '{}'
}

$Hits = if ($CacheStats -match '"hits":(\d+)') { $Matches[1] } else { '0' }
$Misses = if ($CacheStats -match '"misses":(\d+)') { $Matches[1] } else { '0' }
$Ratio = if ($CacheStats -match '"hitRatio":([\d.]+)') { $Matches[1] } else { '0' }

$TrackedKeys = (Invoke-Redis 'SMEMBERS' 'cache:tracked:products') | Where-Object { $_ -and $_.Trim() -ne '' } | Measure-Object | Select-Object -ExpandProperty Count

Write-Host ''
Write-Host "  cache hits         : $Hits"
Write-Host "  cache misses       : $Misses"
Write-Host "  cache hit ratio    : $Ratio"
Write-Host "  tracked cache keys : $TrackedKeys"
Write-Host ''

if ([int]$Misses -gt 0) {
    $RatioInt = [int]([math]::Round([double]$Ratio * 100))
    if ($RatioInt -ge 70) {
        Check-Pass "Cache hit ratio = $Ratio (>= 70%)"
    } else {
        Check-Warn "Cache hit ratio = $Ratio (< 70%)"
    }
} else {
    Check-Pass 'Cache tracking active'
}

# 6. Summary
Print-Header '6. Summary'

Write-Host ''
Write-Host "  Passed: $PassCount" -ForegroundColor Green
Write-Host "  Failed: $FailCount" -ForegroundColor Red
Write-Host ''

if ($FailCount -eq 0) {
    Write-Host '  All data integrity checks passed.' -ForegroundColor Green
} else {
    Write-Host '  Some checks failed. Review the output above.' -ForegroundColor Red
}

Write-Host ''
