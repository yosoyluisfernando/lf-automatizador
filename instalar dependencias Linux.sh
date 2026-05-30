#!/bin/bash

cd "$(dirname "$0")"

# Colores para la terminal
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m'

function pause_exit {
    echo ""
    read -p "Presiona Enter para salir..."
    exit 1
}

echo -e "${CYAN}===============================================================================${NC}"
echo -e "${CYAN}        LF AUTOMATIZADOR v0.9.11 - INSTALADOR DE DEPENDENCIAS${NC}"
echo -e "${CYAN}        Compatible con Ubuntu, Debian, Fedora, Arch y derivadas${NC}"
echo -e "${CYAN}===============================================================================${NC}"
echo ""
echo "Este asistente preparará tu sistema para poder usar el programa."
echo "Por favor, NO CIERRES ESTA VENTANA. Algunos procesos pueden tardar"
echo "varios minutos en completarse y parecer que no avanzan. Es normal."
echo ""
echo "Se instalarán (si faltan):"
echo "  - Paquetes del sistema: build-essential, librerías ALSA/GTK, FFmpeg, libfuse2"
echo "  - Entorno de compilación Rust"
echo "  - Dependencias de Node.js (incluye motor de interfaz Electron)"
echo "  - Motor de audio interno (compilado desde fuente en Rust)"
echo ""
echo -e "${CYAN}===============================================================================${NC}"
echo ""

# ============================================================
# 1. Verificando Node.js y versión mínima
# ============================================================
echo "[1/7] Verificando instalación de Node.js (v22.12.0 o superior)..."
if ! command -v node &> /dev/null || ! command -v npm &> /dev/null; then
    echo -e "${RED}[ERROR CRÍTICO] Node.js o npm no están instalados.${NC}"
    echo "Se requiere Node.js v22.12.0 o superior."
    echo "Instálalo con el gestor de tu distribución:"
    echo "  Ubuntu/Debian: sudo apt install nodejs npm"
    echo "  Fedora:        sudo dnf install nodejs npm"
    echo "  Arch:          sudo pacman -S nodejs npm"
    echo "  O desde:       https://nodejs.org/"
    pause_exit
fi

NODE_VER=$(node -v)
echo "[INFO] Node.js detectado: $NODE_VER"

# Verificar versión mínima v22.12.0
node -e "const v=process.version.slice(1).split('.').map(Number);if(v[0]<22||(v[0]===22&&v[1]<12)){process.exit(1);}" 2>/dev/null
if [ $? -ne 0 ]; then
    echo -e "${RED}[ERROR CRÍTICO] Tu versión de Node.js ($NODE_VER) es demasiado antigua.${NC}"
    echo "Se requiere Node.js v22.12.0 o superior."
    echo "Actualiza Node.js desde: https://nodejs.org/"
    pause_exit
fi
echo -e "${GREEN}[OK] Node.js $NODE_VER cumple el requisito mínimo.${NC}"
echo ""


# ============================================================
# 2. Paquetes del sistema (ALSA, GTK, FFmpeg, libfuse2)
# ============================================================
echo "[2/7] Verificando paquetes del sistema..."

PKG_MGR=""
if command -v apt &> /dev/null; then
    PKG_MGR="apt"
elif command -v dnf &> /dev/null; then
    PKG_MGR="dnf"
elif command -v pacman &> /dev/null; then
    PKG_MGR="pacman"
elif command -v zypper &> /dev/null; then
    PKG_MGR="zypper"
else
    echo -e "${YELLOW}[ADVERTENCIA] No se detectó un gestor de paquetes conocido (apt/dnf/pacman/zypper).${NC}"
    echo "Instala manualmente: build-essential, libasound2-dev, libgtk-3-dev,"
    echo "  libnss3, libxss1, libxtst6, libnotify4, libfuse2, ffmpeg"
    echo ""
    read -p "Presiona Enter para continuar de todas formas..."
    PKG_MGR=""
fi

if [ "$PKG_MGR" = "apt" ]; then
    PACKAGES="build-essential pkg-config python3 libasound2-dev libgtk-3-0 libnss3 libxss1 libxtst6 libnotify4 libudev-dev libx11-dev libxkbfile-dev libxi-dev ffmpeg"
    if apt-cache search --names-only '^libfuse2$' 2>/dev/null | grep -q libfuse2; then
        PACKAGES="$PACKAGES libfuse2"
    elif apt-cache search --names-only '^libfuse2t64$' 2>/dev/null | grep -q libfuse2t64; then
        PACKAGES="$PACKAGES libfuse2t64"
    fi
elif [ "$PKG_MGR" = "dnf" ]; then
    PACKAGES="@development-tools pkg-config python3 alsa-lib-devel gtk3 nss libXScrnSaver libXtst libnotify systemd-devel libX11-devel libxkbfile-devel libXi-devel fuse-libs ffmpeg"
elif [ "$PKG_MGR" = "pacman" ]; then
    PACKAGES="base-devel pkgconf python alsa-lib gtk3 nss libxss libxtst libnotify systemd-libs libx11 libxkbfile libxi fuse2 ffmpeg"
elif [ "$PKG_MGR" = "zypper" ]; then
    PACKAGES="-t pattern devel_basis pkg-config python3 alsa-devel gtk3 mozilla-nss libXScrnSaver1 libXtst6 libnotify4 systemd-devel libX11-devel libxkbfile-devel libXi-devel fuse libs ffmpeg"
fi

if [ -n "$PKG_MGR" ] && [ -n "$PACKAGES" ]; then
    echo "[INFO] Se necesitan permisos de administrador (sudo) para instalar paquetes."
    echo "[INFO] Gestor detectado: $PKG_MGR"
    echo ""
    case "$PKG_MGR" in
        apt)    sudo apt update && sudo apt install -y $PACKAGES ;;
        dnf)    sudo dnf install -y $PACKAGES ;;
        pacman) sudo pacman -S --needed --noconfirm $PACKAGES ;;
        zypper) sudo zypper install -y $PACKAGES ;;
    esac
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}[OK] Paquetes del sistema instalados.${NC}"
    else
        echo -e "${YELLOW}[ADVERTENCIA] Hubo errores instalando paquetes. Continuando...${NC}"
    fi
fi
echo ""


# ============================================================
# 3. Verificando/Instalando Rust
# ============================================================
echo "[3/7] Verificando entorno de compilación Rust..."
if ! command -v cargo &> /dev/null; then
    echo "[INFO] Rust no está instalado. Descargando instalador..."
    if command -v curl &> /dev/null; then
        curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
        [ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"
        if ! command -v cargo &> /dev/null; then
            echo -e "${RED}[ERROR] La instalación de Rust falló.${NC}"
            pause_exit
        fi
    else
        echo -e "${RED}[ERROR] Se requiere 'curl' para instalar Rust. Instálalo e intenta de nuevo.${NC}"
        pause_exit
    fi
fi
echo -e "${GREEN}[OK] Rust detectado.${NC}"
echo ""


# ============================================================
# 4. Verificando compilador C/C++
# ============================================================
echo "[4/7] Verificando compilador C/C++..."
if ! command -v gcc &> /dev/null && ! command -v clang &> /dev/null; then
    echo -e "${YELLOW}[ADVERTENCIA] No se detectó un compilador C (gcc/clang).${NC}"
    echo "Si el paso 2 instaló build-essential correctamente, debería estar disponible."
else
    echo -e "${GREEN}[OK] Compilador C/C++ detectado.${NC}"
fi
echo ""


# ============================================================
# 5. Instalando dependencias de Node.js (con verificacion de Electron)
# ============================================================
echo "[5/7] Instalando dependencias del entorno Node.js..."
echo ""

# Reparar permisos de caché si están bloqueados
if [ -d "$HOME/.cache/electron" ] && [ ! -w "$HOME/.cache/electron" ]; then
    echo "[INFO] Reparando permisos de caché de Electron..."
    sudo chown -R "$USER:$USER" "$HOME/.cache/electron"
fi
if [ -d "$HOME/.npm" ] && [ ! -w "$HOME/.npm" ]; then
    echo "[INFO] Reparando permisos de caché de npm..."
    sudo chown -R "$USER:$USER" "$HOME/.npm"
fi

# Configurar mirror alternativo para Electron (CDN de npm/Alibaba, más robusto que GitHub)
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
echo "[INFO] Canal de descarga de Electron configurado."

echo "[INFO] Limpiando caché de npm..."
npm cache clean --force > /dev/null 2>&1

echo "[INFO] Instalando paquetes (puede tardar varios minutos)..."
if ! npm install; then
    echo -e "${RED}[ERROR] Falló la instalación de dependencias de Node.js.${NC}"
    pause_exit
fi
echo ""

# --- VERIFICACION CRITICA: confirmar que el binario de Electron fue descargado ---
echo "[INFO] Verificando instalación de Electron..."
ELECTRON_BIN="node_modules/electron/dist/electron"

if [ -f "$ELECTRON_BIN" ]; then
    echo -e "${GREEN}[OK] Electron instalado y verificado correctamente.${NC}"
else
    echo ""
    echo -e "${YELLOW}[REPARANDO] El binario de Electron no fue descargado.${NC}"
    echo "[INFO] Iniciando reparación automática..."

    rm -rf node_modules/electron
    npm cache clean --force > /dev/null 2>&1

    # Intento 1: Con mirror alternativo
    echo "[INFO] Reintento 1: Mirror alternativo (npmmirror)..."
    export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
    npm install electron --save-dev

    if [ ! -f "$ELECTRON_BIN" ]; then
        # Intento 2: Sin mirror (GitHub directo)
        echo "[INFO] Reintento 2: GitHub directo..."
        unset ELECTRON_MIRROR
        rm -rf node_modules/electron
        npm install electron --save-dev
    fi

    if [ -f "$ELECTRON_BIN" ]; then
        echo -e "${GREEN}[OK] Electron reparado e instalado correctamente.${NC}"
    else
        echo -e "${RED}[ERROR] No fue posible instalar Electron automáticamente.${NC}"
        echo ""
        echo "SOLUCIÓN MANUAL:"
        echo "  rm -rf node_modules/electron"
        echo "  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install electron --save-dev"
        pause_exit
    fi
fi
echo ""

echo "[INFO] Reconstruyendo librerías nativas de Node..."
npx electron-rebuild || echo -e "${YELLOW}[ADVERTENCIA] electron-rebuild reportó un error (puede no ser crítico).${NC}"
echo -e "${GREEN}[OK] Dependencias de Node.js listas.${NC}"
echo ""


# ============================================================
# 6. Compilando motor de audio en Rust
# ============================================================
echo "[6/7] Compilando el Motor de Audio interno (Rust)..."
echo "[INFO] Este paso puede tardar de 1 a 5 minutos. No cierres la ventana."

cd audio-engine-rust || { echo -e "${RED}[ERROR] No se encuentra la carpeta audio-engine-rust.${NC}"; pause_exit; }

if ! cargo build --release; then
    echo ""
    echo -e "${RED}[ERROR CRÍTICO] Falló la compilación del motor de audio en Rust.${NC}"
    echo "Revisa los mensajes de error anteriores."
    cd ..
    pause_exit
fi

echo -e "${GREEN}[OK] Compilación finalizada correctamente.${NC}"
echo "[INFO] Copiando motor de audio al programa..."
mkdir -p ../bin
cp target/release/lf-audio-engine ../bin/lf-audio-engine
chmod +x ../bin/lf-audio-engine

echo "[INFO] Limpiando archivos temporales de compilación..."
cargo clean > /dev/null 2>&1
cd ..
echo ""


# ============================================================
# 7. Limpieza final
# ============================================================
echo "[7/7] Tareas finales de limpieza..."
npm cache clean --force > /dev/null 2>&1
echo -e "${GREEN}[OK] Limpieza terminada.${NC}"
echo ""

echo -e "${GREEN}===============================================================================${NC}"
echo -e "${GREEN}        INSTALACIÓN COMPLETADA CON ÉXITO  -  LF Automatizador v0.9.11${NC}"
echo -e "${GREEN}===============================================================================${NC}"
echo ""
echo "Todas las dependencias han sido instaladas correctamente."
echo ""
echo "Para abrir el programa, haz doble clic en:"
echo "  \"Iniciar automatizador Linux.sh\""
echo ""
read -p "Presiona Enter para salir..."
exit 0
