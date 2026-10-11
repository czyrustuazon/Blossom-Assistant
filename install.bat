@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

echo ========================================
echo  Blossom Assistant — build + install
echo ========================================
echo.
echo Note: compile.bat only builds files.
echo This script packages a .vsix and installs
echo it into Cursor / VS Code so the plugin appears.
echo.

if not exist "node_modules\" (
  echo [1/4] Installing dependencies...
  call npm install
  if errorlevel 1 goto :fail
) else (
  echo [1/4] Dependencies OK
)

echo [2/4] Compiling...
call npm run compile
if errorlevel 1 goto :fail

echo [3/4] Packaging .vsix...
for %%F in (blossom-assistant-*.vsix) do del /q "%%F" 2>nul
call npm run package
if errorlevel 1 goto :fail

set "VSIX="
for %%F in (blossom-assistant-*.vsix) do set "VSIX=%%F"
if not defined VSIX (
  echo Could not find a blossom-assistant-*.vsix after packaging.
  goto :fail
)
echo     Packaged: %VSIX%

echo [4/4] Installing into editor(s)...
set "INSTALLED=0"

where cursor >nul 2>&1
if not errorlevel 1 (
  echo     Cursor...
  call cursor --install-extension "%VSIX%" --force
  if not errorlevel 1 (
    set "INSTALLED=1"
    echo     Cursor: OK
  ) else (
    echo     Cursor: install failed
  )
) else (
  echo     Cursor CLI not found on PATH — skipped
)

where code >nul 2>&1
if not errorlevel 1 (
  echo     VS Code...
  call code --install-extension "%VSIX%" --force
  if not errorlevel 1 (
    set "INSTALLED=1"
    echo     VS Code: OK
  ) else (
    echo     VS Code: install failed
  )
) else (
  echo     VS Code CLI not found on PATH — skipped
)

if "%INSTALLED%"=="0" (
  echo.
  echo No editor accepted the install.
  echo You can still install manually:
  echo   cursor --install-extension "%VSIX%"
  echo   code --install-extension "%VSIX%"
  goto :fail
)

echo.
echo ========================================
echo  Installed. Reload the editor window:
echo    Ctrl+Shift+P → Developer: Reload Window
echo  Then: Ctrl+Shift+P → Blossom: Open New Chat
echo  Or click the cherry blossom in the editor title bar.
echo ========================================
echo.
pause
exit /b 0

:fail
echo.
echo Install failed.
pause
exit /b 1
