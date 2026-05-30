@echo off
title LF Automatizador v0.9.11
cd /d "%~dp0"

echo Iniciando LF Automatizador v0.9.11...

:: Crear un script VBS temporal para lanzar npm de forma completamente invisible
echo Set WshShell = CreateObject("WScript.Shell") > "%temp%\run_hidden.vbs"
echo WshShell.Run "cmd /c npm start > error_log.txt 2>&1", 0, False >> "%temp%\run_hidden.vbs"

:: Ejecutar el VBS y borrarlo
cscript //nologo "%temp%\run_hidden.vbs"
del "%temp%\run_hidden.vbs"

:: Esperar 4 segundos para dar tiempo a que inicie
ping 127.0.0.1 -n 5 >nul

:: Revisar si el proceso electron sigue vivo
tasklist /FI "IMAGENAME eq electron.exe" 2>NUL | find /I "electron.exe" >NUL
if %errorlevel% equ 0 (
    :: Todo bien, el programa esta abierto. Cerramos la ventana negra.
    exit
) else (
    :: El programa no inicio o crasheo. Mostramos el error.
    echo.
    echo [ERROR] El programa fallo al iniciar o se cerro inesperadamente.
    echo Revisa el registro de errores a continuacion:
    echo --------------------------------------------------------
    type error_log.txt
    echo --------------------------------------------------------
    echo.
    pause
    exit /b 1
)
