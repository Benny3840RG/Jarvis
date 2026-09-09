# Run through setup-outlook.sh on the operator's computer. No customer send or deployment.
param([string]$SetupDirectory = (Join-Path $HOME '.config/jarvis/outlook'))
$ErrorActionPreference = 'Stop'
$graph = 'https://graph.microsoft.com/v1.0'
$connected = $false
try {
    $setupDir = $SetupDirectory
    if (Test-Path -LiteralPath $setupDir) {
        $item = Get-Item -Force -LiteralPath $setupDir
        if ($item.LinkType) { throw 'Setup directory must not be a symlink.' }
    } else { New-Item -ItemType Directory -Path $setupDir -Force | Out-Null }
    & chmod 700 $setupDir
    if ($LASTEXITCODE -ne 0) { throw 'Cannot secure setup directory.' }
    $statePath = Join-Path $setupDir 'setup-state.json'
    if (Test-Path -LiteralPath $statePath) {
        if ((Get-Item -Force -LiteralPath $statePath).LinkType) { throw 'State file must not be a symlink.' }
        $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json -AsHashtable
    } else {
        $tenant = (Read-Host 'Beez Treez tenant ID').Trim()
        $parsed = [guid]::Empty
        if (-not [guid]::TryParse($tenant, [ref]$parsed)) { throw 'Invalid tenant ID.' }
        $business = (Read-Host 'Business mailbox sign-in address (UPN)').Trim()
        $personal = (Read-Host 'Personal Outlook address [thebeeztreez@outlook.com]').Trim()
        if (-not $personal) { $personal = 'thebeeztreez@outlook.com' }
        foreach ($mailbox in @($personal, $business)) {
            if ($mailbox -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$') { throw 'Invalid mailbox address.' }
        }
        if ($personal -eq $business) { throw 'The two mailboxes must be different.' }
        $state = @{ tenantId = $parsed.ToString(); personal = $personal; business = $business; apps = @{} }
    }
    function Save-State {
        $temporary = Join-Path $setupDir ([guid]::NewGuid().ToString() + '.tmp')
        $state | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $temporary
        & chmod 600 $temporary
        if ($LASTEXITCODE -ne 0) { throw 'Cannot secure setup state.' }
        Move-Item -Force -LiteralPath $temporary -Destination $statePath
    }
    Save-State
    if (-not (Get-Module -ListAvailable Microsoft.Graph.Authentication)) {
        Install-Module Microsoft.Graph.Authentication -Repository PSGallery -Scope CurrentUser -Force
    }
    Import-Module Microsoft.Graph.Authentication
    Write-Host "Sign in with the BUSINESS TENANT administrator for $($state.tenantId)."
    Write-Host 'This creates two dedicated app registrations and a delegated grant for the business user only.'
    # System-browser authentication: deliberately not the blocked device-code flow.
    Connect-MgGraph -TenantId $state.tenantId -ContextScope Process -NoWelcome `
        -Scopes 'Application.ReadWrite.All','DelegatedPermissionGrant.ReadWrite.All','User.ReadBasic.All'
    $connected = $true
    if ((Get-MgContext).TenantId -ne $state.tenantId) { throw 'Wrong tenant; stopped.' }

    $user = Invoke-MgGraphRequest -Method GET -Uri "$graph/users/$([uri]::EscapeDataString($state.business))?`$select=id,userPrincipalName,mail"
    if ($user.userPrincipalName -ne $state.business) { throw 'Business user does not match the requested sign-in address.' }
    $resources = Invoke-MgGraphRequest -Method GET -Uri "$graph/servicePrincipals?`$filter=appId eq '00000003-0000-0000-c000-000000000000'"
    if (@($resources.value).Count -ne 1) { throw 'Cannot identify Microsoft Graph in this tenant.' }
    $resource = $resources.value[0]
    $scopeNames = @('offline_access', 'Mail.ReadWrite', 'Mail.Send')
    $scopes = @()
    foreach ($scopeName in $scopeNames) {
        $scope = @($resource.oauth2PermissionScopes | Where-Object { $_.value -ceq $scopeName -and $_.isEnabled })
        if ($scope.Count -ne 1) { throw "Cannot resolve delegated permission $scopeName." }
        $scopes += @{ id = $scope[0].id; type = 'Scope' }
    }
    foreach ($kind in @('personal', 'business')) {
        $audience = if ($kind -eq 'personal') { 'PersonalMicrosoftAccount' } else { 'AzureADMyOrg' }
        if (-not $state.apps.ContainsKey($kind)) {
            $body = @{
                displayName = "Jarvis Outlook $kind (separate consent)"
                signInAudience = $audience
                api = @{ requestedAccessTokenVersion = 2 }
                publicClient = @{ redirectUris = @('http://localhost') }
                isFallbackPublicClient = $false
                requiredResourceAccess = @(@{ resourceAppId = '00000003-0000-0000-c000-000000000000'; resourceAccess = $scopes })
            }
            $app = Invoke-MgGraphRequest -Method POST -Uri "$graph/applications" -ContentType 'application/json' -Body ($body | ConvertTo-Json -Depth 20)
            $state.apps[$kind] = @{ id = $app.id; clientId = $app.appId }
            Save-State
        }
        $app = Invoke-MgGraphRequest -Method GET -Uri "$graph/applications/$($state.apps[$kind].id)"
        if ($app.appId -ne $state.apps[$kind].clientId -or $app.signInAudience -ne $audience -or
            @($app.publicClient.redirectUris).Count -ne 1 -or $app.publicClient.redirectUris[0] -ne 'http://localhost' -or
            @($app.requiredResourceAccess).Count -ne 1 -or $app.requiredResourceAccess[0].resourceAppId -ne $resource.appId -or
            @($app.requiredResourceAccess[0].resourceAccess).Count -ne 3 -or
            @($app.requiredResourceAccess[0].resourceAccess | Where-Object { $_.type -ne 'Scope' -or $_.id -notin @($scopes.id) }).Count -gt 0) {
            throw "Saved $kind registration changed; inspect it before proceeding."
        }
    }
    $clientId = $state.apps.business.clientId
    $principals = Invoke-MgGraphRequest -Method GET -Uri "$graph/servicePrincipals?`$filter=appId eq '$clientId'"
    if (@($principals.value).Count -gt 1) { throw 'Ambiguous business application.' }
    if (@($principals.value).Count -eq 0) {
        $principal = Invoke-MgGraphRequest -Method POST -Uri "$graph/servicePrincipals" -ContentType 'application/json' -Body (@{ appId = $clientId } | ConvertTo-Json)
    } else { $principal = $principals.value[0] }
    $grants = Invoke-MgGraphRequest -Method GET -Uri "$graph/oauth2PermissionGrants?`$filter=clientId eq '$($principal.id)'"
    if ($grants.'@odata.nextLink') { throw 'Unexpected grant pagination; inspect before proceeding.' }
    if (@($grants.value).Count -eq 0) {
        $grantBody = @{ clientId = $principal.id; resourceId = $resource.id; consentType = 'Principal'; principalId = $user.id; scope = ($scopeNames -join ' ') }
        $null = Invoke-MgGraphRequest -Method POST -Uri "$graph/oauth2PermissionGrants" -ContentType 'application/json' -Body ($grantBody | ConvertTo-Json)
    }
    $grants = Invoke-MgGraphRequest -Method GET -Uri "$graph/oauth2PermissionGrants?`$filter=clientId eq '$($principal.id)'"
    if (@($grants.value).Count -ne 1 -or $grants.value[0].consentType -ne 'Principal' -or
        $grants.value[0].principalId -ne $user.id -or $grants.value[0].resourceId -ne $resource.id -or
        (Compare-Object ($scopeNames | Sort-Object) ($grants.value[0].scope.Split(' ', [StringSplitOptions]::RemoveEmptyEntries) | Sort-Object))) {
        throw 'Business grant differs from the approved single-user permissions.'
    }
    $connections = @(
        @{ id = 'personal'; clientId = $state.apps.personal.clientId; mailbox = $state.personal; refreshTokenFile = (Join-Path $setupDir 'personal.token') },
        @{ id = 'business'; clientId = $state.apps.business.clientId; mailbox = $state.business; tenantId = $state.tenantId; refreshTokenFile = (Join-Path $setupDir 'business.token') }
    )
    $configPath = Join-Path $setupDir 'connections.json'
    if ((Test-Path -LiteralPath $configPath) -and (Get-Item -Force -LiteralPath $configPath).LinkType) { throw 'Config file must not be a symlink.' }
    $connections | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $configPath
    & chmod 600 $configPath
    if ($LASTEXITCODE -ne 0) { throw 'Cannot secure connection configuration.' }
    Write-Host 'Registrations and business single-user consent verified. Next: separate mailbox sign-ins.'
} catch {
    Write-Host 'Setup stopped. No tenant consent/security policy was weakened; completed registrations are recorded for retry.'
    Write-Host $_.Exception.Message
    exit 1
} finally {
    if ($connected) { Disconnect-MgGraph -ErrorAction SilentlyContinue | Out-Null }
}
