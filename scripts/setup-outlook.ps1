# Run through setup-outlook.sh on the operator's computer. No customer send or deployment.
param([string]$SetupDirectory = (Join-Path $HOME '.config/jarvis/outlook'))
$ErrorActionPreference = 'Stop'
$graph = 'https://graph.microsoft.com/v1.0'
$connected = $false
$setupLock = $null
try {
    $setupDir = $SetupDirectory
    if (Test-Path -LiteralPath $setupDir) {
        $item = Get-Item -Force -LiteralPath $setupDir
        if ($item.LinkType) { throw 'Setup directory must not be a symlink.' }
    } else { New-Item -ItemType Directory -Path $setupDir -Force | Out-Null }
    & chmod 700 $setupDir
    if ($LASTEXITCODE -ne 0) { throw 'Cannot secure setup directory.' }
    $lockPath = Join-Path $setupDir '.setup.lock'
    if ((Test-Path -LiteralPath $lockPath) -and (Get-Item -Force -LiteralPath $lockPath).LinkType) { throw 'Setup lock must not be a symlink.' }
    $setupLock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    & chmod 600 $lockPath
    if ($LASTEXITCODE -ne 0) { throw 'Cannot secure setup lock.' }
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
        $state = @{ tenantId = $parsed.ToString(); personal = $personal; business = $business; apps = @{}; intentVersion = 1 }
    }
    function Save-State {
        $temporary = Join-Path $setupDir ([guid]::NewGuid().ToString() + '.tmp')
        $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            & chmod 600 $temporary
            if ($LASTEXITCODE -ne 0) { throw 'Cannot secure setup state.' }
            $bytes = [Text.Encoding]::UTF8.GetBytes(($state | ConvertTo-Json -Depth 20))
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush($true)
        } finally { $stream.Dispose() }
        & chmod 600 $temporary
        if ($LASTEXITCODE -ne 0) { throw 'Cannot secure setup state.' }
        Move-Item -Force -LiteralPath $temporary -Destination $statePath
        & sync -f $setupDir
        if ($LASTEXITCODE -ne 0) { throw 'Cannot flush setup state before a provider effect.' }
    }
    function Get-GraphCollection([string]$Uri) {
        $initial = [uri]$Uri
        $seen = @{}
        $records = [Collections.Generic.List[object]]::new()
        while ($Uri) {
            $link = [uri]$Uri
            if (-not $link.IsAbsoluteUri -or $link.Scheme -cne 'https' -or $link.Host -cne 'graph.microsoft.com' -or
                $link.Port -ne 443 -or $link.UserInfo -or $link.Fragment -or $link.AbsolutePath -cne $initial.AbsolutePath) {
                throw 'Refusing unexpected Microsoft Graph pagination target.'
            }
            if ($seen.ContainsKey($Uri) -or $seen.Count -ge 20) { throw 'Microsoft Graph pagination could not be reconciled within its bound.' }
            $seen[$Uri] = $true
            $page = Invoke-MgGraphRequest -Method GET -Uri $Uri
            if ($page -isnot [Collections.IDictionary] -or -not $page.Contains('value') -or $null -eq $page.value) { throw 'Invalid Microsoft Graph collection response.' }
            foreach ($record in $page.value) {
                if ($records.Count -ge 1000) { throw 'Microsoft Graph collection exceeds its reconciliation bound.' }
                $records.Add($record)
            }
            $Uri = $page.'@odata.nextLink'
        }
        return $records.ToArray()
    }
    if (-not $state.ContainsKey('intentVersion')) { $state.untrackedLegacyEffects = $true; $state.intentVersion = 1 }
    if ($state.intentVersion -ne 1) { throw 'Unsupported setup effect-intent version.' }
    if (-not $state.ContainsKey('intents')) { $state.intents = @{} }
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
    $resources = @(Get-GraphCollection "$graph/servicePrincipals?`$filter=appId eq '00000003-0000-0000-c000-000000000000'")
    if ($resources.Count -ne 1) { throw 'Cannot identify Microsoft Graph in this tenant.' }
    $resource = $resources[0]
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
            if ($state.untrackedLegacyEffects) { throw 'Legacy setup has no pre-effect intent for a missing registration; reconcile it before proceeding.' }
            $intentKey = "application-$kind"
            $newIntent = -not $state.intents.ContainsKey($intentKey)
            if ($newIntent) {
                $state.intents[$intentKey] = @{ displayName = "Jarvis Outlook $kind ($([guid]::NewGuid().ToString()))"; state = 'indeterminate' }
                Save-State
            }
            $intent = $state.intents[$intentKey]
            $body = @{
                displayName = $intent.displayName
                signInAudience = $audience
                api = @{ requestedAccessTokenVersion = 2 }
                publicClient = @{ redirectUris = @('http://localhost') }
                isFallbackPublicClient = $false
                requiredResourceAccess = @(@{ resourceAppId = '00000003-0000-0000-c000-000000000000'; resourceAccess = $scopes })
            }
            if ($newIntent) {
                $app = Invoke-MgGraphRequest -Method POST -Uri "$graph/applications" -ContentType 'application/json' -Body ($body | ConvertTo-Json -Depth 20)
            } else {
                $filter = [uri]::EscapeDataString("displayName eq '$($intent.displayName.Replace("'", "''"))'")
                $applications = @(Get-GraphCollection "$graph/applications?`$filter=$filter")
                if ($applications.Count -ne 1 -or $applications[0].displayName -cne $intent.displayName) {
                    throw "Indeterminate $kind registration: exact intent lookup did not resolve one application. No create was retried."
                }
                $app = $applications[0]
            }
            if (-not $app.id -or -not $app.appId) { throw 'Application create remains indeterminate; returned identifiers are missing.' }
            $state.apps[$kind] = @{ id = $app.id; clientId = $app.appId }
            $intent.state = 'observed'
            Save-State
        }
        $app = Invoke-MgGraphRequest -Method GET -Uri "$graph/applications/$($state.apps[$kind].id)"
        if ($app.appId -ne $state.apps[$kind].clientId -or $app.signInAudience -ne $audience -or
            $app.api.requestedAccessTokenVersion -ne 2 -or
            $app.isFallbackPublicClient -isnot [bool] -or $app.isFallbackPublicClient -ne $false -or
            @($app.web.redirectUris | Where-Object { $null -ne $_ }).Count -ne 0 -or
            @($app.spa.redirectUris | Where-Object { $null -ne $_ }).Count -ne 0 -or
            $app.web.implicitGrantSettings.enableAccessTokenIssuance -eq $true -or
            $app.web.implicitGrantSettings.enableIdTokenIssuance -eq $true -or
            @($app.publicClient.redirectUris).Count -ne 1 -or $app.publicClient.redirectUris[0] -ne 'http://localhost' -or
            @($app.requiredResourceAccess).Count -ne 1 -or $app.requiredResourceAccess[0].resourceAppId -ne $resource.appId -or
            @($app.requiredResourceAccess[0].resourceAccess).Count -ne 3 -or
            (Compare-Object (@($scopes.id) | Sort-Object) (@($app.requiredResourceAccess[0].resourceAccess.id) | Sort-Object)) -or
            @($app.requiredResourceAccess[0].resourceAccess | Where-Object { $_.type -ne 'Scope' -or $_.id -notin @($scopes.id) }).Count -gt 0) {
            throw "Saved $kind registration changed; inspect it before proceeding."
        }
    }
    $clientId = $state.apps.business.clientId
    $principals = @(Get-GraphCollection "$graph/servicePrincipals?`$filter=appId eq '$clientId'")
    if ($principals.Count -gt 1) { throw 'Ambiguous business application.' }
    if ($principals.Count -eq 0) {
        if ($state.untrackedLegacyEffects -or $state.intents.ContainsKey('businessPrincipal')) { throw 'Business principal create is indeterminate or missing; no create was retried.' }
        $state.intents.businessPrincipal = @{ clientId = $clientId; state = 'indeterminate' }
        Save-State
        $principal = Invoke-MgGraphRequest -Method POST -Uri "$graph/servicePrincipals" -ContentType 'application/json' -Body (@{ appId = $clientId } | ConvertTo-Json)
    } else { $principal = $principals[0] }
    if (-not $principal.id -or $principal.appId -ne $clientId) { throw 'Business principal does not match the saved registration.' }
    if ($state.intents.ContainsKey('businessPrincipal')) {
        if ($state.intents.businessPrincipal.clientId -ne $clientId) { throw 'Business principal intent does not match the registration.' }
        $state.intents.businessPrincipal.state = 'observed'
        Save-State
    }
    $grantsUri = "$graph/oauth2PermissionGrants?`$filter=clientId eq '$($principal.id)'"
    $grants = @(Get-GraphCollection $grantsUri)
    if ($grants.Count -eq 0) {
        if ($state.untrackedLegacyEffects -or $state.intents.ContainsKey('businessGrant')) { throw 'Business grant create is indeterminate or missing; no grant was retried.' }
        $grantBody = @{ clientId = $principal.id; resourceId = $resource.id; consentType = 'Principal'; principalId = $user.id; scope = ($scopeNames -join ' ') }
        $state.intents.businessGrant = @{ clientId = $principal.id; principalId = $user.id; resourceId = $resource.id; scope = $grantBody.scope; state = 'indeterminate' }
        Save-State
        $null = Invoke-MgGraphRequest -Method POST -Uri "$graph/oauth2PermissionGrants" -ContentType 'application/json' -Body ($grantBody | ConvertTo-Json)
    }
    $grants = @(Get-GraphCollection $grantsUri)
    if ($grants.Count -ne 1 -or $grants[0].clientId -ne $principal.id -or $grants[0].consentType -ne 'Principal' -or
        $grants[0].principalId -ne $user.id -or $grants[0].resourceId -ne $resource.id -or
        (Compare-Object ($scopeNames | Sort-Object) ($grants[0].scope.Split(' ', [StringSplitOptions]::RemoveEmptyEntries) | Sort-Object))) {
        throw 'Business grant differs from the approved single-user permissions.'
    }
    if ($state.intents.ContainsKey('businessGrant')) {
        $intent = $state.intents.businessGrant
        if ($intent.clientId -ne $principal.id -or $intent.principalId -ne $user.id -or $intent.resourceId -ne $resource.id -or $intent.scope -cne ($scopeNames -join ' ')) { throw 'Business grant intent does not match current consent scope.' }
        $intent.state = 'observed'
        Save-State
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
    Write-Host 'Setup stopped. Recorded effects require reconciliation; uncertain creates are never retried automatically.'
    Write-Host $_.Exception.Message
    exit 1
} finally {
    if ($connected) { Disconnect-MgGraph -ErrorAction SilentlyContinue | Out-Null }
    if ($setupLock) { $setupLock.Dispose() }
}
