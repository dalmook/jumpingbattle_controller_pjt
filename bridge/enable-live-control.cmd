@echo off
setlocal
cd /d "%~dp0"
if not exist bridge-config.json (
  echo Run diagnose-bridge.cmd first.
  pause
  exit /b 1
)
JumpingBattleRemoteBridge.exe --set-armed true
if errorlevel 1 (
  echo.
  echo Live control remains locked. Please send a screenshot of this window.
  pause
  exit /b 1
)
echo.
echo Live control is enabled. The running bridge reloads this setting automatically.
pause
