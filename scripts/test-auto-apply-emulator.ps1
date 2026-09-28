# Isolated T476 checkpoint. No Firebase production project or running emulator is used.
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runtime = Join-Path $env:TEMP 'vdsen-t476-sdk'
$sdkPackage = Join-Path $runtime 'node_modules/firebase/package.json'
$jarName = 'cloud-firestore-emulator-v1.19.8.jar'
$jarHash = '9D43599ED6151199E8D604DC87FAC51218E49E5F3A48519B1AE560BBE5E3382D'
$cachedJar = Join-Path ([Environment]::GetFolderPath('UserProfile')) ".cache/firebase/emulators/$jarName"
$jar = if (Test-Path -LiteralPath $cachedJar) { $cachedJar } else { Join-Path $runtime $jarName }
$project = 'demo-vdsen-shadow'
$port = 8786
$emulator = $null

if (-not (Get-Command java -ErrorAction SilentlyContinue)) { throw 'Java is required for Firestore Emulator.' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is required for T476.' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'npm is required for firebase@10.12.0.' }
if (-not (Test-Path -LiteralPath $runtime)) { New-Item -ItemType Directory -Path $runtime | Out-Null }

if (-not (Test-Path -LiteralPath $sdkPackage) -or
    (Get-Content -LiteralPath $sdkPackage -Raw | ConvertFrom-Json).version -ne '10.12.0') {
  npm install --prefix $runtime --no-save --no-package-lock --no-audit --no-fund --ignore-scripts firebase@10.12.0
  if ($LASTEXITCODE -ne 0) { throw 'firebase@10.12.0 installation failed.' }
}
if (-not (Test-Path -LiteralPath $jar)) {
  $url = "https://storage.googleapis.com/firebase-preview-drop/emulator/$jarName"
  Invoke-WebRequest -Uri $url -OutFile $jar
}
if ((Get-FileHash -LiteralPath $jar -Algorithm SHA256).Hash -ne $jarHash) {
  throw 'Firestore Emulator JAR checksum mismatch.'
}
if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
  throw "Port $port is occupied; refusing to use or disturb an existing service."
}

$stdout = Join-Path $runtime 'firestore-stdout.log'
$stderr = Join-Path $runtime 'firestore-stderr.log'
$rules = Join-Path $repo 'firestore.rules'
try {
  $emulator = Start-Process -FilePath (Get-Command java).Source -PassThru -WindowStyle Hidden `
    -WorkingDirectory $repo -RedirectStandardOutput $stdout -RedirectStandardError $stderr `
    -ArgumentList @('-jar', ('"' + $jar + '"'), '--host', '127.0.0.1', '--port', $port,
      '--project_id', $project, '--rules', ('"' + $rules + '"'), '--single_project_mode')
  $ready = $false
  for ($i = 0; $i -lt 100; $i++) {
    if ($emulator.HasExited) { break }
    $socket = [System.Net.Sockets.TcpClient]::new()
    try { $ready = $socket.ConnectAsync('127.0.0.1', $port).Wait(200) }
    catch { $ready = $false }
    finally { $socket.Dispose() }
    if ($ready) { break }
    Start-Sleep -Milliseconds 200
  }
  if (-not $ready) { throw "Firestore Emulator did not start: $(Get-Content -LiteralPath $stderr -Tail 12)" }
  $env:NODE_PATH = Join-Path $runtime 'node_modules'
  $env:FIRESTORE_EMULATOR_HOST = "127.0.0.1:$port"
  $env:GCLOUD_PROJECT = $project
  Push-Location $repo
  try { node --test tests/t476-auto-apply-emulator.cjs; $result = $LASTEXITCODE }
  finally { Pop-Location }
  if ($result -ne 0) { throw "T476 failed with exit code $result." }
}
finally {
  if ($emulator -and -not $emulator.HasExited) {
    Stop-Process -Id $emulator.Id
    $emulator.WaitForExit(5000) | Out-Null
  }
  if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
    throw "Firestore Emulator port $port remained open after shutdown."
  }
}
