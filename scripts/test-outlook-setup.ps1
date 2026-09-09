# Offline provisioning regression test. All Microsoft calls are replaced by mocks.
param([ValidateSet('success', 'wrong-tenant', 'broad-grant')][string]$Scenario = 'success')
$ErrorActionPreference = 'Stop'
$testDir = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
$global:outlookSetupTestFixture = @{}
$global:outlookSetupTestFixture.apps = @{}
$global:outlookSetupTestFixture.grant = $null
$global:outlookSetupTestFixture.principal = $null
$global:outlookSetupTestFixture.posts = 0
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
function Invoke-MgGraphRequest { param($Method, $Uri, $ContentType, $Body)
    if ($Method -eq 'POST') { $global:outlookSetupTestFixture.posts++; $data = $Body | ConvertFrom-Json -AsHashtable }
    if ($Uri -match '/users/') { return @{ id = 'business-user'; userPrincipalName = 'business@example.com' } }
    if ($Uri -match '/applications$' -and $Method -eq 'POST') {
        $id = [guid]::NewGuid().ToString()
        $data.id = $id
        $data.appId = [guid]::NewGuid().ToString()
        $global:outlookSetupTestFixture.apps[$id] = $data
        return $data
    }
    if ($Uri -match '/applications/([^/?]+)$') { return $global:outlookSetupTestFixture.apps[$Matches[1]] }
    if ($Uri -match '/servicePrincipals\?' -and $Uri -match '00000003-0000-0000-c000-000000000000') { return @{ value = @($global:outlookSetupTestFixture.resource) } }
    if ($Uri -match '/servicePrincipals\?') { return @{ value = @($global:outlookSetupTestFixture.principal | Where-Object { $null -ne $_ }) } }
    if ($Uri -match '/servicePrincipals$' -and $Method -eq 'POST') { $global:outlookSetupTestFixture.principal = @{ id = 'business-sp'; appId = $data.appId }; return $global:outlookSetupTestFixture.principal }
    if ($Uri -match '/oauth2PermissionGrants\?') {
        if ($Scenario -eq 'broad-grant') { return @{ value = @(@{ consentType = 'AllPrincipals' }) } }
        return @{ value = @($global:outlookSetupTestFixture.grant | Where-Object { $null -ne $_ }) }
    }
    if ($Uri -match '/oauth2PermissionGrants$' -and $Method -eq 'POST') {
        if ($data.consentType -ne 'Principal' -or $data.principalId -ne 'business-user' -or $data.scope -ne ($names -join ' ')) { throw 'Grant exceeded approved boundary.' }
        $global:outlookSetupTestFixture.grant = $data; return $data
    }
    throw "Unexpected Microsoft request: $Method $Uri"
}
try {
    & "$PSScriptRoot/setup-outlook.ps1" -SetupDirectory $testDir
    if ($Scenario -ne 'success') {
        $expectedPosts = if ($Scenario -eq 'wrong-tenant') { 0 } else { 3 }
        if ($LASTEXITCODE -ne 1 -or $global:outlookSetupTestFixture.posts -ne $expectedPosts) { throw 'Expected fail-closed rejection before the grant.' }
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
    Remove-Item -LiteralPath $testDir -Recurse -Force -ErrorAction SilentlyContinue
}
