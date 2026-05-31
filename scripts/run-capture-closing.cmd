@echo off
chcp 65001 >nul
REM Daily freeze closing line (current->final) so live CLV can accrue. Backfill last 2 days.
cd /d D:\football-model
"C:\Program Files\nodejs\node.exe" scripts\capture-closing.mjs --range 2 >> D:\football-model-data\logs\capture-closing.log 2>&1
