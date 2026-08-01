[CmdletBinding()]
param(
    [switch]$Local
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$SqlPath = Join-Path $PSScriptRoot "product-metrics.sql"
$Wrangler = Join-Path $RepoRoot "node_modules\.bin\wrangler.cmd"
$Target = if ($Local) { "--local" } else { "--remote" }
$Sql = (Get-Content $SqlPath) -join " "

$Output = & $Wrangler d1 execute shisou-to $Target --json --command $Sql
if ($LASTEXITCODE -ne 0) {
    throw "D1 metrics query failed with exit code $LASTEXITCODE"
}

$Payload = ($Output -join [Environment]::NewLine) | ConvertFrom-Json
$Row = $Payload[0].results[0]
if (-not $Row) {
    throw "D1 metrics query returned no result"
}

function Get-Percent {
    param([int]$Numerator, [int]$Denominator)
    if ($Denominator -eq 0) { return $null }
    return [Math]::Round(($Numerator / $Denominator) * 100, 1)
}

$Users = [int]$Row.users
$Creators = [int]$Row.creators
$Testers = [int]$Row.testers
$OptedIn = [int]$Row.opted_in

[ordered]@{
    generated_at = (Get-Date).ToUniversalTime().ToString("o")
    service = "shisou-to"
    environment = if ($Local) { "local" } else { "production" }
    funnel = [ordered]@{
        users = $Users
        creators = $Creators
        testers = $Testers
        campaigns_with_testers = [int]$Row.campaigns_with_testers
        opted_in = $OptedIn
        daily_checkers = [int]$Row.checked
        feedback_users = [int]$Row.feedback_users
        roster_exporters = [int]$Row.exporters
        roster_exports = [int]$Row.exports
        public_viewers = [int]$Row.public_viewers
        official_link_openers = [int]$Row.official_link_openers
        returned = [int]$Row.returned
        created_7d = [int]$Row.created_7d
        testers_7d = [int]$Row.testers_7d
        qa_rows = [int]$Row.qa_rows
    }
    live_state = [ordered]@{
        recruiting_campaigns = [int]$Row.recruiting_campaigns
        running_campaigns = [int]$Row.running_campaigns
        completed_campaigns = [int]$Row.completed_campaigns
        closed_campaigns = [int]$Row.closed_campaigns
        hidden_campaigns = [int]$Row.hidden_campaigns
        active_testers = [int]$Row.active_testers
        testing_testers = [int]$Row.testing_testers
        completed_testers = [int]$Row.completed_testers
        withdrawn_testers = [int]$Row.withdrawn_testers
        checkins = [int]$Row.checkins
        feedback_items = [int]$Row.feedback_items
    }
    rates = [ordered]@{
        creator_percent = Get-Percent $Creators $Users
        tester_percent = Get-Percent $Testers $Users
        optin_percent = Get-Percent $OptedIn $Testers
        checker_percent = Get-Percent ([int]$Row.checked) $OptedIn
        return_percent = Get-Percent ([int]$Row.returned) $Users
    }
} | ConvertTo-Json -Depth 4
