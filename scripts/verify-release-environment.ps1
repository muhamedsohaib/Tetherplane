param(
    [string]$Repository = 'muhamedsohaib/Tetherplane',
    [string]$EnvironmentName = 'tetherplane-release-approval'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# This audit is read-only. It never creates an environment, a version tag,
# a release, a reviewer approval or an OAuth client.
if ($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
    throw 'Repository must be supplied as owner/repository'
}
if ($EnvironmentName -notmatch '^[A-Za-z0-9_.-]+$') {
    throw 'EnvironmentName has unexpected characters'
}

$receipt = [ordered]@{
    product = 'Tetherplane'
    operation = 'RELEASE_ENVIRONMENT_READONLY_PREFLIGHT'
    repository = $Repository
    environment = $EnvironmentName
    status = 'NO_GO'
    reviewer_rule_count = 0
    required_reviewer_count = 0
    prevent_self_review = $false
    tag_protection_independently_verified = $false
    environment_protection_pass = $false
    production_changed = $false
    reason = 'not_checked'
}

try {
    $null = Get-Command gh -ErrorAction Stop
    $endpoint = 'repos/{0}/environments/{1}' -f $Repository,$EnvironmentName
    $response = & gh api $endpoint --header 'Accept: application/vnd.github+json' 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $response) {
        throw 'environment_api_not_accessible'
    }

    $environment = $response | Out-String | ConvertFrom-Json
    if ([string]$environment.name -ne $EnvironmentName) {
        throw 'unexpected_environment'
    }

    $reviewerRules = @(
        $environment.protection_rules | Where-Object {
            $_.type -eq 'required_reviewers' -and
            $_.prevent_self_review -eq $true -and
            @($_.reviewers).Count -gt 0
        }
    )
    $receipt.reviewer_rule_count = $reviewerRules.Count
    $receipt.required_reviewer_count = @(
        $reviewerRules | ForEach-Object { $_.reviewers }
    ).Count
    $receipt.prevent_self_review = ($reviewerRules.Count -eq 1)
    $receipt.environment_protection_pass = (
        $reviewerRules.Count -eq 1 -and $receipt.required_reviewer_count -ge 1
    )

    if ($receipt.environment_protection_pass) {
        $receipt.status = 'PASS_ENVIRONMENT_REVIEWER_PREFLIGHT_ONLY'
        $receipt.reason = 'reviewer_configuration_verified'
    }
    else {
        $receipt.reason = 'missing_independent_review_protection'
    }
}
catch {
    # Do not forward external command error text or credential-bearing traces.
    $receipt.status = 'NO_GO'
    $receipt.reason = 'environment_api_or_configuration_unavailable'
}

$receipt | ConvertTo-Json -Depth 5
if (-not $receipt.environment_protection_pass) {
    exit 1
}
