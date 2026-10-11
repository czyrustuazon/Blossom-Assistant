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

echo Compiling Blossom Assistant...
call npm run compile
if errorlevel 1 (
  echo.
  echo Compile failed.
  pause
  exit /b 1
)

echo.
echo Done. Output is in out\
echo.
echo This only compiles — it does NOT install the plugin.
echo To see Blossom in Cursor / VS Code, double-click install.bat
echo ^(or press F5 in this repo to debug without installing^).
echo.
pause
exit /b 0

