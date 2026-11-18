@echo off
title Miroo - ws-scrcpy
cd /d "%~dp0"
set "PATH=%~dp0platform-tools;%PATH%"

echo ========================================================
echo               MIROO - SCREEN MIRRORING
echo ========================================================
echo.
echo 1. Dang kiem tra ket noi ADB...
platform-tools\adb.exe start-server
echo.
echo Danh sach thiet bi Android da ket noi:
platform-tools\adb.exe devices -l
echo.
echo ========================================================
echo 2. Dang khoi dong Web Server tai http://localhost:8000
echo Nhan Ctrl+C de dung server.
echo ========================================================
start "" http://localhost:8000
node dist/index.js
pause
