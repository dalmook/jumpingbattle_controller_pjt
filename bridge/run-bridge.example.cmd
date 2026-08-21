@echo off
setlocal
cd /d "%~dp0"
if not exist bridge-config.json (
  echo Copy bridge-config.example.json to bridge-config.json and fill development values.
  exit /b 1
)
python -B jumping_bridge.py --config bridge-config.json
