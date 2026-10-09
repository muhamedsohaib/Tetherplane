# Pure Windows PowerShell 5.1/7 contract for protected auth runner upgrades.
# This test never uses the Vaulter task, listener, protected state or real keys.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$identityPath = Join-Path $repoRoot 'scripts\vaulter-tether-auth-runner-integrity.ps1'
$upgradePath = Join-Path $repoRoot 'scripts\vaulter-tether-auth-runner-upgrade.ps1'
$postcheckPath = Join-Path $repoRoot 'scripts\vaulter-tether-auth-supervised-postcheck.ps1'
$rehearsalPath = Join-Path $repoRoot 'scripts\vaulter-tether-auth-recovery-rehearsal.ps1'

foreach ($file in @($identityPath, $upgradePath, $postcheckPath, $rehearsalPath)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        throw 'Missing version-aware protected-runner upgrade component.'
    }
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile(
        $file, [ref]$tokens, [ref]$errors
    ) | Out-Null
    if (@($errors).Count -ne 0) { throw 'Protected-runner upgrade component has PowerShell syntax errors.' }
}

. $identityPath
$fixtureDir = Join-Path ([IO.Path]::GetTempPath()) ('tp-runner-contract-' + [guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Path $fixtureDir -ErrorAction Stop | Out-Null
    $v1 = Join-Path $fixtureDir 'v1.ps1'
    $v2 = Join-Path $fixtureDir 'v2.ps1'
    $installed = Join-Path $fixtureDir 'installed.ps1'
    [IO.File]::WriteAllText($v1, 'strict-known-v1')
    [IO.File]::WriteAllText($v2, 'strict-known-v2')
    [IO.File]::WriteAllText($installed, 'strict-known-v1')
    $args = @{ V1SourcePath=$v1; V2SourcePath=$v2; ProtectedRunnerPath=$installed }
    if ((Get-VerifiedRunnerVersion @args) -cne 'v1') { throw 'Exact v1 identity must be accepted.' }
    [IO.File]::WriteAllText($installed, 'strict-known-v2')
    if ((Get-VerifiedRunnerVersion @args) -cne 'v2') { throw 'Exact v2 identity must be accepted.' }
    [IO.File]::WriteAllText($installed, 'untrusted')
    try {
        Get-VerifiedRunnerVersion @args | Out-Null
        throw 'Tampered protected runner was incorrectly accepted.'
    } catch {
        if ($_.Exception.Message -eq 'Tampered protected runner was incorrectly accepted.') { throw }
    }
    Remove-Item -LiteralPath $v2 -Force
    try {
        Get-VerifiedRunnerVersion @args | Out-Null
        throw 'Missing candidate must fail closed.'
    } catch {
        if ($_.Exception.Message -eq 'Missing candidate must fail closed.') { throw }
    }
} finally {
    if (Test-Path -LiteralPath $fixtureDir) {
        Remove-Item -LiteralPath $fixtureDir -Recurse -Force -ErrorAction Stop
    }
}

$upgrade = [IO.File]::ReadAllText($upgradePath)
foreach ($required in @(
    '[switch]$ApplyV2', '[switch]$RestoreV1', 'if (-not $ApplyV2 -and -not $RestoreV1)',
    'Get-VerifiedRunnerVersion', 'Tetherplane-TetherAuth-Startup',
    'AreAccessRulesProtected', 'S4U', 'Get-FileHash', 'Get-ScheduledTask',
    'tether-auth-startup-runner.v1-backup.ps1', '[IO.File]::Replace',
    'Invoke-RunnerUpgradeTransaction', 'UPGRADE PREFLIGHT PASS',
    'No changes made', 'RUNNER FILE UPGRADE VERIFIED', 'RUNNER FILE RESTORE VERIFIED',
    'ROLLBACK UNVERIFIED'
)) {
    if (-not $upgrade.Contains($required)) {
        throw "Runner upgrade is missing safety contract: $required"
    }
}
if ($upgrade -notmatch 'if \(\$ApplyV2 -and \$RestoreV1\)') {
    throw 'Upgrade and rollback actions must be mutually exclusive.'
}
if ($upgrade -match '(?i)\b(?:Stop-Process|Start-Process|Stop-ScheduledTask|Start-ScheduledTask|Set-ScheduledTask|Register-ScheduledTask|Unregister-ScheduledTask|Set-Clipboard)\b' -or
    $upgrade -match '(?i)\b(?:tailscale\s+(?:funnel|serve)|gh auth token)\b' -or
    $upgrade -match '(?im)^\s*Write-(?:Host|Output|Error|Warning).*?(?:bridgeToken|privateKey|CommandLine)') {
    throw 'Protected-runner file upgrade must never disrupt running services or print secrets.'
}
foreach ($path in @($postcheckPath, $rehearsalPath)) {
    $source = [IO.File]::ReadAllText($path)
    if (-not $source.Contains('Get-VerifiedRunnerVersion') -or
        -not $source.Contains('vaulter-tether-auth-startup-runner-v2.ps1')) {
        throw 'Preflight and independent postcheck must accept only exact trusted v1/v2 runner hashes.'
    }
}

$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    $upgradePath, [ref]$tokens, [ref]$errors
)
$transaction = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'Invoke-RunnerUpgradeTransaction'
}, $true)
if ($null -eq $transaction) { throw 'Missing separately testable upgrade transaction.' }
Invoke-Expression $transaction.Extent.Text

function New-UpgradeFixture([string[]]$Failures) {
    $state = @{
        Events = New-Object 'System.Collections.Generic.List[string]'
        Failures = $Failures
    }
    $ops = @{}
    foreach ($name in @('VerifyBaseline', 'Prepare', 'Replace', 'VerifyTarget', 'Restore', 'VerifyRestored')) {
        $key = $name
        $ops[$key] = {
            $state.Events.Add($key)
            if ($state.Failures -ccontains $key) { throw 'simulated protected-file failure' }
        }.GetNewClosure()
    }
    return @{ Ops=$ops; State=$state }
}
$passed = New-UpgradeFixture @()
if ((Invoke-RunnerUpgradeTransaction -Operations $passed.Ops) -cne 'verified' -or
    ($passed.State.Events -join ',') -cne 'VerifyBaseline,Prepare,Replace,VerifyTarget') {
    throw 'Upgrade success must verify every step and never invoke rollback.'
}
foreach ($step in @('VerifyBaseline','Prepare')) {
    $fault = New-UpgradeFixture @($step)
    try {
        Invoke-RunnerUpgradeTransaction -Operations $fault.Ops | Out-Null
        throw 'A failed upgrade preflight succeeded.'
    } catch {
        if ($_.Exception.Message -eq 'A failed upgrade preflight succeeded.') { throw }
    }
    if ($fault.State.Events -ccontains 'Replace' -or $fault.State.Events -ccontains 'Restore') {
        throw 'A failed preflight may not replace or restore protected files.'
    }
}
foreach ($step in @('Replace','VerifyTarget')) {
    $fault = New-UpgradeFixture @($step)
    try {
        Invoke-RunnerUpgradeTransaction -Operations $fault.Ops | Out-Null
        throw 'Upgrade failure unexpectedly passed.'
    } catch {
        if ($_.Exception.Message -eq 'Upgrade failure unexpectedly passed.') { throw }
        if ($_.Exception.Message -notmatch 'ROLLED BACK') { throw }
    }
    if (($fault.State.Events -join ',') -notmatch 'Restore,VerifyRestored$') {
        throw 'Any possibly persisted replacement must be independently restored and verified.'
    }
}
$unverified = New-UpgradeFixture @('VerifyTarget','VerifyRestored')
try {
    Invoke-RunnerUpgradeTransaction -Operations $unverified.Ops | Out-Null
    throw 'Unverified rollback was reported as success.'
} catch {
    if ($_.Exception.Message -eq 'Unverified rollback was reported as success.') { throw }
    if ($_.Exception.Message -notmatch 'ROLLBACK UNVERIFIED') { throw }
}

# Windows File.Replace must be tested against actual temporary files rather
# than trusted solely to mocked transaction callbacks.
$swapFn = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'Invoke-RunnerAtomicReplace'
}, $true)
if ($null -eq $swapFn) { throw 'Missing separately testable same-directory atomic file swap.' }
$aclFn = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'Test-RunnerAclEquivalent'
}, $true)
if ($null -eq $aclFn) { throw 'Missing effective ACL and owner equivalence gate.' }
Invoke-Expression $aclFn.Extent.Text
Invoke-Expression $swapFn.Extent.Text
$disk = Join-Path ([IO.Path]::GetTempPath()) ('tp-atomic-runner-' + [guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Path $disk -ErrorAction Stop | Out-Null
    $active = Join-Path $disk 'active.ps1'
    $candidate = Join-Path $disk 'candidate.tmp'
    $backup = Join-Path $disk 'backup.ps1'
    $restore = Join-Path $disk 'restore.tmp'
    $rollbackRecord = Join-Path $disk 'replaced.ps1'
    [IO.File]::WriteAllText($active, 'v1')
    [IO.File]::WriteAllText($candidate, 'v2')
    $aclBefore = Get-Acl -LiteralPath $active
    Invoke-RunnerAtomicReplace -StagedPath $candidate -TargetPath $active -BackupPath $backup
    if ([IO.File]::ReadAllText($active) -cne 'v2' -or
        [IO.File]::ReadAllText($backup) -cne 'v1') {
        throw 'Atomic install did not retain v1 in the backup and v2 as active.'
    }
    if (-not (Test-RunnerAclEquivalent -Expected $aclBefore -Actual (Get-Acl -LiteralPath $active)) -or
        -not (Test-RunnerAclEquivalent -Expected $aclBefore -Actual (Get-Acl -LiteralPath $backup))) {
        throw 'Atomic install changed effective permissions, ACL protection or owner.'
    }

    # A widened effective access rule or ownership change MUST fail.
    $tampered = Get-Acl -LiteralPath $active
    $tampered.SetAccessRuleProtection($true, $true)
    if (Test-RunnerAclEquivalent -Expected $aclBefore -Actual $tampered) {
        throw 'ACL protection changes must fail even if effective ACEs are identical.'
    }

    [IO.File]::WriteAllText($candidate, 'untrusted')
    try {
        Invoke-RunnerAtomicReplace -StagedPath $candidate -TargetPath $active -BackupPath $backup
        throw 'Atomic install overwrote the original protected backup.'
    } catch {
        if ($_.Exception.Message -eq 'Atomic install overwrote the original protected backup.') { throw }
    }
    if ([IO.File]::ReadAllText($active) -cne 'v2' -or
        [IO.File]::ReadAllText($backup) -cne 'v1') {
        throw 'Conflicting backup must fail before any mutation.'
    }
    [IO.File]::WriteAllText($restore, 'v1')
    Invoke-RunnerAtomicReplace -StagedPath $restore -TargetPath $active -BackupPath $rollbackRecord
    if ([IO.File]::ReadAllText($active) -cne 'v1' -or
        [IO.File]::ReadAllText($rollbackRecord) -cne 'v2') {
        throw 'Atomic restoration must preserve previous candidate in its private evidence file.'
    }
    $foreign = Join-Path ([IO.Path]::GetTempPath()) ('tp-foreign-' + [guid]::NewGuid().ToString('N') + '.tmp')
    [IO.File]::WriteAllText($foreign, 'other')
    try {
        Invoke-RunnerAtomicReplace -StagedPath $foreign -TargetPath $active -BackupPath (Join-Path $disk 'unexpected.ps1')
        throw 'File swap accepted a cross-directory candidate.'
    } catch {
        if ($_.Exception.Message -eq 'File swap accepted a cross-directory candidate.') { throw }
    } finally {
        Remove-Item -LiteralPath $foreign -Force -ErrorAction SilentlyContinue
    }
} finally {
    if (Test-Path -LiteralPath $disk) {
        Remove-Item -LiteralPath $disk -Recurse -Force -ErrorAction Stop
    }
}
if (-not $upgrade.Contains('Invoke-RunnerAtomicReplace -StagedPath')) {
    throw 'Live upgrade must invoke the tested atomic swap, not a separate untested implementation.'
}
if (-not $upgrade.Contains('cleanupApproved')) {
    throw 'Unverified rollback must preserve protected recovery evidence.'
}

if (-not $upgrade.Contains('function Assert-PrivateAcl') -or
    -not $upgrade.Contains('Assert-PrivateAcl $script:protectedRunner') -or
    -not $upgrade.Contains('Assert-PrivateAcl $script:v1Backup')) {
    throw 'Protected installer must verify original ACL on installed and backed-up runner.'
}


# A v2 file install must fail closed without a fresh, exact-source S4U proof.
$proofFn = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'Test-FreshV2S4UProof'
}, $true)
if ($null -eq $proofFn) { throw 'Protected v2 install lacks fresh S4U proof validation.' }
Invoke-Expression $proofFn.Extent.Text
$proofFile = Join-Path ([IO.Path]::GetTempPath()) ('tp-v2-proof-' + [guid]::NewGuid().ToString('N') + '.json')
try {
    $referenceUtc = [datetimeoffset]::UtcNow
    $knownHash = ('A' * 64)
    $evidence = @{
        v2_source_hash = $knownHash
        verified_utc = $referenceUtc.AddMinutes(-5).ToString('o')
        principal = 'S4U'
        task = 'Tetherplane-TetherAuth-Startup'
    }
    [IO.File]::WriteAllText($proofFile,(ConvertTo-Json $evidence -Compress))
    if (-not (Test-FreshV2S4UProof -ProofPath $proofFile -ExpectedV2Hash $knownHash -NowUtc $referenceUtc)) {
        $doc = Get-Content -LiteralPath $proofFile -Raw | ConvertFrom-Json
        $parsedUtc = [datetimeoffset]::MinValue
        $canParse = [datetimeoffset]::TryParse(([string]$doc.verified_utc), [ref]$parsedUtc)
        throw ('Correct recent S4U proof must be accepted: hash_ok={0}; role_ok={1}; task_ok={2}; timestamp_ok={3}; age_ok={4}.' -f
            (([string]$doc.v2_source_hash) -ceq $knownHash),
            (([string]$doc.principal) -ceq 'S4U'),
            (([string]$doc.task) -ceq 'Tetherplane-TetherAuth-Startup'),
            $canParse,
            ($canParse -and (($referenceUtc - $parsedUtc).TotalMinutes -ge -2) -and (($referenceUtc - $parsedUtc).TotalMinutes -le 90)))
    }
    if (Test-FreshV2S4UProof -ProofPath $proofFile -ExpectedV2Hash ('B' * 64) -NowUtc $referenceUtc) {
        throw 'Proof for a different candidate source may never authorize installation.'
    }
    $evidence.verified_utc = $referenceUtc.AddHours(-3).ToString('o')
    [IO.File]::WriteAllText($proofFile,(ConvertTo-Json $evidence -Compress))
    if (Test-FreshV2S4UProof -ProofPath $proofFile -ExpectedV2Hash $knownHash -NowUtc $referenceUtc) {
        throw 'Stale S4U proof must be rejected.'
    }
    $evidence.verified_utc = $referenceUtc.AddHours(1).ToString('o')
    [IO.File]::WriteAllText($proofFile,(ConvertTo-Json $evidence -Compress))
    if (Test-FreshV2S4UProof -ProofPath $proofFile -ExpectedV2Hash $knownHash -NowUtc $referenceUtc) {
        throw 'Future S4U proof must be rejected.'
    }
    $evidence.verified_utc = $referenceUtc.ToString('o')
    $evidence.principal = 'Interactive'
    [IO.File]::WriteAllText($proofFile,(ConvertTo-Json $evidence -Compress))
    if (Test-FreshV2S4UProof -ProofPath $proofFile -ExpectedV2Hash $knownHash -NowUtc $referenceUtc) {
        throw 'Interactive proof is not evidence of S4U access.'
    }
} finally {
    Remove-Item -LiteralPath $proofFile -Force -ErrorAction SilentlyContinue
}
if (-not $upgrade.Contains('Test-FreshV2S4UProof -ProofPath')) {
    throw 'ApplyV2 transaction must enforce fresh S4U proof before replacing any file.'
}

Write-Output 'Protected v1/v2 runner identity and guarded install/restore contracts passed.'
