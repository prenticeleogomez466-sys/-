@echo off
chcp 65001 >nul
REM Daily freeze closing line (current->final) so live CLV can accrue. Backfill last 2 days.
cd /d D:\football-model
"C:\Program Files\nodejs\node.exe" scripts\capture-closing.mjs --range 2 >> D:\football-model-data\logs\capture-closing.log 2>&1
REM World Cup closing line via The Odds API (last refresh of the day = closing snapshot for CLV).
"C:\Program Files\nodejs\node.exe" scripts\fetch-oddsapi-movement.mjs >> D:\football-model-data\logs\capture-closing.log 2>&1
