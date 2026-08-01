[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$WorkerPath = Join-Path $RepoRoot "src\worker.tsx"
$DomainPath = Join-Path $RepoRoot "src\domain\testing.ts"
$MigrationPath = Join-Path $RepoRoot "migrations\0001_campaigns.sql"
$AppPath = Join-Path $RepoRoot "public\app.js"
$CampaignPath = Join-Path $RepoRoot "public\campaign.js"
$StylesPath = Join-Path $RepoRoot "public\styles.css"
$WranglerPath = Join-Path $RepoRoot "wrangler.jsonc"
$PublicDirectory = Join-Path $RepoRoot "public"

$RequiredFiles = @(
    "DECISIONS.md",
    "EXPERIMENT.md",
    "METRICS.md",
    "PRIVACY.md",
    "README.md",
    "SECURITY.md",
    "STACK.md",
    ".github\workflows\ci.yml",
    "migrations\0001_campaigns.sql",
    "public\app.js",
    "public\campaign.js",
    "public\favicon.svg",
    "public\manifest.webmanifest",
    "public\styles.css",
    "public\og.svg",
    "public\robots.txt",
    "src\domain\testing.ts",
    "src\worker.tsx"
)
foreach ($RelativePath in $RequiredFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot $RelativePath))) {
        throw "Missing required release file: $RelativePath"
    }
}

$Worker = Get-Content -Raw -LiteralPath $WorkerPath
$Domain = Get-Content -Raw -LiteralPath $DomainPath
$Migration = Get-Content -Raw -LiteralPath $MigrationPath
$App = Get-Content -Raw -LiteralPath $AppPath
$Campaign = Get-Content -Raw -LiteralPath $CampaignPath
$Styles = Get-Content -Raw -LiteralPath $StylesPath
$Wrangler = Get-Content -Raw -LiteralPath $WranglerPath
$ProductSurface = @($Worker, $App, $Campaign) -join "`n"

if (-not $Worker.Contains('class="runway-preview"') -or
    -not $Worker.Contains('class="device-rack"') -or
    -not $Worker.Contains('class="runway-line"') -or
    -not $Worker.Contains('class="device-wall"') -or
    -not $Worker.Contains('class="runway-days"')) {
    throw "Expected the tester array and 14-day runway visualization"
}
if ($ProductSurface -match '(?i)public validation|success criteria|experiment|仮説|成功条件|市場スコア|移行候補|収益性') {
    throw "Research copy must not appear on the product surface"
}
if ($Styles -match '(?s)h1\s*\{[^}]*font-size:\s*(?:[4-9]\d|[1-9]\d{2})px') {
    throw "Primary heading is too large"
}
if ($Styles -match '(?i)gradient') {
    throw "Product CSS must not use gradients"
}
if (@($App, $Campaign) -join "`n" -match '(?i)innerHTML|eval\(|new Function') {
    throw "User content must not be interpreted as markup or code"
}
if (-not $Campaign.Contains("window.location.hash") -and -not $Campaign.Contains("location.hash")) {
    throw "Capability keys must be read from URL fragments"
}
if (-not $Worker.Contains("manager_token_hash") -or
    -not $Worker.Contains("token_hash") -or
    -not $Worker.Contains("await sha256(token)")) {
    throw "Capability URLs must store only key hashes"
}
if (-not $Worker.Contains("constantTimeEqual") -or
    -not $Worker.Contains("enforceSameOrigin") -or
    -not $Worker.Contains("create_rate_limited") -or
    -not $Worker.Contains("contact_not_allowed_in_")) {
    throw "Expected capability, origin, rate, and contact-data boundaries"
}
if (-not $Worker.Contains("current + 45 * 86400") -or
    -not $Worker.Contains("timestamp - 45 * 86400") -or
    -not $Worker.Contains("DELETE FROM campaigns WHERE expires_at <= ?") -or
    -not $Migration.Contains("ON DELETE CASCADE")) {
    throw "Expected bounded campaign, tester, progress, and event retention"
}
if ($Migration -match '(?i)email|phone_number|telephone|real_name|photo|gender|birthday|payment|account_id|message_thread') {
    throw "Identity, contact, profile, payment, account, and chat data do not belong in this release"
}
if (-not $Migration.Contains("UNIQUE(campaign_id, session_id)") -or
    -not $Migration.Contains("UNIQUE(campaign_id, display_name_key)") -or
    -not $Migration.Contains("UNIQUE(tester_id, day_index)") -or
    -not $Migration.Contains("CREATE TABLE content_reports")) {
    throw "Expected duplicate-tester, duplicate-day, and duplicate-report constraints"
}
if (-not $Domain.Contains('groups.google.com') -or
    -not $Domain.Contains('play.google.com') -or
    -not $Domain.Contains('/apps/testing/') -or
    -not $Worker.Contains("isOfficialGroupUrl") -or
    -not $Worker.Contains("isOfficialPlayTestUrl")) {
    throw "Expected allow-listed official Google testing links"
}
if (-not $Worker.Contains("csvSafe") -or
    -not $Worker.Contains("roster.csv") -or
    -not $Worker.Contains("roster.json")) {
    throw "Expected safe developer exports"
}
if ($Worker -match '(?i)better-auth|betterAuth') {
    throw "Account authentication is not needed for the capability-based release"
}
if ($Wrangler.Contains("TO_BE_CREATED")) {
    throw "The production D1 database ID has not been configured"
}

$OgPath = Join-Path $PublicDirectory "og.svg"
if ((Get-Item -LiteralPath $OgPath).Length -lt 2500) {
    throw "Expected a product-specific OG SVG larger than 2.5 KB"
}

$KeyFiles = @(
    Get-ChildItem -LiteralPath $PublicDirectory -File |
        Where-Object { $_.Name -match "^[a-zA-Z0-9-]{8,128}\.txt$" }
)
if ($KeyFiles.Count -ne 1) {
    throw "Expected exactly one generated IndexNow key file, found $($KeyFiles.Count)"
}
$Key = (Get-Content -Raw -LiteralPath $KeyFiles[0].FullName).Trim()
if ($Key -ne $KeyFiles[0].BaseName) {
    throw "IndexNow key file name and content do not match"
}

Write-Output "Product release contract is satisfied"
