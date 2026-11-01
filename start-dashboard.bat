@echo off
rem Serves the dashboard on http://localhost:8000 and opens it in Microsoft Edge.
rem (Web Serial needs Chrome or Edge; keep this window open while using the dashboard.)
cd /d "%~dp0"
start "" msedge http://localhost:8000
python serve.py 8000
