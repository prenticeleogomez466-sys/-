@echo off
chcp 65001 >nul
REM 真临场收盘线轮询:赛前~25分钟内对临场场次重抓500真盘并冻结收盘。每~15分钟跑一次,自动逮每场临场价。
cd /d D:\football-model
"C:\Program Files\nodejs\node.exe" scripts\capture-closing-live.mjs --window=25 >> D:\football-model-data\logs\capture-closing-live.log 2>&1
