@echo off
setlocal
cd /d "%~dp0"

if not exist "node_modules\" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

echo Watching TypeScript — rebuilds on save. Ctrl+C to stop.
call npm run watch
