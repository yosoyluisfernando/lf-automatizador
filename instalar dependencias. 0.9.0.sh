#!/bin/bash

cd "$(dirname "$0")"

# Colores para la terminal
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

function pause_exit {
    echo ""
    read -p "Presiona Enter para salir..."
    exit 1
}

echo -e "${CYAN}===============================================================================${NC}"
echo -e "${CYAN}           LF AUTOMATIZADOR - INSTALADOR DE DEPENDENCIAS${NC}"
echo -e "${CYAN}===============================================================================${NC}"
echo ""
echo "Este asistente preparará tu sistema para poder usar el programa."
echo "Por favor, NO CIERRES ESTA VENTANA. Algunos procesos pueden tardar"
echo "varios minutos en completarse y parecer que no avanzan. Es normal."
echo ""
echo "Se instalarán (si faltan):"
echo "  - Paquetes del sistema: build-essential, librerías ALSA/GTK, FFmpeg, libfuse2"
echo "  - Entorno de compilación Rust"
echo "  - Dependencias de Node.js"
echo "  - Motor de audio interno (compilado desde fuente)"
echo ""
echo -e "${CYAN}===============================================================================${NC}"
echo ""

# ============================================================
# 1. Verificando Node.js
# ============================================================
echo "[1/7] Verificando instalación de Node.js..."
if ! command -v node &> /dev/null || ! command -v npm &> /dev/null; then
    echo -e "${RED}[ERROR CRÍTICO] Node.js o npm no están instalados en tu sistema.${NC}"
    echo "El programa requiere Node.js (v18+) para funcionar."
    echo "Por favor, instálalo usando el gestor de paquetes de tu distribución."
    echo "Ejemplo (Ubuntu/Debian): sudo apt install nodejs npm"
    echo "Ejemplo (Fedora):        sudo dnf install nodejs npm"
    echo "Ejemplo (Arch):          sudo pacman -S nodejs npm"
    pause_exit
fi
NODE_VER=$(node -v)
echo -e "${GREEN}[OK] Node.js $NODE_VER detectado correctamente.${NC}"
echo ""


# ============================================================
# 2. Paquetes del sistema (CRÍTICO: ALSA, GTK, FFmpeg, libfuse2)
# ============================================================
echo "[2/7] Verificando paquetes del sistema..."

# Detectar gestor de paquetes
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
    echo "Tendrás que instalar manualmente las siguientes librerías:"
    echo "  build-essential (o equivalente), libasound2-dev, libgtk-3-dev,"
    echo "  libnss3, libxss1, libxtst6, libnotify4, libfuse2, ffmpeg"
    echo ""
    read -p "Presiona Enter para continuar de todas formas..."
    PKG_MGR=""
fi

# Lista de paquetes por gestor
if [ "$PKG_MGR" = "apt" ]; then
    PACKAGES="build-essential pkg-config python3 libasound2-dev libgtk-3-0 libnss3 libxss1 libxtst6 libnotify4 libudev-dev libx11-dev libxkbfile-dev libxi-dev ffmpeg"
    # libfuse2 puede ser libfuse2t64 en Ubuntu 24.04+
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
    echo "[INFO] Se necesitan permisos de administrador (sudo) para instalar paquetes del sistema."
    echo "[INFO] Gestor detectado: $PKG_MGR"
    echo "[INFO] Paquetes: $PACKAGES"
    echo ""

    case "$PKG_MGR" in
        apt)
            sudo apt update
            sudo apt install -y $PACKAGES
            ;;
        dnf)
            sudo dnf install -y $PACKAGES
            ;;
        pacman)
            sudo pacman -S --needed --noconfirm $PACKAGES
            ;;
        zypper)
            sudo zypper install -y $PACKAGES
            ;;
    esac

    if [ $? -eq 0 ]; then
        echo -e "${GREEN}[OK] Paquetes del sistema instalados correctamente.${NC}"
    else
        echo -e "${YELLOW}[ADVERTENCIA] Hubo errores instalando paquetes del sistema. Continuando...${NC}"
        echo "Si el programa no funciona después, revisa los errores arriba."
    fi
fi
echo ""


# ============================================================
# 3. Verificando/Instalando Rust
# ============================================================
echo "[3/7] Verificando entorno de compilación Rust..."
if ! command -v cargo &> /dev/null; then
    echo "[INFO] Rust no está instalado. Se procederá con la descarga e instalación automática."
    echo "[INFO] Descargando instalador de Rust..."
    if command -v curl &> /dev/null; then
        curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal

        # Cargar variables de entorno de Rust en esta sesión
        if [ -f "$HOME/.cargo/env" ]; then
            source "$HOME/.cargo/env"
        fi

        if ! command -v cargo &> /dev/null; then
            echo -e "${RED}[ERROR] La instalación de Rust falló o no se configuró el PATH.${NC}"
            pause_exit
        fi
    else
        echo -e "${RED}[ERROR] Se requiere el programa 'curl' para instalar Rust automáticamente.${NC}"
        echo "Por favor, instálalo (ej. sudo apt install curl) e intenta de nuevo."
        pause_exit
    fi
fi
echo -e "${GREEN}[OK] Rust detectado correctamente.${NC}"
echo ""


# ============================================================
# 4. Verificando compilador C/C++
# ============================================================
echo "[4/7] Verificando compilador C/C++..."
if ! command -v gcc &> /dev/null && ! command -v clang &> /dev/null; then
    echo -e "${YELLOW}[ADVERTENCIA] No se detectó un compilador C (gcc/clang).${NC}"
    echo "Si el paso 2 instaló build-essential correctamente, esto no debería ocurrir."
    echo "La compilación de Rust probablemente fallará."
else
    echo -e "${GREEN}[OK] Compilador C/C++ detectado.${NC}"
fi
echo ""


# ============================================================
# 5. Instalando dependencias de Node.js
# ============================================================
echo "[5/7] Instalando dependencias del entorno Node.js..."

# Solución preventiva: Reparar permisos rotos de npm y electron (Error EACCES)
if [ -d "$HOME/.cache/electron" ] && [ ! -w "$HOME/.cache/electron" ]; then
    echo "[INFO] Permisos bloqueados en la caché de Electron. Solicitando acceso para reparar..."
    sudo chown -R "$USER:$USER" "$HOME/.cache/electron"
fi
if [ -d "$HOME/.npm" ] && [ ! -w "$HOME/.npm" ]; then
    echo "[INFO] Permisos bloqueados en la caché de NPM. Solicitando acceso para reparar..."
    sudo chown -R "$USER:$USER" "$HOME/.npm"
fi

echo "[INFO] Descargando e instalando paquetes..."
echo "[INFO] Por favor, ten paciencia, puede tomar varios minutos. No te preocupes por las advertencias (WARN)."
if ! npm install; then
    echo -e "${RED}[ERROR] Falló la instalación de dependencias de Node.js.${NC}"
    pause_exit
fi

echo ""
echo "[INFO] Preparando librerías nativas de Node... ESTO PUEDE TOMAR BASTANTE TIEMPO."
npx electron-rebuild || echo -e "${YELLOW}[ADVERTENCIA] electron-rebuild reportó un error, pero podría ser no crítico.${NC}"
echo -e "${GREEN}[OK] Dependencias de Node.js listas.${NC}"
echo ""


# ============================================================
# 6. Compilando motor de audio en Rust
# ============================================================
echo "[6/7] Compilando el Motor de Audio interno..."
echo "[INFO] Se están descargando componentes y compilando el código en Rust."
echo "[INFO] Este es el paso que más tiempo consume. Dependiendo de tu PC puede tardar de 1 a 5 minutos."

if ! cd audio-engine-rust; then
    echo -e "${RED}[ERROR] No se encuentra la carpeta audio-engine-rust.${NC}"
    pause_exit
fi

if ! cargo build --release; then
    echo ""
    echo -e "${RED}[ERROR CRÍTICO] Falló la compilación del motor de audio en Rust.${NC}"
    echo "Revisa si hay errores más arriba. El programa necesita este motor."
    cd ..
    pause_exit
fi

echo -e "${GREEN}[OK] Compilación finalizada correctamente.${NC}"
echo "[INFO] Guardando el ejecutable optimizado..."
mkdir -p ../bin
cp target/release/lf-audio-engine ../bin/lf-audio-engine
chmod +x ../bin/lf-audio-engine

echo "[INFO] Limpiando archivos temporales pesados para ahorrar espacio en disco..."
cargo clean > /dev/null 2>&1
cd ..
echo ""


# ============================================================
# 7. Limpieza final
# ============================================================
echo "[7/7] Tareas finales de limpieza y optimización..."
npm cache clean --force > /dev/null 2>&1
echo -e "${GREEN}[OK] Optimización terminada.${NC}"
echo ""

echo -e "${GREEN}===============================================================================${NC}"
echo -e "${GREEN}            INSTALACIÓN COMPLETADA CON ÉXITO${NC}"
echo -e "${GREEN}===============================================================================${NC}"
echo ""
echo "Todas las dependencias han sido instaladas correctamente."
echo "Ya puedes disfrutar de LF Automatizador."
echo "Para abrir el programa, haz doble clic en el archivo:"
echo "\"Iniciar automatizador 0.9.0.sh\""
echo ""
read -p "Presiona Enter para salir..."
exit 0
