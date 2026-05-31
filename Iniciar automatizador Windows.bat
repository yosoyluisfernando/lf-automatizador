@echo off
title LF Automatizador v0.9.11.3-beta
cd /d "%~dp0"

echo Iniciando LF Automatizador v0.9.11...
echo.

:: Cerrar procesos previos que puedan haber quedado huerfanos
:: (lf-audio-engine puede retener la tarjeta de sonido si la sesion anterior
::  cerro de forma abrupta; ffmpeg puede quedar conectado al stream de radio)
taskkill /F /IM lf-audio-engine.exe >nul 2>&1
taskkill /F /T /IM ffmpeg.exe >nul 2>&1

:: Limpiar log anterior (2>nul suprime el error si el archivo está bloqueado)
if exist error_log.txt del error_log.txt 2>nul

:: Lanzar npm start en segundo plano (ventana oculta)
echo Set WshShell = CreateObject("WScript.Shell") > "%temp%\run_lf.vbs"
echo WshShell.Run "cmd /c npm start > ""%~dp0error_log.txt"" 2>&1", 0, False >> "%temp%\run_lf.vbs"
cscript //nologo "%temp%\run_lf.vbs"
del "%temp%\run_lf.vbs"

:: Esperar hasta 20 segundos a que Electron aparezca (10 intentos x ~2s)
set /a INTENTO=0
:ESPERAR
ping 127.0.0.1 -n 3 >nul
set /a INTENTO+=1
tasklist /FI "IMAGENAME eq electron.exe" 2>NUL | find /I "electron.exe" >NUL
if %errorlevel% equ 0 goto OK
if %INTENTO% lss 10 goto ESPERAR

:: ============================================================
:: No arranco en 20 segundos - mostrar error y QUEDARSE ABIERTO
:: ============================================================
color 0C
echo.
echo [ERROR] El programa no inicio en 20 segundos.
echo.
if exist error_log.txt (
    echo Detalles del error:
    echo ----------------------------------------
    type error_log.txt
    echo ----------------------------------------
) else (
    echo No se genero ningun log de error.
    echo Posibles causas:
    echo   - Node.js no esta instalado
    echo   - Faltan dependencias ^(ejecuta instalar dependencias Windows.bat^)
    echo   - El motor de audio necesita actualizarse
)
echo.
echo Esta ventana permanecera abierta para que puedas ver el error.
echo Podes copiar el texto de arriba para compartirlo si necesitas ayuda.
echo.
pause
exit /b 1

:: ============================================================
:OK
:: Programa iniciado correctamente
:: ============================================================
color 0A
echo [OK] LF Automatizador iniciado correctamente.
echo.
echo Esta ventana se puede cerrar.
echo.
pause
exit

