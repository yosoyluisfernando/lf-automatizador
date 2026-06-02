# Pisadores beta inmediata Implementation Plan

**Goal:** Publicar una beta enfocada que complete la mini ventana de pisadores automaticos antes de continuar con historial, streaming y reportes.

**Architecture:** Mantener el contrato portable en `frontend/pisador_rules.js`, agregar una resolucion pura de regla efectiva y usarla desde `frontend/render.js`. La interfaz mostrara el alcance cargado, confirmara el segundo cero y renombrara la accion destructiva a `Eliminar`.

**Tech Stack:** Electron, Node.js CommonJS, `node:test`, Rust existente, electron-builder.

## Task 1: Cubrir la regla efectiva y el segundo cero

**Files:**
- Modify: `tests/pisador_rules.test.js`
- Modify: `tests/pisador_ui_regressions.test.js`

1. Agregar pruebas fallidas para prioridad local, herencia persistente exclusiva de carpetas aleatorias y deteccion de segundo cero.
2. Agregar regresiones estructurales para `Eliminar`, indicador de alcance y confirmacion antes de guardar.
3. Ejecutar las pruebas enfocadas y comprobar que fallan.

## Task 2: Completar la mini ventana

**Files:**
- Modify: `frontend/pisador_rules.js`
- Modify: `frontend/index.html`
- Modify: `frontend/render.js`

1. Implementar resolucion pura de la regla efectiva.
2. Hidratar la ventana al abrir cada elemento.
3. Mostrar si la configuracion cargada pertenece a la fila o a la carpeta recordada.
4. Cambiar `Quitar regla` por `Eliminar`.
5. Confirmar antes de guardar una regla que inicia en cero.
6. Ejecutar pruebas enfocadas y suite completa.

## Task 3: Entregar beta

1. Ejecutar `git diff --check`, `npm test` y `cargo test`.
2. Copiar los archivos rastreados cambiados a la carpeta raiz sin tocar cambios ajenos.
3. Incrementar la version beta.
4. Compilar instalador Windows con electron-builder.
5. Confirmar el arranque basico.
6. Subir rama, crear tag beta y publicar release con ejecutables.

