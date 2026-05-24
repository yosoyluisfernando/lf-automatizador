#!/bin/bash

cd "$(dirname "$0")"

function pause_exit {
    echo ""
    read -p "Presiona Enter para salir..."
    exit 1
}

echo "========================================================"
echo "  Instalando dependencias para LF Automatizador 0.9.0"
echo "========================================================"
echo ""

if ! command -v node &> /dev/null; then
    echo "[ERROR] Node.js no está instalado."
    pause_exit
fi

if ! command -v npm &> /dev/null; then
    echo "[ERROR] npm no está instalado."
    pause_exit
fi

if ! command -v cargo &> /dev/null; then
    echo "[ERROR] Cargo (Rust) no está instalado."
    pause_exit
fi

echo "[1/5] Instalando dependencias de Node.js..."
echo "Por favor espera, esto descargará paquetes y puede tardar varios minutos..."

# Solución preventiva: Reparar permisos rotos de npm y electron (Error EACCES)
if [ -d "$HOME/.cache/electron" ] && [ ! -w "$HOME/.cache/electron" ]; then
    echo "[INFO] Permisos bloqueados en la caché de Electron. Solicitando acceso para reparar..."
    sudo chown -R "$USER:$USER" "$HOME/.cache/electron"
fi
if [ -d "$HOME/.npm" ] && [ ! -w "$HOME/.npm" ]; then
    echo "[INFO] Permisos bloqueados en la caché de NPM. Solicitando acceso para reparar..."
    sudo chown -R "$USER:$USER" "$HOME/.npm"
fi

if ! npm install; then
    echo "[ERROR] Falló la instalación de dependencias de Node.js."
    pause_exit
fi

echo ""
echo "[2/5] Reconstruyendo módulos nativos para Electron..."
echo "Este proceso puede demorar varios minutos mientras compila código fuente nativo..."
npx electron-rebuild || echo "[ADVERTENCIA] electron-rebuild terminó con errores."

echo ""
echo "[3/5] Compilando motor de audio en Rust..."
echo "Verás el progreso y las descargas de paquetes a continuación..."
if ! cd audio-engine-rust; then
    echo "[ERROR] No se encuentra la carpeta audio-engine-rust."
    pause_exit
fi

if ! cargo build --release; then
    echo "[ERROR] Falló la compilación del motor de audio en Rust."
    cd ..
    pause_exit
fi

echo ""
echo "[4/5] Moviendo binario y limpiando archivos temporales de Rust..."
mkdir -p ../bin
cp target/release/lf-audio-engine ../bin/lf-audio-engine
echo "Limpiando temporales pesados de Rust para ahorrar espacio..."
cargo clean
cd ..

echo ""
echo "[5/5] Limpiando caché de Node.js..."
npm cache clean --force

echo ""
echo "========================================================"
echo "  Instalación y limpieza completadas con éxito."
echo "  Iniciando LF Automatizador 0.9.0..."
echo "========================================================"
sleep 3
"./Iniciar automatizador 0.9.0.sh"
