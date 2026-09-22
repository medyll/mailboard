$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$collector = Join-Path $PSScriptRoot 'collect.mjs'
$collectorArgs = @($args)
$keepEdgeOpen = $collectorArgs -contains '--keep-edge-open'
$collectorArgs = @($collectorArgs | Where-Object { $_ -ne '--keep-edge-open' })

# Un processus déjà ouvert ne reçoit pas les variables utilisateur ajoutées
# après son lancement. Le wrapper les recharge sans afficher leur valeur.
if (-not $env:TYPESAFE_API_KEY) {
  $userKey = [Environment]::GetEnvironmentVariable('TYPESAFE_API_KEY', 'User')
  if ($userKey) { $env:TYPESAFE_API_KEY = $userKey }
}

$port = if ($env:MAILBOARD_CDP_PORT) { [int]$env:MAILBOARD_CDP_PORT } else { 9222 }
$profileRoot = if ($env:MAILBOARD_EDGE_USER_DATA_DIR) {
  $env:MAILBOARD_EDGE_USER_DATA_DIR
} else {
  Join-Path $env:LOCALAPPDATA 'Microsoft\Edge-mailboard'
}

function Test-MailboardCdp {
  try {
    $version = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/version" -TimeoutSec 1
    return [bool]$version.webSocketDebuggerUrl
  } catch {
    return $false
  }
}

$startedEdge = $false
if (-not (Test-MailboardCdp)) {
  $edgeCandidates = @(
    'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
    (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe')
  )
  $edge = $edgeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $edge) { throw 'Microsoft Edge est introuvable.' }

  New-Item -ItemType Directory -Path $profileRoot -Force | Out-Null
  $edgeArgs = @(
    "--remote-debugging-port=$port",
    '--remote-debugging-address=127.0.0.1',
    "--user-data-dir=`"$profileRoot`"",
    '--enable-automation',
    '--no-first-run',
    'https://mail.proton.me/'
  )
  Start-Process -FilePath $edge -ArgumentList $edgeArgs | Out-Null
  $startedEdge = $true

  for ($attempt = 0; $attempt -lt 40 -and -not (Test-MailboardCdp); $attempt++) {
    Start-Sleep -Milliseconds 250
  }
  if (-not (Test-MailboardCdp)) {
    throw "Edge a démarré, mais le port CDP $port ne répond pas."
  }
}

$env:MAILBOARD_CDP_PORT = [string]$port
$node = (Get-Command node -ErrorAction Stop).Source

Push-Location $projectRoot
try {
  & $node $collector @collectorArgs
  $collectorExit = $LASTEXITCODE
} finally {
  Pop-Location
}

if ($startedEdge -and -not $keepEdgeOpen) {
  $escapedProfile = [Regex]::Escape($profileRoot)
  Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'" |
    Where-Object { $_.CommandLine -match $escapedProfile } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

exit $collectorExit
