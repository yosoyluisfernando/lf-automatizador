; ============================================================
; LF Automatizador - Custom NSIS installer hooks
; ============================================================
; Este script lo incluye electron-builder a traves de la opcion
; build.nsis.include en package.json. Aqui agregamos pasos que
; electron-builder no ofrece por defecto.
;
; Hook principal: instalar el Microsoft Visual C++ 2015-2022
; Redistributable (x64) si el sistema no lo tiene. Sin esas DLLs
; (vcruntime140.dll, msvcp140.dll) el motor de audio Rust falla
; al cargar y no hay reproduccion ni emision por el encoder.
; ============================================================

!macro customInstall
  DetailPrint "Verificando Microsoft Visual C++ Runtime (x64)..."

  ; Leer la clave de registro que el redistributable instala.
  ; HKLM\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64\Installed = 1
  ClearErrors
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  ${If} ${Errors}
    StrCpy $0 "0"
  ${EndIf}

  ${If} $0 == "1"
    DetailPrint "Microsoft Visual C++ Runtime ya esta instalado. OK."
  ${Else}
    DetailPrint "Microsoft Visual C++ Runtime no detectado. Instalando version bundleada..."

    ; Extraer el redistributable al directorio temporal de la instalacion.
    SetOutPath "$PLUGINSDIR"
    File "/oname=vc_redist.x64.exe" "${BUILD_RESOURCES_DIR}\vcredist\vc_redist.x64.exe"

    DetailPrint "Ejecutando vc_redist.x64.exe /install /quiet /norestart ..."
    ExecWait '"$PLUGINSDIR\vc_redist.x64.exe" /install /quiet /norestart' $1

    ; Codigos de salida del redistributable de Microsoft:
    ;   0    = instalacion correcta
    ;   1638 = ya hay una version mas nueva instalada (tambien OK)
    ;   3010 = instalado, pero requiere reinicio para aplicar
    ;   otro = fallo
    ${If} $1 == "0"
      DetailPrint "Visual C++ Runtime instalado correctamente."
    ${ElseIf} $1 == "1638"
      DetailPrint "Visual C++ Runtime: ya hay una version mas reciente. OK."
    ${ElseIf} $1 == "3010"
      DetailPrint "Visual C++ Runtime instalado. Se recomienda reiniciar Windows."
    ${Else}
      DetailPrint "ADVERTENCIA: vc_redist.x64.exe devolvio codigo $1."
      DetailPrint "Si la aplicacion no abre, instalar manualmente desde:"
      DetailPrint "https://aka.ms/vs/17/release/vc_redist.x64.exe"
    ${EndIf}

    ; Limpiar el archivo temporal extraido.
    Delete "$PLUGINSDIR\vc_redist.x64.exe"
  ${EndIf}
!macroend
