# ==============================================================================
# FinVault - Script Dong Bo Moi Truong Tu Dong Sau Khi Pull Code
# ==============================================================================
[CmdletBinding()]
param (
    [switch]$SkipFrontend,
    [switch]$SkipPrisma
)

$ErrorActionPreference = "Stop"
$ScriptDir = $PSScriptRoot

if (Test-Path (Join-Path $ScriptDir "Backend")) {
    $WorkspaceRoot = $ScriptDir
    $BackendDir = Join-Path $WorkspaceRoot "Backend"
    $FrontendDir = Join-Path $WorkspaceRoot "Frontend"
} else {
    $BackendDir = $ScriptDir
    $WorkspaceRoot = (Get-Item $ScriptDir).Parent.FullName
    $FrontendDir = Join-Path $WorkspaceRoot "Frontend"
}

function Write-Step {
    param([string]$Text)
    Write-Host ""
    Write-Host "========================================================" -ForegroundColor Cyan
    Write-Host ">>> $Text" -ForegroundColor Cyan
    Write-Host "========================================================" -ForegroundColor Cyan
}

function Write-Success {
    param([string]$Text)
    Write-Host " [OK] $Text" -ForegroundColor Green
}

function Write-Warn {
    param([string]$Text)
    Write-Host " [!] $Text" -ForegroundColor Yellow
}

# 1. Khoi tao Secrets va .env
Write-Step "BUOC 1: Kiem tra cau hinh Secrets va .env"
if (Test-Path (Join-Path $BackendDir "scripts\init-secrets.js")) {
    Push-Location $BackendDir
    try {
        node scripts/init-secrets.js
        Write-Success "Da tao hoac kiem tra .env va khoa ES256 thanh cong."
    } catch {
        Write-Warn "init-secrets.js gap loi: $_"
    } finally {
        Pop-Location
    }
}

# 2. Build thu vien chung finvault-internal-auth
Write-Step "BUOC 2: Cai dat va Build packages/finvault-internal-auth"
$AuthPackageDir = Join-Path $BackendDir "packages\finvault-internal-auth"
if (Test-Path $AuthPackageDir) {
    Push-Location $AuthPackageDir
    try {
        Write-Host "  -> npm install..."
        npm install --silent
        Write-Host "  -> npm run build (tsc)..."
        npm run build
        Write-Success "Da build xong packages/finvault-internal-auth"
    } catch {
        Write-Warn "Loi khi build finvault-internal-auth: $_"
    } finally {
        Pop-Location
    }
}

# 3. Dong bo cac Services trong Backend
Write-Step "BUOC 3: Dong bo dependencies va Prisma Client cho cac Microservices"
$ServiceDirs = @(
    "gateway",
    "services\auth-service",
    "services\user-service",
    "services\merchant-service",
    "services\wallet-service",
    "services\payment-service",
    "services\notification-service",
    "services\admin-service"
)

foreach ($relPath in $ServiceDirs) {
    $fullPath = Join-Path $BackendDir $relPath
    if (-not (Test-Path $fullPath)) { continue }
    
    $serviceName = Split-Path $fullPath -Leaf
    Write-Host ""
    Write-Host "--- Xu ly: $serviceName ($relPath) ---" -ForegroundColor Yellow
    Push-Location $fullPath
    try {
        Write-Host "  -> npm install..."
        npm install --silent
        
        $prismaSchema = Join-Path $fullPath "prisma\schema.prisma"
        if (-not $SkipPrisma -and (Test-Path $prismaSchema)) {
            Write-Host "  -> npx prisma generate..."
            npx prisma generate
            Write-Success "${serviceName}: Da cap nhat Prisma Client"
        } else {
            Write-Success "${serviceName}: Da cai dependencies"
        }
    } catch {
        Write-Warn "Loi tai ${serviceName}: $_"
    } finally {
        Pop-Location
    }
}

# 4. Dong bo Frontend
if (-not $SkipFrontend -and (Test-Path $FrontendDir)) {
    Write-Step "BUOC 4: Dong bo dependencies cho Frontend"
    Push-Location $FrontendDir
    try {
        Write-Host "  -> npm install..."
        npm install --silent
        Write-Success "Frontend da cai dat dependencies thanh cong."
    } catch {
        Write-Warn "Loi Frontend: $_"
    } finally {
        Pop-Location
    }
}

# 5. Kiem tra Docker
Write-Step "BUOC 5: Kiem tra Docker Desktop"
$dockerRunning = $false
try {
    $null = docker ps 2>&1
    if ($LASTEXITCODE -eq 0) {
        $dockerRunning = $true
    }
} catch {
    $dockerRunning = $false
}

if ($dockerRunning) {
    Write-Success "Docker Desktop dang hoat dong."
    Write-Host "  -> Goi y: chay lệnh de bat toan bo service neu can:" -ForegroundColor Gray
    Write-Host "     cd Backend; docker compose up -d" -ForegroundColor White
} else {
    Write-Warn "Docker Desktop chua bat. Hay bat Docker Desktop khi can chay database va he thong."
}

Write-Host ""
Write-Host "========================================================" -ForegroundColor Green
Write-Host " HOAN TAT DONG BO! TAT CA SERVICE DA SAN SANG DE CHAY." -ForegroundColor Green
Write-Host "========================================================" -ForegroundColor Green
Write-Host ""
