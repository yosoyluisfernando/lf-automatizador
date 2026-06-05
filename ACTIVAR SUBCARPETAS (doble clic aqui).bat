@echo off
:: ============================================================
::  LF Automatizador — Activar subcarpetas en carpetas aleatorias
::  Doble clic para ejecutar. No requiere permisos de administrador.
:: ============================================================
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0activar_subcarpetas.ps1"
pause
