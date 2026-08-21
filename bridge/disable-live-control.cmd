@echo off
setlocal
cd /d "%~dp0"
if not exist bridge-config.json (
  echo bridge-config.json was not found.
  pause
  exit /b 1
)
JumpingBattleRemoteBridge.exe --set-armed false
if errorlevel 1 (
  echo.
  echo Failed to lock live control. Close the bridge window immediately.
  pause
  exit /b 1
)
echo.
echo Live control is locked. The running bridge reloads this setting automatically.
pause
