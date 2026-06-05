@echo off
chcp 65001 >nul
REM Daily live-CLV accrual: score recommendations against frozen closing (final).
REM Runs after CaptureClosing (06:30) so today's closing is frozen first.
cd /d D:\football-model
"C:\Program Files\nodejs\node.exe" scripts\clv-live-score.mjs >> D:\football-model-data\logs\clv-live-score.log 2>&1
