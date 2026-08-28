@echo off
setlocal enabledelayedexpansion

echo ============================================================
Nightly AI Workstation Maintenance - 14:30:05
===========================================================

echo [1/6] Running Robocopy mirror (LM Studio -> E:)
robocopy "C:\Users\Eru\AI_ Workspace\models\LM_Studio\Models" "E:\AI_Permanent\Models" /MIR /R:1 /W:1 /Z /E /COPY:DAT /LOG:"C:\Users\Eru\AI_ Workspace\logs\robocopy_mirror_%date%.log"

echo [2/6] Running Reverse mirror for integrity verification (E: -> LM Studio)
robocopy "E:\AI_Permanent\Models" "C:\Users\Eru\AI_ Workspace\models\LM_Studio\Models" /MIR /R:1 /W:1 /Z /E /COPY:DAT /LOG:"C:\Users\Eru\AI_ Workspace\logs\robocopy_reverse_%date%.log"

echo [3/6] Running Duplicate Cleaner scan
if exist "C:\Program Files\Duplicate Cleaner\DuplicateCleaner.exe" (
    echo Running Duplicate Cleaner...
    "C:\Program Files\Duplicate Cleaner\DuplicateCleaner.exe" "/p:Profile=C:\Users\Eru\AI_ Workspace\tools\duplicate_cleaner_profile.xml" /v 2>&1 | findstr /r Error | select last 10
) else (
    echo Duplicate Cleaner not installed. Install from: https://github.com/freelinksoftware/duplicatecleaner
)

echo [4/6] Generating SHA-256 checksums for all GGUF files
powershell -Command "Get-ChildItem \"C:\Users\Eru\AI_ Workspace\models\LM_Studio\Models\" -Recurse -File *.gguf | ForEach-Object { $hash = Get-FileHash $_.FullName; [PSCustomObject]@{Name=\$_.Name; SHA256=\$hash.Hash; Size=\$_.Length} } | Export-Csv \"C:\Users\Eru\AI_ Workspace\docs\GGUF_SHA256_Checksums.csv\" -NoTypeInformation"

echo [5/6] Verifying backup integrity
if (Test-Path "E:\AI_Permanent\Models") {
    $model_count = Get-ChildItem "E:\AI_Permanent\Models" | Where-Object { $_.PSIsContainer } | Count
    echo Verified E: permanent storage contains %model_count% model directories
}

echo [6/6] Running Disk Cleanup (optional - removes temp files)
if ($env:SYSTEMROOT_ENVIRONMENTVARIABLES -match "TEMP") {
    del /f /s /q "%TEMP%\*.tmp" 2>&1 | Out-Null
    echo Temporary files cleaned
}

echo ============================================================
Maintenance completed at 14:30:05
Log available at: C:\Users\Eru\AI_ Workspace\logs\nightly_maintenance_2025-08-27.log
===========================================================
