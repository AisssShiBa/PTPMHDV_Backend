@echo off
chcp 65001 >nul
echo ========================================================
echo   FINVAULT - TỰ ĐỘNG ĐỒNG BỘ MÔI TRƯỜNG SAU KHI PULL
echo ========================================================
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
echo.
pause
