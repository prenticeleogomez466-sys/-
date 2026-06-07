@echo off
chcp 65001 >nul
REM Live closing-line poller: re-fetch 500 odds for matches ~25min pre-kickoff and freeze the closing line. Runs every ~15min.
REM ASCII-only comments + absolute .mjs path so the run never depends on the scheduler working directory or active code page.
cd /d D:\football-model
"C:\Program Files\nodejs\node.exe" "D:\football-model\scripts\capture-closing-live.mjs" --window=25 >> "D:\football-model-data\logs\capture-closing-live.log" 2>&1
