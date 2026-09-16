@echo off
REM Install JackieRouter as a Windows service using NSSM

setlocal enabledelayedexpansion

REM Configuration — set these before running the installer
set "AI_WORKSPACE_ROOT=C:\Users\Eru\AI_ Workspace"
set "PERMANENT_STORAGE=E:\AI_Permanent\Models"

echo ==================================================
echo JackieRouter Service Installer (NSSM)
echo ==================================================
echo.

REM Check if NSSM is available
where nssm >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] NSSM not found — install from https://nssm.cc/download.html
    pause
    exit /b 1
)

echo [1/4] Installing service...
nssm install JackieRouter "python.exe" "%AI_WORKSPACE_ROOT%\router_entry.py"
if %errorlevel% neq 0 (
    echo [ERROR] NSSM install failed with code !errorlevel!
    pause
    exit /b 1
)

echo.
echo [2/4] Setting environment variables...
nssm set JackieRouter AppEnvironment "AI_WORKSPACE_ROOT=%AI_WORKSPACE_ROOT%;PERMANENT_STORAGE=%PERMANENT_STORAGE%"
if %errorlevel% neq 0 (
    echo [ERROR] Failed to set environment variables
    pause
    exit /b 1
)

echo.
echo [3/4] Starting service...
nssm start JackieRouter
if %errorlevel% neq 0 (
    echo [WARNING] Service failed to start — check NSSM logs
) else (
    echo ✓ Service started successfully
)

echo.
echo ==================================================
echo Installer complete — run 'nssm status JackieRouter' to verify
echo ==================================================

endlocal
