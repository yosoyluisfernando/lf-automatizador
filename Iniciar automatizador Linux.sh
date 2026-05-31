#!/bin/bash
cd "$(dirname "$0")"

echo "Iniciando LF Automatizador v0.9.11..."

# Arrancar en segundo plano, completamente desvinculado de la terminal
nohup npm start > error_log.txt 2>&1 < /dev/null &
PID=$!
disown $PID

# Esperar 4 segundos para validar que haya arrancado sin crashear
sleep 4

if ps -p $PID > /dev/null; then
    # El proceso sigue vivo exitosamente, cerramos la terminal negra
    exit 0
else
    # El proceso crasheó (falló) en esos primeros segundos
    echo ""
    echo "[ERROR] El programa falló al iniciar o se cerró inesperadamente."
    echo "Revisa el registro de errores a continuación:"
    echo "--------------------------------------------------------"
    cat error_log.txt
    echo "--------------------------------------------------------"
    echo ""
    read -p "Presiona Enter para salir..."
    exit 1
fi

