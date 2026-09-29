$ErrorActionPreference = 'Continue'
docker info *> $null
if ($LASTEXITCODE -ne 0) {
    Start-Process -FilePath 'C:\Program Files\Docker\Docker\Docker Desktop.exe' -WindowStyle Hidden -ErrorAction Stop
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        Start-Sleep -Seconds 2
        docker info *> $null
        if ($LASTEXITCODE -eq 0) { break }
    }
}
if ($LASTEXITCODE -ne 0) { throw 'Docker engine is unavailable' }
docker compose -f "$PSScriptRoot/compose.yml" up -d --wait --wait-timeout 120
if ($LASTEXITCODE -ne 0) { throw 'Test infrastructure failed to start' }
