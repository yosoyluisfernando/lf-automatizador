@echo off
setlocal EnableDelayedExpansion
title Instalador de Dependencias - LF Automatizador v0.9.11
color 0B

cd /d "%~dp0"

echo ===============================================================================
echo         LF AUTOMATIZADOR v0.9.11 - INSTALADOR DE DEPENDENCIAS
echo         Compatible con Windows 10 y Windows 11
echo ===============================================================================
echo.
echo Este asistente preparara tu sistema para poder usar el programa.
echo Por favor, NO CIERRES ESTA VENTANA. Algunos procesos pueden tardar
echo varios minutos en completarse y parecer que no avanzan. Es normal.
echo.
echo Se instalaran (si faltan):
echo   - Microsoft Visual C++ Runtime (necesario para reproducir audio)
echo   - Entorno de compilacion Rust + compilador C/C++ ligero
echo   - Dependencias de Node.js (incluye motor de interfaz Electron)
echo   - Motor de audio interno (compilado desde fuente en Rust)
echo.
echo ===============================================================================
echo.

:: ============================================================
:: 1. Verificando Node.js y version minima requerida
:: ============================================================
echo [1/7] Verificando instalacion de Node.js (v22.12.0 o superior)...
node -v >nul 2>&1
if %errorlevel% neq 0 (
    color 0C
    echo [ERROR CRITICO] Node.js no esta instalado o no fue detectado en el sistema.
    echo El programa requiere Node.js v22.12.0 o superior.
    echo Por favor, descargalo e instalalo desde: https://nodejs.org/
    echo Asegurate de marcar la opcion "Add to PATH" durante la instalacion.
    echo Luego cierra y vuelve a ejecutar este script.
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do set NODE_VERSION=%%v
echo [INFO] Node.js detectado: !NODE_VERSION!

:: Verificar version minima v22.12.0
node -e "const v=process.version.slice(1).split('.').map(Number);if(v[0]<22||(v[0]===22&&v[1]<12)){process.exit(1);}" >nul 2>&1
if %errorlevel% neq 0 (
    color 0C
    echo [ERROR CRITICO] Tu version de Node.js (!NODE_VERSION!) es demasiado antigua.
    echo Se requiere Node.js v22.12.0 o superior.
    echo Por favor actualiza Node.js desde: https://nodejs.org/
    echo Luego cierra y vuelve a ejecutar este script.
    echo.
    pause
    exit /b 1
)
echo [OK] Node.js !NODE_VERSION! cumple el requisito minimo.
echo.


:: ============================================================
:: 2. Microsoft Visual C++ Runtime (CRITICO para el motor de audio)
:: ============================================================
echo [2/7] Verificando Microsoft Visual C++ Runtime (x64)...
reg query "HKLM\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" /v Installed >nul 2>&1
if %errorlevel% equ 0 (
    echo [OK] Visual C++ Runtime ya esta instalado.
    goto vcredist_done
)

if exist "%SystemRoot%\System32\vcruntime140.dll" (
    echo [OK] Visual C++ Runtime detectado en System32.
    goto vcredist_done
)

echo [INFO] Visual C++ Runtime NO detectado. Es necesario para el motor de audio.
echo [INFO] Descargando vc_redist.x64.exe desde Microsoft (~25 MB)...
powershell -Command "Invoke-WebRequest -Uri 'https://aka.ms/vs/17/release/vc_redist.x64.exe' -OutFile 'vc_redist.x64.exe' -UseBasicParsing"

if not exist "vc_redist.x64.exe" (
    color 0C
    echo [ERROR] No se pudo descargar vc_redist.x64.exe. Verifica tu conexion a internet.
    echo Puedes instalarlo manualmente desde: https://aka.ms/vs/17/release/vc_redist.x64.exe
    echo Luego vuelve a ejecutar este script.
    pause
    exit /b 1
)

echo [INFO] Ejecutando instalador de Visual C++ (puede pedir permisos de administrador)...
vc_redist.x64.exe /install /quiet /norestart
set "VC_EXITCODE=%errorlevel%"

if "!VC_EXITCODE!"=="0"    echo [OK] Visual C++ Runtime instalado correctamente.
if "!VC_EXITCODE!"=="1638" echo [OK] Ya hay una version mas reciente de Visual C++ Runtime instalada.
if "!VC_EXITCODE!"=="3010" echo [OK] Visual C++ Runtime instalado. Se recomienda reiniciar Windows despues.

if not "!VC_EXITCODE!"=="0" if not "!VC_EXITCODE!"=="1638" if not "!VC_EXITCODE!"=="3010" (
    color 0E
    echo [ADVERTENCIA] vc_redist devolvio codigo !VC_EXITCODE!. Si el audio no funciona,
    echo instala manualmente: https://aka.ms/vs/17/release/vc_redist.x64.exe
)
del vc_redist.x64.exe >nul 2>&1

:vcredist_done
echo.


:: ============================================================
:: 3. Verificando/Instalando Rust (toolchain GNU)
:: ============================================================
echo [3/7] Verificando entorno de compilacion Rust...
cargo -V >nul 2>&1
if %errorlevel% equ 0 goto rust_ok

echo [INFO] Rust no esta instalado. Descargando instalador automaticamente...
powershell -Command "Invoke-WebRequest -Uri 'https://win.rustup.rs/' -OutFile 'rustup-init.exe' -UseBasicParsing"
if not exist "rustup-init.exe" (
    color 0C
    echo [ERROR] No se pudo descargar el instalador de Rust. Verifica tu conexion.
    pause
    exit /b 1
)

echo [INFO] Instalando Rust con toolchain GNU ligero (puede tardar varios minutos)...
rustup-init.exe -y --default-host x86_64-pc-windows-gnu --profile minimal
del rustup-init.exe >nul 2>&1

set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

cargo -V >nul 2>&1
if %errorlevel% neq 0 (
    color 0C
    echo [ERROR] La instalacion de Rust fallo o no se configuro el PATH.
    pause
    exit /b 1
)
echo [OK] Rust instalado correctamente.
goto rust_done

:rust_ok
echo [OK] Rust detectado. Configurando toolchain GNU...
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
echo [INFO] Descargando w64devkit (~80 MB). Por favor espera...
powershell -Command "Invoke-WebRequest -Uri 'https://github.com/skeeto/w64devkit/releases/download/v1.20.0/w64devkit-1.20.0.zip' -OutFile 'w64devkit.zip' -UseBasicParsing"

if not exist "w64devkit.zip" (
    color 0C
    echo [ERROR] Fallo la descarga del compilador. Verifica tu conexion a internet.
    pause
    exit /b 1
)

echo [INFO] Extrayendo compilador en tu carpeta de usuario...
powershell -Command "Expand-Archive -Path 'w64devkit.zip' -DestinationPath '%USERPROFILE%\' -Force"
del w64devkit.zip >nul 2>&1

if not exist "%W64_BIN%\gcc.exe" (
    color 0C
    echo [ERROR] La extraccion del compilador fallo.
    pause
    exit /b 1
)
echo [OK] Compilador C/C++ instalado correctamente.
goto gcc_done

:gcc_ok
echo [OK] Compilador C/C++ detectado.

:gcc_done
set "PATH=%W64_BIN%;%PATH%"

:: Parche de compatibilidad: libgcc_eh es requerida por el linker Rust + w64devkit
if not exist "%W64_LIB%" goto fix_fallback
if not exist "%W64_LIB%\libgcc_eh.a" (
    echo [INFO] Aplicando parche de compatibilidad del linker (libgcc_eh)...
    "%W64_BIN%\ar.exe" rc "%W64_LIB%\libgcc_eh.a" 2>nul
)
goto fix_done

:fix_fallback
if exist "%USERPROFILE%\w64devkit\lib" (
    if not exist "%USERPROFILE%\w64devkit\lib\libgcc_eh.a" (
        "%W64_BIN%\ar.exe" rc "%USERPROFILE%\w64devkit\lib\libgcc_eh.a" 2>nul
    )
)

:fix_done
echo.


:: ============================================================
:: 5. Instalando dependencias de Node.js (con verificacion de Electron)
:: ============================================================
echo [5/7] Instalando dependencias del entorno Node.js...
echo.

:: Configurar mirror alternativo para Electron ANTES de instalar.
:: Esto evita fallos de descarga por firewalls o CDN lento de GitHub.
:: El mirror de npmmirror (Alibaba CDN) es identico al oficial y mas robusto.
echo [INFO] Configurando canal de descarga para Electron...
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"

echo [INFO] Limpiando cache de npm para asegurar descarga limpia...
call npm cache clean --force >nul 2>&1

echo [INFO] Descargando e instalando paquetes (puede tomar varios minutos)...
echo [INFO] Es normal ver advertencias WARN. No las cierres.
call npm install
if %errorlevel% neq 0 (
    color 0E
    echo [ADVERTENCIA] npm install reporto errores. Intentando continuar de todas formas...
)
echo.

:: --- VERIFICACION CRITICA: confirmar que el binario de Electron fue descargado ---
echo [INFO] Verificando que Electron fue descargado correctamente...
set "ELECTRON_EXE=node_modules\electron\dist\electron.exe"

if exist "!ELECTRON_EXE!" goto electron_ok

:: Electron no se descargo correctamente - iniciar rutina de reparacion
echo.
echo [REPARANDO] El binario de Electron no fue descargado.
echo [INFO] Esto ocurre por bloqueos de red, antivirus o interrupciones de descarga.
echo [INFO] Iniciando reparacion automatica (puede tardar 1-2 minutos)...
echo.

:: Limpiar instalacion rota
rd /s /q "node_modules\electron" >nul 2>&1
call npm cache clean --force >nul 2>&1

:: Intento 1: Reinstalar electron con mirror alternativo activo
echo [INFO] Reintento 1: Descargando Electron desde mirror alternativo...
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
call npm install electron --save-dev
if exist "!ELECTRON_EXE!" goto electron_ok

:: Intento 2: Sin mirror, desde GitHub directo
echo [INFO] Reintento 2: Descargando desde GitHub directamente...
set "ELECTRON_MIRROR="
rd /s /q "node_modules\electron" >nul 2>&1
call npm install electron --save-dev
if exist "!ELECTRON_EXE!" goto electron_ok

:: Los dos intentos fallaron
color 0C
echo.
echo [ERROR] No fue posible instalar Electron automaticamente tras 2 intentos.
echo Esto puede deberse a un antivirus, firewall o conexion inestable.
echo.
echo -----------------------------------------------------------------------
echo  SOLUCION MANUAL (ejecuta estos comandos en una consola abierta aqui):
echo.
echo  1. rd /s /q node_modules\electron
echo  2. set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
echo  3. npm install electron --save-dev
echo -----------------------------------------------------------------------
echo.
pause
exit /b 1

:electron_ok
echo [OK] Electron instalado y verificado correctamente.
echo.

:: Reconstruir modulos nativos para la version de Electron instalada
echo [INFO] Reconstruyendo librerias nativas de Node... ESTO PUEDE TOMAR VARIOS MINUTOS.
echo [INFO] La consola puede parecer congelada. NO LA CIERRES.
call npx electron-rebuild
if %errorlevel% neq 0 (
    color 0E
    echo [ADVERTENCIA] electron-rebuild reporto un error, pero puede no ser critico.
)
echo [OK] Dependencias de Node.js listas.
echo.


:: ============================================================
:: 6. Compilando motor de audio Rust
:: ============================================================
echo [6/7] Compilando el Motor de Audio interno (Rust)...
echo [INFO] Descargando dependencias de Rust y compilando el motor de audio.
echo [INFO] Este paso puede tardar de 1 a 5 minutos segun la velocidad de tu PC.
echo [INFO] Por favor espera a que aparezca "Compilacion finalizada".

cd audio-engine-rust

:: Usar directorio temporal para evitar errores con rutas que contienen espacios
set "CARGO_TARGET_DIR=%TEMP%\lf_audio_target"

call cargo build --release
set "BUILD_ERRORLEVEL=%errorlevel%"
set "CARGO_TARGET_DIR="

if %BUILD_ERRORLEVEL% neq 0 (
    color 0C
    echo.
    echo [ERROR CRITICO] Fallo la compilacion del motor de audio en Rust.
    echo Revisa los mensajes de error anteriores en esta ventana.
    echo El programa no puede funcionar sin el motor de audio.
    cd ..
    pause
    exit /b 1
)

echo [OK] Compilacion finalizada correctamente.
echo [INFO] Copiando motor de audio a la carpeta del programa...
if not exist "..\bin" mkdir "..\bin"
copy /Y "%TEMP%\lf_audio_target\release\lf-audio-engine.exe" "..\bin\lf-audio-engine.exe" >nul

echo [INFO] Limpiando archivos temporales de compilacion...
rmdir /s /q "%TEMP%\lf_audio_target" >nul 2>&1
cd ..
echo.


:: ============================================================
:: 7. Limpieza final
:: ============================================================
echo [7/7] Tareas finales de limpieza...
call npm cache clean --force >nul 2>&1
echo [OK] Limpieza terminada.
echo.

color 0A
echo ===============================================================================
echo         INSTALACION COMPLETADA CON EXITO  -  LF Automatizador v0.9.11
echo ===============================================================================
echo.
echo Todas las dependencias han sido instaladas correctamente.
echo.
echo Para abrir el programa, haz doble clic en:
echo   "Iniciar automatizador Windows.bat"
echo.
pause
exit
