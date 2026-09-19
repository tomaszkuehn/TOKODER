param([string]$Prompt, [string]$Model, [switch]$All, [switch]$NoTui)
$ErrorActionPreference="Stop"
Push-Location $PSScriptRoot/..
if (!(Test-Path ".env") -and (Test-Path ".env.example")) { Write-Host "No .env found - copy it from .env.example and add your keys" -ForegroundColor Yellow }
if (!(Test-Path "node_modules")) { npm install }
npm run build | Out-Null
$argsList=@()
if ($Model) { $argsList+=@("--model",$Model) }
if ($All) { $argsList+="--all" }
if ($NoTui) { $argsList+="--no-tui" }
if ($Prompt) { $argsList+=$Prompt }
node dist/cli.js @argsList
Pop-Location
