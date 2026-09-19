@echo off
pushd "%~dp0.."
if not exist node_modules call npm install
call npm run build >nul
node dist\cli.js %*
popd
