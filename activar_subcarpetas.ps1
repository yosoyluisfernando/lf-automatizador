# ==============================================================================
#   LF Automatizador - Activar subcarpetas en carpetas aleatorias
#   Autor: Luis Fernando
#   https://github.com/yosoyluisfernando/lf-automatizador
#   Licencia: GPL-3.0  |  Codigo abierto y auditable
# ==============================================================================
#
#  COMO EJECUTAR ESTE SCRIPT:
#    1. Haz clic derecho sobre este archivo (.ps1)
#    2. Selecciona "Ejecutar con PowerShell"
#    3. Si Windows pregunta si deseas permitir la ejecucion, acepta.
#
#  QUE HACE ESTE SCRIPT:
#  ----------------------------------------------------------------
#  Busca tu configuracion de LF Automatizador y activa la opcion
#  "incluir subcarpetas" en todas tus carpetas aleatorias guardadas.
#
#  ARCHIVOS QUE TOCA:
#    session_state.json      -> tus playlists guardadas
#    general_settings.json   -> ajustes generales del programa
#
#  ARCHIVOS QUE NO TOCA:
#    Tu musica (no modifica ningun archivo de audio)
#    Nada fuera de la carpeta de configuracion del programa
#    No envia nada a internet
#    No requiere permisos de administrador
#
#  COPIA DE SEGURIDAD:
#    Antes de cualquier cambio se crea un respaldo .bak en la misma
#    carpeta. Para revertir: renombra el .bak quitando esa extension.
# ==============================================================================

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# -- Helpers visuales ----------------------------------------------------------

function Write-Header {
    Clear-Host
    Write-Host ""
    Write-Host "  +----------------------------------------------------------+" -ForegroundColor Cyan
    Write-Host "  |      LF AUTOMATIZADOR - Activador de Subcarpetas         |" -ForegroundColor Cyan
    Write-Host "  |                  por Luis Fernando                       |" -ForegroundColor DarkCyan
    Write-Host "  +----------------------------------------------------------+" -ForegroundColor Cyan
    Write-Host ""
}

function Write-Step($numero, $texto) {
    Write-Host "  [$numero] $texto" -ForegroundColor White
}

function Write-OK($texto) {
    Write-Host "      OK  $texto" -ForegroundColor Green
}

function Write-Info($texto) {
    Write-Host "       -  $texto" -ForegroundColor DarkGray
}

function Write-Warn($texto) {
    Write-Host "      !!  $texto" -ForegroundColor Yellow
}

function Write-Fail($texto) {
    Write-Host "    FAIL  $texto" -ForegroundColor Red
}

function Write-Separador {
    Write-Host "  ----------------------------------------------------------" -ForegroundColor DarkGray
}

function Esperar {
    Write-Host ""
    Write-Host "  Presiona Enter para cerrar esta ventana..." -ForegroundColor DarkGray
    Read-Host | Out-Null
}

# -- Inicio --------------------------------------------------------------------

Write-Header

# -- PASO 1: Encontrar la carpeta de configuracion -----------------------------

Write-Step "1" "Buscando tu configuracion de LF Automatizador..."
Write-Host ""

$configDir = Join-Path $env:APPDATA "LF Automatizador\config"

if (-not (Test-Path $configDir)) {
    Write-Fail "No se encontro la carpeta de configuracion."
    Write-Host ""
    Write-Host "  Se buscaba en:" -ForegroundColor DarkGray
    Write-Host "  $configDir" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  Posibles causas:" -ForegroundColor White
    Write-Host "   - LF Automatizador no esta instalado en este equipo." -ForegroundColor Gray
    Write-Host "   - El programa nunca se ha abierto (necesita abrirse" -ForegroundColor Gray
    Write-Host "     al menos una vez para crear su configuracion)." -ForegroundColor Gray
    Esperar
    exit 1
}

Write-OK "Configuracion encontrada"
Write-Info $configDir
Write-Host ""
Write-Separador
Write-Host ""

# -- PASO 2: Verificar que el programa este cerrado ----------------------------

Write-Step "2" "Verificando que LF Automatizador este cerrado..."
Write-Host ""

$proceso = Get-Process -Name "LF Automatizador", "lf-automatizador" -ErrorAction SilentlyContinue

if ($proceso) {
    Write-Warn "LF Automatizador parece estar abierto ahora mismo."
    Write-Host ""
    Write-Host "  Si continuas con el programa abierto, al cerrarlo podria" -ForegroundColor Yellow
    Write-Host "  sobreescribir los cambios que hagamos aqui." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  Recomendacion: cierra el programa y vuelve a ejecutar" -ForegroundColor White
    Write-Host "  este script." -ForegroundColor White
    Write-Host ""
    Write-Host -NoNewline "  Continuar de todas formas? (s/N): " -ForegroundColor Yellow
    $resp = Read-Host
    if ($resp -notmatch '^[sS]$') {
        Write-Host ""
        Write-OK "Operacion cancelada. No se modifico nada."
        Esperar
        exit 0
    }
    Write-Host ""
} else {
    Write-OK "El programa esta cerrado. Podemos continuar."
    Write-Host ""
}

Write-Separador
Write-Host ""

# -- PASO 3: Procesar las playlists (session_state.json) ----------------------

Write-Step "3" "Revisando tus playlists guardadas..."
Write-Host ""

$sessionFile   = Join-Path $configDir "session_state.json"
$carpetasMod   = 0
$carpetasYaOk  = 0
$totalCarpetas = 0

if (-not (Test-Path $sessionFile)) {
    Write-Warn "No hay sesion guardada todavia."
    Write-Info "La preferencia global se aplicara de todas formas (paso 4)."
    Write-Host ""
} else {
    try {
        $sessionRaw = Get-Content $sessionFile -Raw -Encoding UTF8
        $session    = $sessionRaw | ConvertFrom-Json

        foreach ($playlist in $session.playlists) {
            foreach ($fila in $playlist) {
                if ($fila.type -eq 'random') {
                    $totalCarpetas++
                    if ($fila.recursive -eq $true) {
                        $carpetasYaOk++
                        Write-Info "Ya tenia subcarpetas: $($fila.titulo)"
                    } else {
                        $carpetasMod++
                        Write-OK "Activando subcarpetas: $($fila.titulo)"
                        $fila.recursive = $true
                    }
                }
            }
        }

        if ($totalCarpetas -eq 0) {
            Write-Info "No se encontraron carpetas aleatorias en tus playlists."
        } elseif ($carpetasMod -eq 0) {
            Write-Info "Todas tus carpetas ya tenian subcarpetas activadas."
        } else {
            $bak = $sessionFile + ".bak"
            Copy-Item $sessionFile $bak -Force
            Write-Host ""
            Write-Info "Respaldo guardado como: session_state.json.bak"

            $nuevoJson = $session | ConvertTo-Json -Depth 20
            [System.IO.File]::WriteAllText($sessionFile, $nuevoJson, [System.Text.Encoding]::UTF8)
            Write-Host ""
            Write-OK "$carpetasMod carpeta(s) actualizada(s) correctamente."
        }

    } catch {
        Write-Fail "No se pudo leer el archivo de sesion."
        Write-Info "El archivo puede estar danado. No se modifico nada."
        Esperar
        exit 1
    }
}

Write-Host ""
Write-Separador
Write-Host ""

# -- PASO 4: Preferencia global (general_settings.json) -----------------------

Write-Step "4" "Configurando preferencia global para carpetas nuevas..."
Write-Host ""

$settingsFile = Join-Path $configDir "general_settings.json"

if (-not (Test-Path $settingsFile)) {
    Write-Warn "No se encontro el archivo de ajustes generales."
    Write-Info "Abre LF Automatizador una vez y vuelve a ejecutar el script."
    Write-Host ""
} else {
    try {
        $settingsRaw = Get-Content $settingsFile -Raw -Encoding UTF8
        $settings    = $settingsRaw | ConvertFrom-Json
        $valorActual = $settings.randomIncludeSubfolders

        if ($valorActual -eq 'always') {
            Write-Info "La preferencia global ya estaba configurada. Sin cambios."
        } else {
            $bak = $settingsFile + ".bak"
            Copy-Item $settingsFile $bak -Force
            Write-Info "Respaldo guardado como: general_settings.json.bak"
            Write-Host ""

            if ($null -eq ($settings.PSObject.Properties | Where-Object Name -eq 'randomIncludeSubfolders')) {
                $settings | Add-Member -NotePropertyName 'randomIncludeSubfolders' -NotePropertyValue 'always'
            } else {
                $settings.randomIncludeSubfolders = 'always'
            }

            $nuevoJson = $settings | ConvertTo-Json -Depth 20
            [System.IO.File]::WriteAllText($settingsFile, $nuevoJson, [System.Text.Encoding]::UTF8)

            Write-OK "Las carpetas aleatorias nuevas tambien incluiran subcarpetas."
            Write-Info "(Ya no preguntara cada vez que agregues una carpeta aleatoria)"
        }

    } catch {
        Write-Fail "No se pudo actualizar los ajustes generales."
        Write-Info "El archivo puede estar danado. No se modifico nada."
        Esperar
        exit 1
    }
}

Write-Host ""
Write-Separador
Write-Host ""

# -- RESUMEN FINAL -------------------------------------------------------------

Write-Host "  +----------------------------------------------------------+" -ForegroundColor Green
Write-Host "  |                    TODO LISTO                            |" -ForegroundColor Green
Write-Host "  +----------------------------------------------------------+" -ForegroundColor Green
Write-Host ""
Write-Host "  Resumen de cambios:" -ForegroundColor White
Write-Host ""

if ($totalCarpetas -gt 0) {
    Write-Host "   Carpetas aleatorias encontradas  : $totalCarpetas" -ForegroundColor Gray
    Write-Host "   Actualizadas ahora               : $carpetasMod" -ForegroundColor Green
    Write-Host "   Ya tenian subcarpetas activadas  : $carpetasYaOk" -ForegroundColor DarkGray
} else {
    Write-Host "   No habia carpetas aleatorias en la sesion guardada." -ForegroundColor DarkGray
}

Write-Host "   Carpetas nuevas que agregues     : incluiran subcarpetas automaticamente" -ForegroundColor Green
Write-Host ""
Write-Host "  Respaldos disponibles en:" -ForegroundColor DarkGray
Write-Host "  $configDir" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Ya puedes abrir LF Automatizador." -ForegroundColor Cyan

Esperar
