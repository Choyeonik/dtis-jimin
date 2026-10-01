@echo off
rem Native messaging manifests cannot pass arguments, so this wrapper launches
rem host.ps1 (same folder) with PowerShell. stdin/stdout pass straight through.
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0host.ps1"
