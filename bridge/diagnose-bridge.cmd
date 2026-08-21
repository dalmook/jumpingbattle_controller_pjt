@echo off
setlocal
cd /d "%~dp0"
if not exist bridge-config.json copy /y bridge-config.example.json bridge-config.json >nul
JumpingBattleRemoteBridge.exe --diagnose
if errorlevel 1 (
  echo.
  echo Diagnosis failed. Please send a screenshot of this window.
  pause
  exit /b 1
)
echo.
echo Expected result: "safe": true
pause
