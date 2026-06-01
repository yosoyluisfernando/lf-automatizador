; ============================================================
; LF Automatizador - Custom NSIS installer hooks
; ============================================================
; Este script lo incluye electron-builder a traves de la opcion
; build.nsis.include en package.json. Aqui agregamos pasos que
; electron-builder no ofrece por defecto.
;
; Hook principal: detectar Microsoft Visual C++ 2015-2022
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
    DetailPrint "Microsoft Visual C++ Runtime no detectado."

    !if /FileExists "${BUILD_RESOURCES_DIR}\vcredist\vc_redist.x64.exe"
      DetailPrint "Visual C++ Runtime bundleado. El asistente de primer inicio verificara su firma digital antes de ejecutarlo."
    !else
      DetailPrint "Visual C++ Runtime no fue bundleado. El asistente de primer inicio puede descargarlo desde Microsoft."
    !endif
  ${EndIf}
!macroend
