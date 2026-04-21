# install-local.ps1
# ローカルVSCodeにmdait拡張をビルドしてインストールする

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Push-Location $PSScriptRoot\..\..\

try {
    Write-Host "==> Bundling..." -ForegroundColor Cyan
    npm run bundle
    if ($LASTEXITCODE -ne 0) { throw "compile failed" }

    Write-Host "==> Packaging vsix..." -ForegroundColor Cyan
    npx vsce package
    if ($LASTEXITCODE -ne 0) { throw "vsce package failed" }

    $vsix = Get-ChildItem *.vsix | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $vsix) { throw "vsix not found" }

    Write-Host "==> Installing $($vsix.Name)..." -ForegroundColor Cyan
    code.cmd --install-extension $vsix.FullName
    if ($LASTEXITCODE -ne 0) { throw "install failed" }

    Remove-Item $vsix.FullName
    Write-Host "==> Done! Reload VSCode to activate." -ForegroundColor Green
}
finally {
    Pop-Location
}
