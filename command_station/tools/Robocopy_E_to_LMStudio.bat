@echo off
setlocal enabledelayedexpansion

set "SOURCE_DIR=E:/AI_Permanent/Models"
set "DEST_DIR=C:/Users/Eru/AI_ Workspace/models/LM_Studio/Models"

robocopy "%SOURCE_DIR%" "%DEST_DIR%" /MIR /R:1 /W:1 /Z /E /COPY:DAT /LOG:"C:/Users/Eru/AI_ Workspace/logs/robocopy_reverse_%date%.log"
