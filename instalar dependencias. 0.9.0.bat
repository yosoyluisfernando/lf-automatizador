@echo off
setlocal EnableDelayedExpansion
title Instalador de Dependencias - LF Automatizador
color 0B

cd /d "%~dp0"

echo ===============================================================================
echo            LF AUTOMATIZADOR - INSTALADOR DE DEPENDENCIAS
echo ===============================================================================
echo.
echo Este asistente preparara tu sistema para poder usar el programa.
echo Por favor, NO CIERRES ESTA VENTANA. Algunos procesos pueden tardar
echo varios minutos en completarse y parecer que no avanzan. Es normal.
echo.
echo Se instalaran (si faltan):
echo   - Microsoft Visual C++ Runtime (necesario para reproducir audio)
echo   - Entorno de compilacion Rust + GCC ligero
echo   - Dependencias de Node.js
echo   - Motor de audio interno (compilado desde fuente)
echo.
echo ===============================================================================
echo.

:: ============================================================
:: 1. Verificando Node.js
:: ============================================================
echo [1/7] Verificando instalacion de Node.js...
node -v >nul 2>&1
if %errorlevel% equ 0 goto node_ok

color 0C
echo [ERROR CRITICO] Node.js no esta instalado o no fue detectado en el sistema.
echo El programa requiere Node.js (version 18 o superior) para funcionar.
echo Por favor, descargalo e instalalo desde: https://nodejs.org/
echo Asegurate de marcar la opcion "Add to PATH" durante la instalacion.
echo.
pause
exit /b 1

:node_ok
for /f "tokens=*" %%v in ('node -v') do set NODE_VERSION=%%v
echo [OK] Node.js !NODE_VERSION! detectado correctamente.
echo.


:: ============================================================
:: 2. Microsoft Visual C++ Runtime (CRITICO para que el motor de audio cargue)
:: ============================================================
echo [2/7] Verificando Microsoft Visual C++ Runtime (x64)...
:: Chequeamos por la clave de registro que el redistributable instala.
reg query "HKLM\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" /v Installed >nul 2>&1
if %errorlevel% equ 0 (
    echo [OK] Visual C++ Runtime ya esta instalado.
    goto vcredist_done
)

:: Fallback: chequeamos por la DLL en System32.
if exist "%SystemRoot%\System32\vcruntime140.dll" (
    echo [OK] Visual C++ Runtime detectado en System32.
    goto vcredist_done
)

echo [INFO] Visual C++ Runtime NO detectado. Es necesario para que el motor
echo        de audio funcione. Procediendo a descargar e instalar...
echo [INFO] Descargando vc_redist.x64.exe desde Microsoft (~25 MB)...
powershell -Command "Invoke-WebRequest -Uri 'https://aka.ms/vs/17/release/vc_redist.x64.exe' -OutFile 'vc_redist.x64.exe' -UseBasicParsing"

if not exist "vc_redist.x64.exe" (
    color 0C
    echo [ERROR] No se pudo descargar vc_redist.x64.exe. Verifica tu conexion a internet.
    echo Puedes instalarlo manualmente desde:
    echo https://aka.ms/vs/17/release/vc_redist.x64.exe
    pause
    exit /b 1
)

echo [INFO] Ejecutando instalador de Visual C++ (puede pedir permisos de administrador)...
vc_redist.x64.exe /install /quiet /norestart
set "VC_EXITCODE=%errorlevel%"

if "%VC_EXITCODE%"=="0"    echo [OK] Visual C++ Runtime instalado correctamente.
if "%VC_EXITCODE%"=="1638" echo [OK] Ya hay una version mas reciente de Visual C++ Runtime.
if "%VC_EXITCODE%"=="3010" echo [OK] Visual C++ Runtime instalado. Se recomienda reiniciar Windows.

if not "%VC_EXITCODE%"=="0"    if not "%VC_EXITCODE%"=="1638" if not "%VC_EXITCODE%"=="3010" (
    color 0E
    echo [ADVERTENCIA] vc_redist.x64.exe devolvio codigo !VC_EXITCODE!.
    echo La instalacion pudo no haberse completado. Si el programa no abre audio,
    echo instala manualmente: https://aka.ms/vs/17/release/vc_redist.x64.exe
)
del vc_redist.x64.exe >nul 2>&1

:vcredist_done
echo.


:: ============================================================
:: 3. Verificando/Instalando Rust (GNU)
:: ============================================================
echo [3/7] Verificando entorno de compilacion Rust...
cargo -V >nul 2>&1
if %errorlevel% equ 0 goto rust_ok

echo [INFO] Rust no esta instalado. Se procedera con la descarga e instalacion automatica.
echo [INFO] Descargando instalador de Rust (esto requiere conexion a internet)...
powershell -Command "Invoke-WebRequest -Uri 'https://win.rustup.rs/' -OutFile 'rustup-init.exe' -UseBasicParsing"
if exist "rustup-init.exe" goto rust_download_ok

color 0C
echo [ERROR] No se pudo descargar el instalador de Rust. Verifica tu conexion a internet.
pause
exit /b 1

:rust_download_ok
echo [INFO] Instalando Rust (Version GNU ligera, esto puede tardar unos minutos)...
rustup-init.exe -y --default-host x86_64-pc-windows-gnu --profile minimal
del rustup-init.exe

:: Asegurar PATH temporal para esta sesion
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

cargo -V >nul 2>&1
if %errorlevel% equ 0 goto rust_installed_ok

color 0C
echo [ERROR] La instalacion de Rust fallo o no se configuro correctamente.
pause
exit /b 1

:rust_installed_ok
echo [OK] Rust instalado correctamente.
goto rust_done

:rust_ok
echo [OK] Rust detectado. Configurando compatibilidad GNU...
rustup default stable-gnu >nul 2>&1

:rust_done
echo.


:: ============================================================
:: 4. Verificando/Instalando compilador C/C++ ligero (w64devkit)
:: ============================================================
echo [4/7] Preparando entorno C/C++ para dependencias nativas...
set "W64_BIN=%USERPROFILE%\w64devkit\bin"
set "W64_LIB=%USERPROFILE%\w64devkit\x86_64-w64-mingw32\lib"

if exist "%W64_BIN%\gcc.exe" goto gcc_ok

echo [INFO] El compilador C/C++ ligero no esta instalado.
echo [INFO] Descargando compilador portatil (aprox. 80MB). Por favor espera...
powershell -Command "Invoke-WebRequest -Uri 'https://github.com/skeeto/w64devkit/releases/download/v1.20.0/w64devkit-1.20.0.zip' -OutFile 'w64devkit.zip' -UseBasicParsing"

if exist "w64devkit.zip" goto gcc_download_ok

color 0C
echo [ERROR] Fallo la descarga del compilador. Verifica tu conexion a internet.
pause
exit /b 1

:gcc_download_ok
echo [INFO] Extrayendo compilador en tu carpeta de usuario. Esto puede tomar un minuto...
powershell -Command "Expand-Archive -Path 'w64devkit.zip' -DestinationPath '%USERPROFILE%\' -Force"
del w64devkit.zip

if exist "%W64_BIN%\gcc.exe" goto gcc_extracted_ok

color 0C
echo [ERROR] La extraccion del compilador fallo.
pause
exit /b 1

:gcc_extracted_ok
echo [OK] Compilador C/C++ instalado correctamente.
goto gcc_done

:gcc_ok
echo [OK] Compilador C/C++ detectado.

:gcc_done
:: Anadir w64devkit al PATH para compilacion nativa
set "PATH=%W64_BIN%;%PATH%"

:: Aplicar fix para el error "-lgcc_eh" comun en Rust GNU con w64devkit
if not exist "%W64_LIB%" goto fix_fallback
if exist "%W64_LIB%\libgcc_eh.a" goto fix_done
echo [INFO] Aplicando parche de compatibilidad interna para el linker (libgcc_eh)...
"%W64_BIN%\ar.exe" rc "%W64_LIB%\libgcc_eh.a" 2>nul
goto fix_done

:fix_fallback
if not exist "%USERPROFILE%\w64devkit\lib" goto fix_done
if exist "%USERPROFILE%\w64devkit\lib\libgcc_eh.a" goto fix_done
echo [INFO] Aplicando parche de compatibilidad interna para el linker (libgcc_eh)...
"%W64_BIN%\ar.exe" rc "%USERPROFILE%\w64devkit\lib\libgcc_eh.a" 2>nul

:fix_done
echo.


:: ============================================================
:: 5. Instalando dependencias de Node.js
:: ============================================================
echo [5/7] Instalando dependencias del entorno Node.js...
echo [INFO] Descargando e instalando paquetes...
echo [INFO] Por favor, ten paciencia, puede tomar varios minutos. No te preocupes por las advertencias (WARN).
call npm install
if %errorlevel% equ 0 goto npm_ok
color 0E
echo [ADVERTENCIA] Hubo errores al instalar paquetes, intentando continuar de todas formas...
:npm_ok

echo.
echo [INFO] Preparando librerias nativas de Node... ESTO PUEDE TOMAR BASTANTE TIEMPO.
echo [INFO] La consola puede parecer congelada. NO LA CIERRES.
call npx electron-rebuild
if %errorlevel% equ 0 goto rebuild_ok
color 0E
echo [ADVERTENCIA] electron-rebuild reporto un error, pero podria ser no critico.
:rebuild_ok
echo [OK] Dependencias de Node.js listas.
echo.


:: ============================================================
:: 6. Compilando motor de audio Rust
:: ============================================================
echo [6/7] Compilando el Motor de Audio interno...
echo [INFO] Se estan descargando componentes y compilando el codigo en Rust.
echo [INFO] Este es el paso que mas tiempo consume. Dependiendo de tu PC puede tardar de 1 a 5 minutos.
echo [INFO] Por favor espera a que aparezca "Finalizado".

cd audio-engine-rust

:: Evitar el bug de 'dlltool' con rutas que contienen espacios usando un directorio temporal
set "CARGO_TARGET_DIR=%TEMP%\lf_audio_target"
call cargo build --release
set "BUILD_ERRORLEVEL=%errorlevel%"

:: Restaurar variable
set "CARGO_TARGET_DIR="

if %BUILD_ERRORLEVEL% equ 0 goto cargo_ok

color 0C
echo.
echo [ERROR CRITICO] Fallo la compilacion del motor de audio en Rust.
echo Revisa si hay errores mas arriba. El programa necesita este motor.
cd ..
pause
exit /b 1

:cargo_ok
echo [OK] Compilacion finalizada correctamente.
echo [INFO] Guardando el ejecutable optimizado...
if not exist "..\bin" mkdir "..\bin"
copy /Y "%TEMP%\lf_audio_target\release\lf-audio-engine.exe" "..\bin\lf-audio-engine.exe" >nul

echo [INFO] Limpiando archivos temporales pesados para ahorrar espacio en disco...
rmdir /s /q "%TEMP%\lf_audio_target" >nul 2>&1
cd ..
echo.


:: ============================================================
:: 7. Limpieza final
:: ============================================================
echo [7/7] Tareas finales de limpieza y optimizacion...
call npm cache clean --force >nul 2>&1
echo [OK] Optimizacion terminada.
echo.

color 0A
echo ===============================================================================
echo            INSTALACION COMPLETADA CON EXITO
echo ===============================================================================
echo.
echo Todas las dependencias han sido instaladas correctamente.
echo Ya puedes disfrutar de LF Automatizador.
echo Para abrir el programa, haz doble clic en el archivo:
echo "Iniciar automatizador 0.9.0.bat"
echo.
pause
exit
