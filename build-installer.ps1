<#
  Builds dist\RoLauncherSetup-<version>.exe

    1. Publishes RoLauncher (self-contained, so the PC doesn't need .NET installed) to obj\publish-app
    2. Zips it to dist\payload.zip
    3. Publishes installer\Setup.csproj as one .exe with that zip embedded

  Usage:  .\build-installer.ps1            (version 1.2.0)
          .\build-installer.ps1 -Version 1.2.0
#>
param([string]$Version = "1.2.0")
$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
$dist = Join-Path $root "dist"
$app  = Join-Path $root "obj\publish-app"   # staging, kept out of dist so a running copy there never blocks a build
$zip  = Join-Path $dist "payload.zip"

New-Item -ItemType Directory -Force $dist | Out-Null
if (Test-Path $app) { Remove-Item -Recurse -Force $app }
if (Test-Path $zip) { Remove-Item -Force $zip }

Write-Host "1/3  Publishing RoLauncher $Version..." -ForegroundColor Cyan
dotnet publish (Join-Path $root "RoLauncher.csproj") -c Release -r win-x64 --self-contained true `
    -p:Version=$Version -p:DebugType=none -o $app --nologo -v q
if ($LASTEXITCODE -ne 0) { throw "Publishing RoLauncher failed" }

Write-Host "2/3  Packing files..." -ForegroundColor Cyan
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($app, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $false)

Write-Host "3/3  Building the installer..." -ForegroundColor Cyan
$out = Join-Path $dist "installer"
dotnet publish (Join-Path $root "installer\Setup.csproj") -c Release -r win-x64 --self-contained true `
    -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:EnableCompressionInSingleFile=true `
    -p:Version=$Version -p:DebugType=none -o $out --nologo -v q
if ($LASTEXITCODE -ne 0) { throw "Building the installer failed" }

$final = Join-Path $dist "RoLauncherSetup-$Version.exe"
Copy-Item (Join-Path $out "RoLauncherSetup.exe") $final -Force
$mb = [math]::Round((Get-Item $final).Length / 1MB, 1)
Write-Host "Done: $final ($mb MB)" -ForegroundColor Green
