<#
.SYNOPSIS
    Install llama-cpp-server-explorer on Windows.

.DESCRIPTION
    Downloads a tarball of the `main` branch (no .git history), extracts to
    the install directory, then runs `pnpm install` and `pnpm build`.
    Re-run to update.

.PARAMETER InstallDir
    Target directory. Defaults to "$env:LOCALAPPDATA\llama-cpp-server-explorer".

.PARAMETER Branch
    Git branch to download. Default: main.

.EXAMPLE
    iwr -useb https://raw.githubusercontent.com/AlienResidents/llama-cpp-server-explorer/main/scripts/install.ps1 | iex

.EXAMPLE
    .\install.ps1 -InstallDir "C:\opt\llama-explorer"
#>

[CmdletBinding()]
param(
    [string]$InstallDir = "$env:LOCALAPPDATA\llama-cpp-server-explorer",
    [string]$Branch = "main"
)

$ErrorActionPreference = "Stop"

$RepoOwner = "AlienResidents"
$RepoName = "llama-cpp-server-explorer"
$TarballUrl = "https://github.com/$RepoOwner/$RepoName/archive/refs/heads/$Branch.tar.gz"

Write-Host "==> Installing to: $InstallDir"

# ─── Pre-flight: required tools ────────────────────────────────────────────

function Require-Command {
    param([string]$Name, [string]$Hint)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        Write-Error "'$Name' is required but not on PATH. $Hint"
    }
}
Require-Command "tar"  "Standard on Windows 10 1803+. If missing, install Git for Windows or use Windows Subsystem for Linux."
Require-Command "node" "Install Node.js 22.12+ from https://nodejs.org/ or via nvm-windows."
Require-Command "pnpm" "Install via 'corepack enable && corepack prepare pnpm@latest --activate' or 'npm i -g pnpm'."

# ─── Fetch + extract ───────────────────────────────────────────────────────

if (-not (Test-Path $InstallDir)) {
    New-Item -Path $InstallDir -ItemType Directory -Force | Out-Null
}

$TmpTar = Join-Path ([System.IO.Path]::GetTempPath()) ("llama-explorer-" + [Guid]::NewGuid().ToString("N").Substring(0,8) + ".tar.gz")

try {
    Write-Host "==> Downloading $TarballUrl"
    Invoke-WebRequest -Uri $TarballUrl -OutFile $TmpTar -UseBasicParsing -TimeoutSec 60

    Write-Host "==> Extracting into $InstallDir"
    # --strip-components=1 drops the GitHub-injected top-level dir
    # (e.g. llama-cpp-server-explorer-main\).
    tar -xzf $TmpTar --strip-components=1 -C $InstallDir
    if ($LASTEXITCODE -ne 0) {
        throw "tar extraction failed (exit $LASTEXITCODE)"
    }
} finally {
    Remove-Item $TmpTar -ErrorAction SilentlyContinue
}

# ─── Build ────────────────────────────────────────────────────────────────

Push-Location $InstallDir
try {
    Write-Host "==> pnpm install"
    pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw "pnpm install failed" }

    Write-Host "==> pnpm build"
    pnpm build
    if ($LASTEXITCODE -ne 0) { throw "pnpm build failed" }
} finally {
    Pop-Location
}

# ─── Done ─────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "✓ Installed to: $InstallDir"
Write-Host ""
Write-Host "Run with:"
Write-Host "    Set-Location `"$InstallDir`""
Write-Host "    pnpm start"
Write-Host ""
Write-Host "Then open http://localhost:8787 in your browser."
Write-Host ""
Write-Host "Re-run this script to update — the install dir is overwritten in"
Write-Host "place, your cache (data\explorer.db) is preserved."
