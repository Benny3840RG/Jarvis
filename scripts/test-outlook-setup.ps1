# Offline provisioning regression test. All Microsoft calls are replaced by mocks.
param([ValidateSet('success', 'wrong-tenant', 'broad-grant', 'app-timeout-visible', 'app-timeout-missing', 'principal-timeout', 'grant-timeout', 'ambiguous-app-page', 'foreign-next-link', 'pagination-loop', 'principal-page', 'grant-page', 'principal-timeout-missing', 'grant-timeout-missing', 'pagination-bound', 'collection-bound', 'setup-lock', 'legacy-partial', 'legacy-principal', 'legacy-grant', 'unknown-intent-version', 'duplicate-app-scope', 'wrong-token-version', 'fallback-public-client', 'remote-web-redirect', 'remote-spa-redirect', 'implicit-grant')][string]$Scenario = 'success')
$ErrorActionPreference = 'Stop'
$testDir = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
$global:outlookSetupTestFixture = @{}
$global:outlookSetupTestFixture.apps = @{}
$global:outlookSetupTestFixture.grant = $null
$global:outlookSetupTestFixture.principal = $null
$global:outlookSetupTestFixture.posts = 0
$global:outlookSetupTestFixture.collectionReads = 0
$global:outlookSetupTestFixture.failed = $false
$global:outlookSetupTestFixture.hideApp = $false
$global:outlookSetupTestFixture.hidePrincipal = $false
$global:outlookSetupTestFixture.hideGrant = $false
$tenant = '11111111-2222-3333-4444-555555555555'
$names = @('offline_access', 'Mail.ReadWrite', 'Mail.Send')
$global:outlookSetupTestFixture.resource = @{ id = 'graph-sp'; appId = '00000003-0000-0000-c000-000000000000'; oauth2PermissionScopes = @(
    @{ id = 'scope-offline'; value = 'offline_access'; isEnabled = $true },
    @{ id = 'scope-write'; value = 'Mail.ReadWrite'; isEnabled = $true },
    @{ id = 'scope-send'; value = 'Mail.Send'; isEnabled = $true }
) }
function Read-Host($Prompt) {
    if ($Prompt -match 'tenant ID') { return $tenant }
    if ($Prompt -match 'Business mailbox') { return 'business@example.com' }
    return 'personal@outlook.com'
}
function Get-Module { param($ListAvailable) return @{ Name = 'Mock Graph' } }
function Import-Module { param($Name) }
function Connect-MgGraph { param($TenantId, $ContextScope, [switch]$NoWelcome, $Scopes)
    if ($Scopes.Count -ne 3 -or $ContextScope -ne 'Process') { throw 'Unexpected admin login.' }
}
function Disconnect-MgGraph { }
function Get-MgContext { return @{ TenantId = $(if ($Scenario -eq 'wrong-tenant') { 'wrong' } else { $tenant }) } }
function Fail-AfterEffect($Kind) {
    if (-not $global:outlookSetupTestFixture.failed -and (($Kind -eq 'app' -and $Scenario -like 'app-timeout-*') -or $Scenario -like "$Kind-timeout*" -or ($Kind -eq 'app' -and $Scenario -eq 'ambiguous-app-page'))) {
        $global:outlookSetupTestFixture.failed = $true
        $global:outlookSetupTestFixture["hide$Kind"] = $Scenario -like '*missing'
        throw 'Simulated provider timeout after committed effect.'
    }
}
function Invoke-MgGraphRequest { param($Method, $Uri, $ContentType, $Body)
    if ($Method -eq 'POST') {
        $global:outlookSetupTestFixture.posts++
        $data = $Body | ConvertFrom-Json -AsHashtable
        $intentKey = if ($Uri -match '/applications$') { if ($data.signInAudience -eq 'PersonalMicrosoftAccount') { 'application-personal' } else { 'application-business' } } elseif ($Uri -match '/servicePrincipals$') { 'businessPrincipal' } else { 'businessGrant' }
        $record = Get-Content -Raw (Join-Path $testDir 'setup-state.json') | ConvertFrom-Json -AsHashtable
        if (-not $record.intents.ContainsKey($intentKey) -or $record.intents[$intentKey].state -ne 'indeterminate') { throw 'Provider POST preceded durable effect intent.' }
    }
    if ($Uri -match '/users/') { return @{ id = 'business-user'; userPrincipalName = 'business@example.com' } }
    if ($Uri -match '/applications$' -and $Method -eq 'POST') {
        $id = [guid]::NewGuid().ToString()
        $data.id = $id
        $data.appId = [guid]::NewGuid().ToString()
        $global:outlookSetupTestFixture.apps[$id] = $data
        Fail-AfterEffect 'app'
        return $data
    }
    if ($Uri -match '/applications\?') {
        if ($global:outlookSetupTestFixture.hideApp) { return @{ value = @() } }
        $decoded = [uri]::UnescapeDataString($Uri)
        if ($decoded -notmatch "displayName eq '([^']+)'") { throw 'Application lookup has no exact intent marker.' }
        $matching = @($global:outlookSetupTestFixture.apps.Values | Where-Object { $_.displayName -ceq $Matches[1] })
        if ($Scenario -eq 'ambiguous-app-page') {
            if ($Uri -match 'skiptoken') { return @{ value = @(@{ id = 'other-app'; appId = 'other-client'; displayName = $matching[0].displayName }) } }
            return @{ value = $matching; '@odata.nextLink' = "$Uri&`$skiptoken=second" }
        }
        return @{ value = $matching }
    }
    if ($Uri -match '/applications/([^/?]+)$') {
        $app = $global:outlookSetupTestFixture.apps[$Matches[1]]
        if ($Scenario -eq 'duplicate-app-scope') { $app.requiredResourceAccess[0].resourceAccess[1].id = $app.requiredResourceAccess[0].resourceAccess[0].id }
        if ($Scenario -eq 'wrong-token-version') { $app.api.requestedAccessTokenVersion = 1 }
        if ($Scenario -eq 'fallback-public-client') { $app.isFallbackPublicClient = $true }
        if ($Scenario -eq 'remote-web-redirect') { $app.web = @{ redirectUris = @('https://unexpected.example/callback') } }
        if ($Scenario -eq 'remote-spa-redirect') { $app.spa = @{ redirectUris = @('https://unexpected.example/callback') } }
        if ($Scenario -eq 'implicit-grant') { $app.web = @{ implicitGrantSettings = @{ enableAccessTokenIssuance = $true } } }
        return $app
    }
    if ($Uri -match '/servicePrincipals\?' -and $Uri -match '00000003-0000-0000-c000-000000000000') {
        $global:outlookSetupTestFixture.collectionReads++
        if ($Scenario -eq 'pagination-bound') { return @{ value = @(); '@odata.nextLink' = "$Uri&`$skiptoken=$($global:outlookSetupTestFixture.collectionReads)" } }
        if ($Scenario -eq 'collection-bound') { return @{ value = @(1..1001 | ForEach-Object { $global:outlookSetupTestFixture.resource }) } }
        if ($Scenario -eq 'foreign-next-link') { return @{ value = @($global:outlookSetupTestFixture.resource); '@odata.nextLink' = 'https://attacker.example/collect' } }
        if ($Scenario -eq 'pagination-loop') { return @{ value = @($global:outlookSetupTestFixture.resource); '@odata.nextLink' = $Uri } }
        return @{ value = @($global:outlookSetupTestFixture.resource) }
    }
    if ($Uri -match '/servicePrincipals\?') {
        if ($global:outlookSetupTestFixture.hidePrincipal) { return @{ value = @() } }
        if ($Scenario -eq 'principal-page') {
            if ($Uri -match 'skiptoken') { return @{ value = @(@{ id = 'second-principal' }) } }
            return @{ value = @(@{ id = 'first-principal' }); '@odata.nextLink' = "$Uri&`$skiptoken=second" }
        }
        return @{ value = @($global:outlookSetupTestFixture.principal | Where-Object { $null -ne $_ }) }
    }
    if ($Uri -match '/servicePrincipals$' -and $Method -eq 'POST') { $global:outlookSetupTestFixture.principal = @{ id = 'business-sp'; appId = $data.appId }; Fail-AfterEffect 'principal'; return $global:outlookSetupTestFixture.principal }
    if ($Uri -match '/oauth2PermissionGrants\?') {
        if ($global:outlookSetupTestFixture.hideGrant) { return @{ value = @() } }
        if ($Scenario -eq 'grant-page') {
            if ($Uri -match 'skiptoken') { return @{ value = @(@{ consentType = 'AllPrincipals' }) } }
            return @{ value = @(@{ consentType = 'Principal' }); '@odata.nextLink' = "$Uri&`$skiptoken=second" }
        }
        if ($Scenario -eq 'broad-grant') { return @{ value = @(@{ consentType = 'AllPrincipals' }) } }
        return @{ value = @($global:outlookSetupTestFixture.grant | Where-Object { $null -ne $_ }) }
    }
    if ($Uri -match '/oauth2PermissionGrants$' -and $Method -eq 'POST') {
        if ($data.consentType -ne 'Principal' -or $data.principalId -ne 'business-user' -or $data.scope -ne ($names -join ' ')) { throw 'Grant exceeded approved boundary.' }
        $global:outlookSetupTestFixture.grant = $data; Fail-AfterEffect 'grant'; return $data
    }
    throw "Unexpected Microsoft request: $Method $Uri"
}
$heldLock = $null
try {
    if ($Scenario -in @('legacy-partial', 'unknown-intent-version')) {
        New-Item -ItemType Directory -Path $testDir | Out-Null
        $legacyState = @{ tenantId = $tenant; business = 'business@example.com'; personal = 'personal@outlook.com'; apps = @{} }
        if ($Scenario -eq 'unknown-intent-version') { $legacyState.intentVersion = 2 }
        $legacyState | ConvertTo-Json -Depth 10 | Set-Content (Join-Path $testDir 'setup-state.json')
    }
    if ($Scenario -eq 'setup-lock') {
        New-Item -ItemType Directory -Path $testDir | Out-Null
        $heldLock = [IO.File]::Open((Join-Path $testDir '.setup.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    }
    & "$PSScriptRoot/setup-outlook.ps1" -SetupDirectory $testDir
    if ($Scenario -in @('legacy-principal', 'legacy-grant')) {
        $statePath = Join-Path $testDir 'setup-state.json'
        $record = Get-Content -Raw $statePath | ConvertFrom-Json -AsHashtable
        $record.Remove('intentVersion'); $record.Remove('intents')
        $record | ConvertTo-Json -Depth 20 | Set-Content $statePath
        if ($Scenario -eq 'legacy-principal') { $global:outlookSetupTestFixture.principal = $null } else { $global:outlookSetupTestFixture.grant = $null }
        & "$PSScriptRoot/setup-outlook.ps1" -SetupDirectory $testDir
        if ($LASTEXITCODE -ne 1 -or $global:outlookSetupTestFixture.posts -ne 4) { throw 'Legacy missing effect was recreated without intent evidence.' }
        & "$PSScriptRoot/setup-outlook.ps1" -SetupDirectory $testDir
        if ($LASTEXITCODE -ne 1 -or $global:outlookSetupTestFixture.posts -ne 4) { throw 'Legacy uncertainty disappeared across retry.' }
        Write-Host "PASS: $Scenario preserves missing-effect uncertainty across retries."
        exit 0
    }
    if ($Scenario -like '*timeout*' -or $Scenario -eq 'ambiguous-app-page') {
        if ($LASTEXITCODE -ne 1) { throw 'Expected simulated interruption.' }
        $record = Get-Content -Raw (Join-Path $testDir 'setup-state.json') | ConvertFrom-Json -AsHashtable
        if (-not $record.intents) { throw 'No durable pre-effect intent survived the timeout.' }
        $postsBefore = $global:outlookSetupTestFixture.posts
        if ($Scenario -like '*missing') {
            & "$PSScriptRoot/setup-outlook.ps1" -SetupDirectory $testDir
            if ($LASTEXITCODE -ne 1 -or $global:outlookSetupTestFixture.posts -ne $postsBefore) { throw 'Unobserved indeterminate create was retried.' }
            $global:outlookSetupTestFixture.hideApp = $false
            $global:outlookSetupTestFixture.hidePrincipal = $false
            $global:outlookSetupTestFixture.hideGrant = $false
        }
        & "$PSScriptRoot/setup-outlook.ps1" -SetupDirectory $testDir
        if ($Scenario -eq 'ambiguous-app-page') {
            if ($LASTEXITCODE -ne 1 -or $global:outlookSetupTestFixture.posts -ne $postsBefore) { throw 'Ambiguous paginated app lookup did not fail closed.' }
            Write-Host 'PASS: ambiguous app on second page refused without another create.'
            exit 0
        }
        if ($global:outlookSetupTestFixture.posts -ne 4 -or -not (Test-Path (Join-Path $testDir 'connections.json'))) { throw 'Interrupted effect did not reconcile without duplicate creation.' }
        Write-Host "PASS: $Scenario reconciled without repeating the effect."
        exit 0
    }
    if ($Scenario -ne 'success') {
        $expectedPosts = if ($Scenario -in @('wrong-tenant', 'foreign-next-link', 'pagination-loop', 'pagination-bound', 'collection-bound', 'setup-lock', 'legacy-partial', 'unknown-intent-version')) { 0 } elseif ($Scenario -eq 'principal-page') { 2 } elseif ($Scenario -in @('duplicate-app-scope', 'wrong-token-version', 'fallback-public-client', 'remote-web-redirect', 'remote-spa-redirect', 'implicit-grant')) { 1 } else { 3 }
        if ($LASTEXITCODE -ne 1 -or $global:outlookSetupTestFixture.posts -ne $expectedPosts) { throw 'Expected fail-closed rejection before the grant.' }
        if ($Scenario -eq 'pagination-bound' -and $global:outlookSetupTestFixture.collectionReads -ne 20) { throw 'Pagination did not stop at its read bound.' }
        Write-Host "PASS: $Scenario refused without creating a consent grant."
        exit 0
    }
    if ($global:outlookSetupTestFixture.posts -ne 4) { throw "Expected two apps, one service principal and one grant; got $global:outlookSetupTestFixture.posts" }
    & "$PSScriptRoot/setup-outlook.ps1" -SetupDirectory $testDir
    if ($global:outlookSetupTestFixture.posts -ne 4) { throw 'Retry created duplicate Microsoft objects.' }
    $connections = Get-Content -Raw (Join-Path $testDir 'connections.json') | ConvertFrom-Json
    if ($connections.Count -ne 2 -or $connections[0].clientId -eq $connections[1].clientId -or $connections[0].refreshTokenFile -eq $connections[1].refreshTokenFile -or $connections[1].tenantId -ne $tenant) { throw 'Connections are not isolated.' }
    Write-Host 'PASS: separate registrations, single-user scopes, retry without duplicates, isolated configuration.'
} finally {
    if ($heldLock) { $heldLock.Dispose() }
    Remove-Item -LiteralPath $testDir -Recurse -Force -ErrorAction SilentlyContinue
}
