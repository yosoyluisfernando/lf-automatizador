# 05 — Editor de Pistas Avanzado (Editor de Audio)
*Módulo: `audio_editor.html` + `audio_editor.js` | Auxiliar: `editor_audio_output.js` (deshabilitado en producción)*

> **¿Qué es este módulo?**
> El Editor de Audio es una ventana dedicada que permite al operador de radio revisar y ajustar con precisión quirúrgica todos los puntos de tiempo clave de una canción: dónde comienza el audio real, dónde inicia la voz del cantante, cuándo iniciar el siguiente mix, y cuándo termina la pista. Muestra una forma de onda visual interactiva donde los marcadores pueden ser arrastrados directamente. También centraliza la edición de metadatos (artista, título, feat., álbum, género, país) con capacidad de búsqueda en internet vía MusicBrainz e iTunes. Es el corazón de la configuración de automatización de radio.

---

## 🪟 La Ventana

| Propiedad | Valor |
|---|---|
| **Título** | Editor de Pistas Avanzado |
| **Modo** | Ventana flotante independiente (no modal) |
| **Tamaño** | Diseñada para pantalla completa (`100vh`), sin scroll de página |
| **Layout** | Dos columnas: panel de controles izquierdo (350px fijo) + forma de onda derecha (flexible) |
| **Comportamiento especial** | Al cerrar con `window.close()` o con el botón Cancelar, detiene automáticamente el motor de audio Rust antes de destruir la ventana. El scroll de la forma de onda NO usa scroll de página, es interno al contenedor canvas. |
| **Atajo de teclado global** | `Espacio` → Play/Pausa (cuando el foco NO está en un campo de texto) |

---

## 🧩 Elementos de la Interfaz

### 1. Panel Izquierdo — Información y Controles

---

#### Nombre de Archivo (`#lbl-filename`)
| Pregunta | Respuesta |
|---|---|
| 🧩 **Quién** | Encabezado de texto en la parte superior del panel izquierdo |
| ⚡ **Qué** | Muestra el nombre del archivo de audio actualmente abierto en el editor |
| ⏱️ **Cuándo** | Se actualiza al recibir el IPC `load-audio-file`. Muestra "Cargando: [nombre]" durante la carga y el nombre final al completar. En caso de error muestra el mensaje de error en rojo. |
| 📍 **Dónde** | Visible en la parte superior del panel izquierdo |
| 💡 **Por qué** | El operador necesita saber qué canción está editando sin necesidad de revisar la ruta completa del archivo |

---

### 2. Fieldset — Metadatos

#### Botón "Buscar (Internet)" (`#btn-auto-internet`)
| Pregunta | Respuesta |
|---|---|
| 🧩 **Quién** | Botón azul con ícono 🌐 |
| ⚡ **Qué** | Lanza una búsqueda de metadatos en MusicBrainz e iTunes usando el nombre del archivo como término de búsqueda |
| ⏱️ **Cuándo** | Solo funciona si hay un archivo cargado (`currentFilePath` no es nulo). Cambia su texto a "⏳ Buscando..." mientras espera. |
| 📍 **Dónde** | Abre el Modal de Resultados de Búsqueda (ver sección 6) con los resultados encontrados |
| 💡 **Por qué** | Automatiza la obtención de metadatos correctos y estandarizados para la base de datos de la biblioteca. Evitar escribir a mano el nombre del artista con errores ortográficos que rompan la automatización. |

#### Botón "Leer de MP3" (`#btn-auto-local`)
| Pregunta | Respuesta |
|---|---|
| 🧩 **Quién** | Botón verde con ícono 📁 |
| ⚡ **Qué** | Lee los metadatos ID3 incrustados directamente en el archivo MP3 (etiquetas físicas del archivo) |
| ⏱️ **Cuándo** | Solo funciona si hay archivo cargado. Muestra "⏳ Leyendo..." mientras opera. Si se encuentran álbum, año o género, expande automáticamente el acordeón de metadatos adicionales. |
| 📍 **Dónde** | Rellena directamente los campos del formulario: artista, título, feat., remix, álbum, año, género |
| 💡 **Por qué** | Cuando el archivo ya viene bien etiquetado de origen (comprado legalmente o descargado de fuente confiable), es más rápido leer las etiquetas que buscar en internet |

#### Campo Artistas (`#meta-artist` + `#feat-list`)
| Pregunta | Respuesta |
|---|---|
| 🧩 **Quién** | Campo de texto para el artista principal + lista dinámica de campos para artistas invitados (Feats) |
| ⚡ **Qué** | Almacena el nombre del artista principal y la lista de artistas invitados (featurings) por separado |
| ⏱️ **Cuándo** | Siempre editable. Los feats se gestionan con botones "+" para agregar y "X" para eliminar cada invitado |
| 📍 **Dónde** | El valor se guarda en la base de datos al presionar "Guardar Cues" o navegar de pista |
| 💡 **Por qué** | La separación artista/feat permite al sistema construir créditos correctos en pantalla ("Artista ft. Invitado1, Invitado2") sin mezclar cadenas de texto |

**Sub-elemento: Botón "+ Añadir Invitado (Feat)"**
- Al hacer clic, agrega un nuevo campo de texto editable debajo del artista principal
- Cada campo feat tiene un botón "X" rojo para eliminarlo individualmente
- Los valores se recolectan como array JSON al guardar

#### Campo Título (`#meta-title`) + Checkbox Remix (`#meta-remix`)
| Pregunta | Respuesta |
|---|---|
| 🧩 **Quién** | Campo de texto para el título de la canción + checkbox "Remix" a su derecha |
| ⚡ **Qué** | Define el título oficial de la pista y si es una versión remix |
| ⏱️ **Cuándo** | Siempre editable |
| 📍 **Dónde** | El flag de Remix afecta cómo se muestra el título en automatización ("Artista - Título (Remix)") |
| 💡 **Por qué** | Distinguir remix de originales es clave para la identidad del programa de radio |

#### Acordeón "Mostrar más detalles" (`#btn-toggle-meta`)
| Pregunta | Respuesta |
|---|---|
| 🧩 **Quién** | Botón de texto con fondo transparente y borde punteado |
| ⚡ **Qué** | Muestra u oculta los campos adicionales: Álbum (`#meta-album`), Año (`#meta-year`), Género (`#meta-genre`), País (`#meta-country`) |
| ⏱️ **Cuándo** | El estado del acordeón se persiste en `localStorage` con la clave `ae_meta_expanded`. Si al cargar datos se detectan valores de álbum/año/género, el acordeón se expande automáticamente. |
| 📍 **Dónde** | Muestra/oculta el bloque `#extra-meta-container` |
| 💡 **Por qué** | Mantiene la interfaz limpia para el uso habitual (artista/título) sin eliminar la capacidad de editar datos extendidos |

**Campos dentro del acordeón:**

| Campo | ID | Autocompletado | Notas |
|---|---|---|---|
| Álbum | `#meta-album` | No | Texto libre |
| Año | `#meta-year` | No | Texto libre (4 dígitos esperados) |
| Género | `#meta-genre` | Sí (`#genre-options`) | Datalist poblado desde la base de datos vía `lib-get-genre-profiles` |
| País | `#meta-country` | Sí (`#country-options`) | Datalist poblado desde `lib-get-country-profiles`. Se rellena automáticamente desde la "carta de artista" si existe en la BD. |

---

### 3. Fieldset — Marcadores Principales

Este fieldset contiene los 5 marcadores de tiempo fundamentales de la automatización de radio. Cada uno representa un evento específico en la reproducción de la canción.

| Marcador | ID de Input | Color en Onda | Propósito |
|---|---|---|---|
| **Inicio** | `#cue-inicio` | Verde (`#2ecc71`) | Primer frame de audio real (corta el silencio inicial) |
| **Intro** | `#cue-intro` | Amarillo (`#f1c40f`) | Primer momento en que entra la voz del cantante |
| **Punto Mix** | `#cue-mix` | Azul (`#00a8ff`) | Momento ideal para iniciar el crossfade con la siguiente pista |
| **Outro** | `#cue-outro` | Rojo (`#e74c3c`) | Inicio del final instrumental / desvanecimiento vocal |
| **Fin** | `#cue-fin` | Rojo oscuro (`#c0392b`) | Último frame de audio real (corta el silencio final) |

#### Controles de cada marcador (patrón repetido × 5)
| Control | Acción |
|---|---|
| **Input** (readonly, `cue-time`) | Muestra el tiempo en segundos con 2 decimales. Formato `000.00`. Fondo negro, texto azul monoespaciado. |
| **Botón "Fijar"** | Captura el tiempo actual del cursor de reproducción y lo asigna al marcador. Llama a `setCue(tipo)`. |
| **Botón "▶"** | Salta la reproducción exactamente al tiempo guardado en ese marcador. Llama a `playFrom(tipo)`. |
| **Botón "X"** (rojo) | Resetea el marcador a `0.00`. Llama a `clearCue(tipo)`. |

> **Nota crítica para radio:** El "Punto Mix" es el marcador más importante para la automatización. El sistema lo calcula automáticamente como `fin - 1.00 segundo` cuando no existe en la base de datos. El operador debe verificarlo escuchando la transición real.

---

### 4. Fieldset — Pisadores (Eventos sobre pista)

Los "pisadores" son eventos de audio secundario que se disparan sobre la canción principal en momentos específicos. Hay cuatro pisadores uniformes (`P1` a `P4`). Cada uno puede usar un archivo específico, una carpeta aleatoria o una locución automática de hora, temperatura o humedad.

#### Pisadores P1, P2, P3 y P4 (patrón repetido × 4)
| Pregunta | Respuesta |
|---|---|
| 🧩 **Quién** | Bloque de controles con etiqueta coloreada en morado (`P1`, `P2`, `P3`, `P4`) |
| ⚡ **Qué** | Define un evento de audio secundario (jingle, cuña, ID de radio) que se reproduce sobre la canción en un tiempo específico |
| ⏱️ **Cuándo** | Solo activo si tiene una condición válida y un origen asignado |
| 📍 **Dónde** | El evento se ejecuta durante la reproducción automática según el modo seleccionado |
| 💡 **Por qué** | Permite programar jingles, cuñas o identificativos de la estación que se reproducen automáticamente en momentos predeterminados de la canción |

**Sub-controles de cada pisador:**

| Control | ID | Acción |
|---|---|---|
| Selector de condición | `#condition-p1/p2/p3/p4` | En este orden: `"Inicia en"`, `"Termina en"`, `"Termina en Intro"` e `"Inicia en Outro"`. Solo se elige una condición por pisador. |
| Input de tiempo | `#cue-p1/p2/p3/p4` | Tiempo manual en segundos. Se oculta en anclajes dinámicos. |
| Botón "Fijar" | — | Captura tiempo actual del cursor |
| Botón "X" | — | Limpia el tiempo (desactiva el pisador) |
| Selector de origen | `#source-kind-p1/p2/p3/p4` | Archivo específico, carpeta aleatoria, locución de hora, temperatura o humedad |
| Input de ruta | `#file-p1/p2/p3/p4` | Ruta readonly para archivo o carpeta. Se oculta para locuciones automáticas. |
| Botón "..." | — | Abre diálogo de archivo o carpeta según el origen seleccionado. Llama a `browsePisador(id)`. |
| Botón de engranaje | — | Abre la seguridad del pisador: cancelar con aviso, truncar al llegar al Intro o permitir superposición si ningún audio cabe. |

Los anclajes dinámicos usan los marcadores de la pista en tiempo real. Si se elige `"Termina en Intro"` sin marcador Intro, o `"Inicia en Outro"` sin marcador Outro, el editor muestra una advertencia y bloquea el guardado hasta que el marcador exista.

Cuando el origen es una carpeta aleatoria, el automatizador elige un archivo concreto al preparar la canción, mide ese mismo archivo y lo precarga sin autoplay. Al repetir o volver a cargar la pista se realiza un sorteo nuevo.

---

### 5. Panel Derecho — Forma de Onda Interactiva

#### Contenedor de la Forma de Onda (`#wave-container` / `#wave-inner`)

La forma de onda es un sistema de doble canvas (capa base + capa overlay) que permite interacción completa con marcadores.

| Pregunta | Respuesta |
|---|---|
| 🧩 **Quién** | Área principal de visualización, ocupa todo el espacio derecho disponible |
| ⚡ **Qué** | Renderiza la silueta de amplitud de la pista de audio, muestra los marcadores como líneas verticales de colores, y permite navegar haciendo clic o arrastrando |
| ⏱️ **Cuándo** | Se dibuja al cargar un archivo. Se redibuja automáticamente al redimensionar la ventana o cambiar el nivel de zoom. |
| 📍 **Dónde** | El canvas base muestra la forma de onda en azul. El canvas overlay muestra los marcadores. El cursor rojo muestra la posición de reproducción. |
| 💡 **Por qué** | Sin forma de onda visual, el operador no puede saber dónde están los silencios, las subidas de energía o los puntos exactos de transición |

**Capa base (`#ae-canvas`):**
- Renderiza la forma de onda estilo "envelope espejado" (silueta clásica tipo Adobe Audition)
- Color de relleno: azul `#00a8ff`
- Línea central tenue blanca al 8% de opacidad para marcar el "eje cero"
- El ancho del canvas = `clientWidth × zoomLevel` (se expande horizontalmente con el zoom)

**Capa overlay (`#ae-overlay-canvas`):**
- Superpuesta sobre el canvas base (z-index 2)
- Dibuja los 9 marcadores como líneas verticales punteadas con etiquetas de texto
- Colores de marcadores:
  - Verde: INICIO
  - Amarillo: INTRO
  - Azul: MIX
  - Rojo: OUTRO, FIN
  - Morado: P1, P2, P3, P4

**Cursor de reproducción (`#ae-cursor`):**
- Línea vertical roja de 1px (z-index 3)
- Se actualiza continuamente mediante `requestAnimationFrame` mientras reproduce
- Se auto-centra en el viewport cuando el cursor alcanza la mitad visible de la onda

**Contador de tiempo (`#ae-time-text`):**
- Posición fija en esquina superior izquierda de la onda
- Formato `MM:SS.mmm` (minutos:segundos.milisegundos)
- Fondo negro semitransparente, texto blanco monoespaciado

**Guía de scroll (`#ae-scroll-guide`):**
- Aparece solo cuando la forma de onda es más ancha que el contenedor (zoom > 1 en canciones largas)
- Pequeño indicador rojo luminoso sobre el scrollbar que muestra la posición proporcional del cursor
- Permite saber dónde está el playhead sin necesidad de ver la línea roja cuando está fuera del viewport

#### Interacciones con la Forma de Onda

**Clic simple en la onda:**
| Comportamiento | Detalle |
|---|---|
| Acción | Salta la reproducción al punto clickeado |
| Condición | Solo funciona si hay peaks calculados (`waveformPeaks` no nulo) |
| Efecto | Mueve el cursor rojo, actualiza el contador, inicia reproducción desde ese punto |

**Arrastre de la onda (drag horizontal):**
| Comportamiento | Detalle |
|---|---|
| Acción | Hace scroll horizontal de la vista cuando se arrastra (pan) |
| Cursor | Cambia a `grabbing` durante el arrastre |
| Auto-scroll | Al iniciar drag manual, se desactiva el auto-seguimiento del cursor. Se reactiva automáticamente 160ms después de que el cursor de audio entra al viewport visible. |

**Arrastre de marcadores:**
| Comportunta | Detalle |
|---|---|
| Detección | El sistema detecta si el mouse está a ≤10px de un marcador existente |
| Acción | Al arrastrar un marcador, su tiempo se actualiza en tiempo real con el movimiento del mouse |
| Cursor | Cambia a `ew-resize` (flecha bidireccional horizontal) |
| Soltar | Al soltar el mouse, se redibuja el overlay y el marcador queda en su nueva posición |
| Límites | Si el mouse sale del área mientras arrastra la onda, el drag se cancela. Si sale mientras arrastra un marcador, el marcador NO se suelta (puede reentrar). |

**Scroll horizontal de la onda (scrollbar):**
- La forma de onda tiene su propio scrollbar horizontal (altura 14px, con estilos personalizados azul en hover)
- Al hacer scroll manual, se desactiva el auto-seguimiento del playhead

#### Control de Zoom

**Slider de Zoom (`#zoom-slider`):**
| Pregunta | Respuesta |
|---|---|
| 🧩 **Quién** | Slider de rango horizontal, valores 1 a 30, paso 0.5 |
| ⚡ **Qué** | Aumenta o reduce el nivel de zoom horizontal de la forma de onda |
| ⏱️ **Cuándo** | Siempre disponible. El zoom es multiplicador del ancho: zoom=1 → vista completa, zoom=30 → vista de 1/30 de la canción |
| 📍 **Dónde** | Al cambiar, redibuja todo el canvas y centra la vista en el playhead actual |
| 💡 **Por qué** | Permite hacer ajustes precisos en marcadores a nivel de milisegundos (por ejemplo, cortar exactamente antes del primer beat) |

**Zoom con Ctrl + Rueda del mouse (sobre la onda):**
| Pregunta | Respuesta |
|---|---|
| ⚡ **Qué** | Zoom centrado en la posición del mouse (no en el playhead) |
| ⏱️ **Cuándo** | `Ctrl` o `Shift` mantenido + rueda de scroll sobre el área de la onda |
| 📍 **Dónde** | El punto bajo el cursor permanece fijo visualmente durante el zoom (comportamiento tipo DAW profesional) |
| 💡 **Por qué** | Más intuitivo que el slider cuando se quiere hacer zoom en una zona específica de la onda |

**Etiqueta de hint:**
- Texto gris "(Ctrl + Rueda)" junto al slider para recordar el atajo al operador

---

### 6. Panel Inferior — Controles de Reproducción y Navegación

#### Botón Play/Pausa (`#btn-master-play`)
| Pregunta | Respuesta |
|---|---|
| 🧩 **Quién** | Botón grande, texto cambia entre "▶ Play" y "⏸ Pausa" |
| ⚡ **Qué** | Alterna entre reproducción y pausa del audio |
| ⏱️ **Cuándo** | Solo reproduce si hay un archivo cargado con peaks calculados. La pausa guarda la posición actual y la retoma al presionar Play de nuevo. |
| 📍 **Dónde** | El audio se reproduce a través del motor Rust en el bus "cue" (el bus de preescucha, no el principal) |
| 💡 **Por qué** | El operador escucha la canción en el bus cue/headphone sin interferir con la señal en vivo |

> **Importante:** El Play/Pausa también se activa con `Espacio` cuando el foco no está en un campo de texto.

#### Botón Stop (`onclick="stopAudio()"`)
| Pregunta | Respuesta |
|---|---|
| ⚡ **Qué** | Detiene la reproducción y vuelve el cursor al inicio (posición 0:00) |
| 📍 **Dónde** | Reset completo: cursor al pixel 0, contador a "00:00.000", posición de pausa a 0 |

#### Botones de Navegación entre Pistas

| Botón | ID | Acción |
|---|---|---|
| **⏮ Anterior** | `#btn-prev-track` | Guarda silenciosamente los cues actuales y solicita al backend cargar la pista anterior en la lista |
| **Siguiente ⏭** | `#btn-next-track` | Guarda silenciosamente los cues actuales y solicita al backend cargar la siguiente pista en la lista |

> **Comportamiento crítico:** Ambos botones guardan PRIMERO antes de navegar. Nunca se pierden los cambios al moverse entre pistas.

#### Botón Cancelar (`onclick="window.close()"`)
| Pregunta | Respuesta |
|---|---|
| ⚡ **Qué** | Cierra el editor SIN guardar los cambios desde la última vez que se guardó |
| ⏱️ **Cuándo** | El motor Rust se detiene automáticamente antes del cierre (interceptado en `window.close`) |
| 💡 **Por qué** | Permite al operador explorar cues sin comprometerse a guardarlos |

#### Botón "💾 Guardar Cues" (`onclick="saveAndClose()"`)
| Pregunta | Respuesta |
|---|---|
| ⚡ **Qué** | Guarda todos los marcadores, metadatos y configuración de pisadores en la base de datos, luego cierra el editor |
| ⏱️ **Cuándo** | Detiene el audio primero, luego persiste todo, luego cierra |
| 📍 **Dónde** | Los datos se envían a la base de datos vía `lib-save-db-track`. Después se notifica a la aplicación con `refresh-manual-cues` para que recargue la lista. |
| 💡 **Por qué** | Los cues guardados son la "fuente de verdad" que usa el motor de automatización para reproducir la canción correctamente en antena |

---

### 7. Modal — Resultados de Búsqueda de Metadatos (`#meta-search-modal`)

| Pregunta | Respuesta |
|---|---|
| 🧩 **Quién** | Overlay de pantalla completa con caja central (85% × 85%) |
| ⚡ **Qué** | Muestra los resultados de búsqueda de metadatos en internet (MusicBrainz + iTunes) en una tabla interactiva |
| ⏱️ **Cuándo** | Se abre automáticamente al recibir el evento IPC `editor-meta-results` con resultados exitosos |
| 📍 **Dónde** | Capa z-index 9999, sobre toda la interfaz. Con blur de fondo. |

#### Tabla de resultados (`#meta-search-results`)
| Pregunta | Respuesta |
|---|---|
| ⚡ **Qué** | Tabla scrolleable con columnas: Artista Principal, Feats, Título, Remix (Sí/No), Álbum, Año, Género |
| ⏱️ **Cuándo** | El primer resultado se selecciona automáticamente al abrirse |
| 📍 **Dónde** | Filas con hover, fila seleccionada con borde azul sutil, celdas seleccionadas con borde verde |

**Modo Normal (Clic en fila):**
- Selecciona TODOS los datos de esa fila
- Actualiza el panel de "Vista Previa de tu Mezcla" con todos los datos
- La fila anterior se deselecciona

**Modo Curador (Ctrl + Clic en celda individual):**
- Toma SOLO el dato de esa celda específica
- La celda queda marcada con borde verde (`cell-selected`)
- Permite combinar datos de diferentes filas (ej: artista de fila 1, álbum de fila 3)
- La vista previa actualiza solo el campo tocado

#### Panel "Vista Previa de tu Mezcla"
- Muestra en tiempo real el resultado final antes de aplicarlo
- 7 campos: Artista, Feats, Título, Remix (coloreado: rojo=Sí, verde=No), Álbum, Año, Género
- Texto truncado con `text-overflow: ellipsis`

#### Botones del Modal
| Botón | Acción |
|---|---|
| **❌ Cancelar** | Cierra el modal sin aplicar ningún cambio. Llama a `closeMetaModal()`. |
| **✅ Aplicar al Editor** | Aplica todos los datos de la vista previa a los campos del formulario principal. Expande el acordeón de metadatos si hay álbum/año/género. Llama a `applyMetaSelection()`. |

---

## 🤖 Comportamiento Automático al Cargar una Pista

Cuando se abre el editor con una pista, el sistema ejecuta automáticamente la siguiente secuencia:

1. **Limpieza de UI:** Todos los campos se resetean a vacío/cero
2. **Lectura de tags rápida** (`editor-read-local-tags`): Intenta rellenar artista y título desde el MP3
3. **Análisis de peaks via motor Rust** (`audio-engine-rust-command → getPeaks`): Calcula la forma de onda y detecta los silencios de inicio y fin
4. **Carga de cues existentes** (`lib-get-db-track`): Si la pista ya tiene datos en la BD, se cargan. Si faltan inicio/fin/mix, se lanza el **Analizador FFmpeg** (`lib-start-analyzer-ffmpeg`) con umbrales `-36dB/-48dB/-14dB` para calcularlos automáticamente.
5. **Completado de cues con FFmpeg** (`analyzer-done`): Cuando FFmpeg termina, rellena SOLO los campos que aún están en cero (no pisa los que el usuario ya tocó).
6. **Carga de país del artista** (`lib-get-artist-card-for-track`): Si el artista tiene una "carta" en la BD con país, lo rellena silenciosamente.
7. **Dibujo de la forma de onda:** Se renderiza la onda con los peaks calculados y se dibujan todos los marcadores.

---

## 📡 Mapa de Comunicación IPC

### Mensajes enviados al Backend (`ipcRenderer.send`)

| Canal | Cuándo | Datos enviados |
|---|---|---|
| `editor-start-meta` | Al presionar "Buscar (Internet)" o "Leer de MP3" | `{ filePath, source: 'internet' \| 'local' }` |
| `lib-start-analyzer-ffmpeg` | Al cargar pista sin cues completos en BD | `[{ filePath, dbMix: -14, dbStart: -36, dbFin: -48, forceOverwrite: false }]` |
| `refresh-manual-cues` | Después de guardar cues (en `saveCuesSilently`) | _(sin datos)_ — Notifica a la app principal que recargue la lista |
| `editor-request-track` | Al presionar "Anterior" o "Siguiente" | `{ current: filePath, dir: 'prev' \| 'next' }` |

### Mensajes invocados (`ipcRenderer.invoke`)

| Canal | Cuándo | Retorna |
|---|---|---|
| `get-cache-dir` | Al iniciar el editor | `{ success, cacheDir }` — Directorio de caché de peaks |
| `lib-get-country-profiles` | Al iniciar, para poblar el datalist de países | Array de perfiles de país |
| `lib-get-genre-profiles` | Al iniciar, para poblar el datalist de géneros | Array de perfiles de género (ordenados alfabéticamente en español) |
| `lib-get-artist-card-for-track` | Al cargar una pista | `{ card: { country } }` — País del artista principal |
| `editor-read-local-tags` | Al cargar pista (paso 2 automático) | `{ artist, title }` — Tags ID3 del MP3 |
| `audio-engine-rust-command` (getPeaks) | Al cargar pista (paso 3 automático) | `{ success, message: { type:'peaks', min[], max[], bins, durationMs, silenceStart, silenceEnd } }` |
| `audio-engine-rust-command` (loadAudio) | Al iniciar reproducción | Carga la pista en el motor Rust en el bus "cue" |
| `audio-engine-rust-command` (seek) | Al reproducir desde un punto > 0.01s | Mueve el cursor del motor Rust |
| `audio-engine-rust-command` (play) | Al iniciar reproducción | Inicia la reproducción en el motor Rust |
| `audio-engine-rust-command` (stop) | Al pausar, detener o cerrar el editor | Detiene el motor Rust |
| `lib-get-db-track` | Al cargar pista (paso 4 automático) | Fila completa de la BD con todos los cues y metadatos |
| `lib-save-db-track` | Al guardar (botón💾, navegar, o cerrar guardando) | _(sin retorno útil)_ — Persiste toda la información en BD |

### Mensajes recibidos (`ipcRenderer.on`)

| Canal | Cuándo llega | Efecto en la UI |
|---|---|---|
| `load-audio-file` | Cuando la app principal ordena abrir una pista en el editor | Limpia toda la UI, carga la nueva pista, recalcula peaks y cues |
| `editor-meta-results` | Respuesta a `editor-start-meta` (internet) | Restaura el botón a "🌐 Buscar (Internet)". Si hay resultados, abre el modal de búsqueda. Si no, muestra `alert`. |
| `editor-meta-done` | Respuesta a `editor-start-meta` (local/MP3) | Restaura el botón a "📁 Leer de MP3". Rellena todos los campos de metadatos con los tags del archivo. |
| `analyzer-done` | Cuando FFmpeg terminó de analizar la pista | Rellena silenciosamente los campos de cue (inicio/fin/mix) que aún estén en cero. Redibuja el overlay de marcadores. |

---

## 🎛️ Módulo Auxiliar: `editor_audio_output.js` (Deshabilitado en Producción)

Este archivo implementó el enrutamiento de audio del editor cuando usaba el motor Web Audio API. En la versión actual (motor Rust), está **deshabilitado** y su código está comentado en `audio_editor.js`.

**Lo que hacía:**
- `createEditorOutputRouter(audioCtx)`: Creaba un nodo de ganancia que enrutaba el audio del editor a la salida correcta según la configuración:
  - **`rustAudio`**: Modo silenciado (el motor Rust maneja la salida)
  - **`direct`**: Salida directa al dispositivo seleccionado vía `setSinkId`
  - **`stream`**: Salida a través de `MediaStreamDestination` → elemento `<audio>` → dispositivo específico (fallback cuando `setSinkId` no está disponible)
- Leía la configuración de `config/general_settings.json` para saber el dispositivo de salida del bus "cue"

**Estado actual:** Completamente desactivado. El enrutamiento de audio lo maneja el motor Rust internamente.

---

## ⌨️ Atajos de Teclado

| Atajo | Condición | Acción |
|---|---|---|
| `Espacio` | El foco NO debe estar en un campo INPUT o TEXTAREA | Play / Pausa (llama a `togglePlay()`) |
| `Ctrl + Rueda` sobre la onda | Siempre que haya onda cargada | Zoom IN/OUT centrado en la posición del mouse |
| `Shift + Rueda` sobre la onda | Igual que Ctrl + Rueda | Zoom IN/OUT (comportamiento idéntico) |

---

## 🔮 Implicaciones para la v2.0 (Tauri/Rust)

| Elemento actual | Equivalente en Tauri/Rust |
|---|---|
| `ipcRenderer.invoke('audio-engine-rust-command', getPeaks)` | Comando Tauri → función Rust de análisis de peaks con caché en disco. Formato de respuesta idéntico (min[], max[], bins, durationMs, silenceStart, silenceEnd). |
| `ipcRenderer.invoke('audio-engine-rust-command', loadAudio/seek/play/stop)` | Comandos Tauri → plugin de audio Rust. El bus "audio-editor" ya existe en el motor actual; solo cambiar el transporte. |
| `ipcRenderer.invoke('lib-save-db-track')` | Comando Tauri `save_track_cues` → escritura en SQLite vía `rusqlite`. El payload JSON puede mantenerse igual. |
| `ipcRenderer.invoke('lib-get-db-track')` | Comando Tauri `get_track_cues` → query SQLite. |
| `ipcRenderer.send('lib-start-analyzer-ffmpeg', [...])` | Comando Tauri async `start_ffmpeg_analyzer` → spawns FFmpeg subprocess en Rust, emite evento `analyzer-done` al frontend via `emit`. |
| `ipcRenderer.send('editor-start-meta', { source: 'internet' })` | Comando Tauri `search_track_metadata` → llamada HTTP a MusicBrainz + iTunes API desde Rust (tokio async). Emite evento `editor-meta-results`. |
| `ipcRenderer.send('editor-start-meta', { source: 'local' })` | Comando Tauri `read_local_tags` → librería `id3` o `lofty` en Rust para leer tags ID3/MP4. Emite evento `editor-meta-done`. |
| `ipcRenderer.send('editor-request-track', { dir })` | Comando Tauri `navigate_editor_track` → el backend busca la siguiente/anterior pista en la lista y emite `load-audio-file`. |
| `ipcRenderer.send('refresh-manual-cues')` | Evento Tauri `refresh_manual_cues` → el frontend de la ventana principal recibe y recarga su lista. |
| `ipcRenderer.invoke('lib-get-country-profiles')` | Comando Tauri `get_country_profiles` → query SQLite o JSON de configuración. |
| `ipcRenderer.invoke('lib-get-genre-profiles')` | Comando Tauri `get_genre_profiles` → query SQLite, ordenado en Rust. |
| `ipcRenderer.invoke('lib-get-artist-card-for-track')` | Comando Tauri `get_artist_card` → query SQLite para la carta del artista. |
| `ipcRenderer.invoke('get-cache-dir')` | Comando Tauri `get_cache_dir` → `tauri::api::path::cache_dir()` + subdirectorio de la app. |
| Canvas de forma de onda | Se mantiene en el frontend (Tauri usa WebView). El render canvas/2D es nativo del navegador embebido. No requiere cambios en la lógica de dibujo. |
| `localStorage` (estado del acordeón) | `tauri-plugin-store` o `localStorage` (disponible en WebView de Tauri). |
| `window.browsePisador` | Diálogo Tauri de archivo o carpeta según el origen seleccionado. |
| `editor_audio_output.js` | **Eliminar completamente.** El motor Rust maneja el enrutamiento de audio. |

---

*Documentado mediante auditoría automática — LF Automatizador v1.0*
