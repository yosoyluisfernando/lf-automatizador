@echo off
title Actualizacion Motor Stream - LF Automatizador
cd /d "%~dp0"
color 0A

echo =========================================================
echo  ACTUALIZACION MOTOR DE AUDIO (soporte retransmision)
echo =========================================================
echo.

:: 1. Cerrar instancias previas
echo [1/4] Cerrando instancias anteriores...
taskkill /F /IM electron.exe >nul 2>&1
taskkill /F /IM lf-audio-engine.exe >nul 2>&1
ping 127.0.0.1 -n 3 >nul

:: 2. Verificar que el nuevo binario existe
set "NUEVO=audio-engine-rust\target\release\lf-audio-engine.exe"
set "DESTINO=bin\lf-audio-engine.exe"

if not exist "%NUEVO%" (
    echo [ERROR] No se encontro el nuevo motor en:
    echo         %NUEVO%
    echo.
    echo Compila el motor primero con:
    echo   cd audio-engine-rust
    echo   cargo build --release
    pause
    exit /b 1
)

:: 3. Hacer backup y copiar
echo [2/4] Haciendo backup del motor anterior...
if exist "%DESTINO%" (
    copy /Y "%DESTINO%" "bin\lf-audio-engine.exe.bak" >nul
    echo         Backup guardado en bin\lf-audio-engine.exe.bak
)

echo [3/4] Copiando nuevo motor (con soporte de streams)...
copy /Y "%NUEVO%" "%DESTINO%" >nul
if errorlevel 1 (
    echo [ERROR] No se pudo copiar el binario. El archivo puede estar en uso.
    echo         Cierra la aplicacion manualmente y vuelve a ejecutar este bat.
    pause
    exit /b 1
)

:: Mostrar fecha del nuevo binario
for %%F in ("%DESTINO%") do echo         OK - Motor actualizado: %%~tF

:: 4. Iniciar la aplicacion
echo [4/4] Iniciando LF Automatizador...
echo.
echo =========================================================
echo  Iniciando... Espera que aparezca la ventana del programa
echo  Esta ventana se puede cerrar cuando el programa abra.
echo =========================================================
echo.

start "" npm start
ping 127.0.0.1 -n 6 >nul

tasklist /FI "IMAGENAME eq electron.exe" 2>NUL | find /I "electron.exe" >NUL
if %errorlevel% equ 0 (
    echo [OK] LF Automatizador iniciado correctamente.
    echo.
    echo Podes cerrar esta ventana.
    pause
) else (
    echo [AVISO] No se detecto electron.exe en 6 segundos.
    echo Si el programa abrio igual, esta bien - puede tardar mas.
    echo Si no abrio, revisa error_log.txt en esta carpeta.
    echo.
    if exist error_log.txt (
        echo --- error_log.txt ---
        type error_log.txt
        echo ---------------------
    )
    pause
)
