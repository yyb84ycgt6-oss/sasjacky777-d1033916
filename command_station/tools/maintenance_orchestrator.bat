@echo off
REM Maintenance Orchestrator
REM Runs full nightly maintenance workflow

setlocal enabledelayedexpansion

echo ==================================================
echo AI WORKSTATION MAINTENANCE ORCHESTRATOR
echo ==================================================
echo Started: %date% %time%
echo ==================================================
echo.

REM Configuration
set VAULT_PATH=E:\AI_Permanent\Models
set LM_STUDIO_PATH=C:\Users\Eru\AI_ Workspace\LMServer2012-08-30\Models
set LOG_DIR=C:\Users\Eru\AI_ Workspace\logs
set LOG_FILE=%LOG_DIR%\maintenance_%date:~-4,4%%date:~-10,2%%date:~-7,2%.log

REM Create log directory if it doesn't exist
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

REM Start logging
echo [%date% %time%] Maintenance started >> "%LOG_FILE%"

REM Read all tool files first, then run scheduler generation
echo [%date% %time%] Reading tools... >> "%LOG_FILE%"
python "C:/Users/Eru/AI_ Workspace/tools/scheduler_generator.py" "%AI_WORKSPACE_ROOT%/tools" "%VAULT_PATH%" 2>&1 | tee "%LOG_FILE%"

echo [1/6] Running forward mirror (LM Studio -> E: Permanent)
echo ----------------------------------------------------------
call C:\Users\Eru\AI_ Workspace\tools\Robocopy_LMStudio_to_E.bat >> "%LOG_FILE%" 2>&1
if %errorlevel% equ 0 (
    echo ✓ Forward mirror completed successfully
) else (
    echo ✗ Forward mirror failed with error %errorlevel%
    echo [%date% %time%] Forward mirror failed >> "%LOG_FILE%"
)
echo.

echo [2/6] Running reverse verification (E: -> LM Studio)
echo ----------------------------------------------------------
call C:\Users\Eru\AI_ Workspace\tools\Robocopy_E_to_LMStudio.bat >> "%LOG_FILE%" 2>&1
if %errorlevel% equ 0 (
    echo ✓ Reverse verification completed successfully
) else (
    echo ✗ Reverse verification failed with error %errorlevel%
    echo [%date% %time%] Reverse verification failed >> "%LOG_FILE%"
)
echo.

echo [3/6] Running integrity dashboard check
echo ----------------------------------------------------------
python C:\Users\Eru\AI_ Workspace\tools\integrity_dashboard.py >> "%LOG_FILE%" 2>&1
if %errorlevel% equ 0 (
    echo ✓ Integrity check completed
) else (
    echo ✗ Integrity check failed with error %errorlevel%
    echo [%date% %time%] Integrity check failed >> "%LOG_FILE%"
)
echo.

echo [4/6] Running router test suite
echo ----------------------------------------------------------
python C:\Users\Eru\AI_ Workspace\tools\test_router_suite.py >> "%LOG_FILE%" 2>&1
if %errorlevel% equ 0 (
    echo ✓ Router tests passed
) else (
    echo ✗ Router tests failed with error %errorlevel%
    echo [%date% %time%] Router tests failed >> "%LOG_FILE%"
)
echo.

echo [5/6] Running vault diff tool
echo ----------------------------------------------------------
python C:\Users\Eru\AI_ Workspace\tools\vault_diff_tool.py >> "%LOG_FILE%" 2>&1
if %errorlevel% equ 0 (
    echo ✓ Vault diff completed
) else (
    echo ✗ Vault diff failed with error %errorlevel%
    echo [%date% %time%] Vault diff failed >> "%LOG_FILE%"
)
echo.

echo [6/6] Generating maintenance report
echo ----------------------------------------------------------
echo [%date% %time%] Maintenance completed >> "%LOG_FILE%"
echoMaintenance completed at %date% %time% >> "%LOG_FILE%"
echo.

echo ==================================================
echo MAINTENANCE COMPLETE
echo ==================================================
echo Log file: %LOG_FILE%
echo.

endlocal
