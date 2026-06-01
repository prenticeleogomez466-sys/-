@echo off
cd /d "D:\football-model"
"C:\Program Files\nodejs\node.exe" scripts\top5-league-watch.mjs >> "D:\football-model-data\logs\top5-watch.log" 2>&1

