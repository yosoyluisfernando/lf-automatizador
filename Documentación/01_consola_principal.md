# 01 — Consola Principal
*Módulo: `index.html` + `render.js` (11,138 líneas, 562 KB) | IPC: `backend/ipc/windows.js`, `backend/ipc/ui.js`*

> **¿Qué es este módulo?**
> La Consola Principal es el corazón del automatizador. Es la ventana que el operador tiene abierta durante toda la transmisión. Desde aquí controla la reproducción de música, gestiona la playlist, observa el estado del aire, dispara eventos, controla la botonera de efectos y supervisa el estado general del sistema.
> Es el módulo más grande y complejo del proyecto (562 KB de JavaScript) y actúa como el "cerebro" que coordina todos los demás módulos.

> [!NOTE]
> `render.js` incluye una nota oficial del equipo de desarrollo:
> *"Este renderer está en proceso de reducción y debe actuar como vista/control remoto. Eviten agregar aquí trabajo pesado, cálculos de flujo o decisiones de motor. Si un cambio depende de esa lógica, recomienden migrarlo a Rust, al backend o a la dependencia especializada que corresponda."*
> **Esto confirma que en la v2.0, todo el trabajo pesado debe estar en Rust.**

---

## 🪟 La Ventana

| Propiedad | Valor |
|---|---|
| Título | LF Automatizador v0.9.0 |
| Modo | Ventana principal — siempre visible durante la transmisión |
| Motor de audio | Dual: Web Audio API (HTML5) + Motor Rust (`audio_engine_client.js`) |
| Reproducción simultánea | Hasta 3 pistas en el motor Rust (`player-a`, `player-b`, `player-c`) |

---

## 🧩 Elementos de la Interfaz

### 1. Barra de Herramientas Superior (`top-toolbar`)

#### 📄 Botón Limpiar Playlist (`#btn-top-clear`)
| Pregunta | Respuesta |
|---|---|
| 🧩 **Quién** | Botón con ícono 📄 en la barra superior izquierda |
| ⚡ **Qué** | Limpia toda la playlist activa (con confirmación si hay contenido) |
| ⏱️ **Cuándo** | Siempre disponible. Muestra diálogo de confirmación si la playlist tiene canciones |
| 📍 **Dónde** | La tabla de la playlist queda vacía. El estado de sesión se guarda |
| 💡 **Por qué** | Permite al operador reiniciar la playlist para un nuevo bloque de programación |
> **Atajo de teclado:** `Ctrl+N`

#### 📂 Botón Abrir Playlist (`#btn-top-open`)
| Pregunta | Respuesta |
|---|---|
| 🧩 **Quién** | Botón con ícono 📂 en la barra superior izquierda |
| ⚡ **Qué** | Abre un explorador de archivos para cargar una playlist guardada (`.playlistlf`) |
| ⏱️ **Cuándo** | Siempre disponible |
| 📍 **Dónde** | La playlist cargada reemplaza el contenido actual de la pestaña activa |
| 💡 **Por qué** | Permite usar playlists preparadas con anticipación para programas especiales o bloques temáticos |
> **Atajo de teclado:** `Ctrl+O`

#### 💾 Botón Guardar Playlist (`#btn-top-save`)
| Pregunta | Respuesta |
|---|---|
| 🧩 **Quién** | Botón con ícono 💾 en la barra superior izquierda |
| ⚡ **Qué** | Guarda la playlist activa como archivo `.playlistlf` |
| ⏱️ **Cuándo** | Siempre disponible |
| 📍 **Dónde** | Abre un explorador de guardado. El archivo se puede reutilizar luego |
| 💡 **Por qué** | Preserva el trabajo de preparación de una playlist para reutilizarla |
> **Atajo de teclado:** `Ctrl+S`

#### 🔊 Botón Volumen de Monitores (`#btn-monitor-ui`)
| Pregunta | Respuesta |
|---|---|
| 🧩 **Quién** | Botón compacto visible solo si los monitores están habilitados en configuración |
| ⚡ **Qué** | Abre/cierra un popover con un slider vertical de volumen para los monitores |
| ⏱️ **Cuándo** | Solo visible si `monitorVolumeUiEnabled = true` Y `monitorVolumeUiMode = 'inline'` en la configuración |
| 📍 **Dónde** | Aparece un mini panel flotante con el slider de volumen MON |
| 💡 **Por qué** | Control rápido del volumen de los altavoces de la cabina sin salir de la consola |

#### ⚙️ Botón Configuración (`#btn-open-settings`)
| Pregunta | Respuesta |
|---|---|
| 🧩 **Quién** | Botón con ícono ⚙️ en la barra superior derecha |
| ⚡ **Qué** | Abre la ventana de Configuración General en una ventana separada |
| ⏱️ **Cuándo** | Siempre disponible |
| 📍 **Dónde** | Se abre la ventana `settings.html` |
| 💡 **Por qué** | Acceso rápido a las preferencias del sistema desde cualquier estado de la consola |
> **Atajo de teclado:** `Ctrl+P`
> **IPC enviado:** `open-settings`

---

### 2. Panel Superior (`top-panel`)

#### 🎵 Panel "En el Aire" (`#panel-aire`)
El panel más prominente. Muestra información de la canción que está sonando en este momento.

| Elemento | ID | Descripción |
|---|---|---|
| Canvas de forma de onda | `#waveform-canvas` | Muestra la forma de onda de la canción en reproducción. El operador puede hacer clic para saltar a un punto específico del audio |
| Barra de progreso | `#barra-progreso` | Barra horizontal que avanza con la reproducción |
| Nombre de la canción | `#txt-cancion` | Título de la pista en reproducción en letra grande. Muestra "Esperando..." si no hay audio |
| Reloj de tiempo | `#txt-tiempo` | Muestra el tiempo transcurrido o restante. **Clic para alternar** entre "Tiempo Transcurrido" y "Tiempo Restante" |
| Etiqueta de segmento | `#lbl-tiempo` | Cambia a "INTRO" o "OUTRO" cuando la pista está en esos segmentos |
| Cuenta regresiva de cue | `#txt-cue-countdown` | Muestra cuántos segundos quedan del segmento INTRO u OUTRO actual |
| Hora de finalización | `#txt-acaba` | Muestra a qué hora exacta terminará la pista actual |
| VU Meter L | `#vu-l-cover` | Medidor de nivel del canal izquierdo en tiempo real |
| VU Meter R | `#vu-r-cover` | Medidor de nivel del canal derecho en tiempo real |

**Interacción con el panel "En el Aire":**
| Acción | Qué hace |
|---|---|
| Clic en `#txt-tiempo` | Alterna entre mostrar "Tiempo Transcurrido" y "Tiempo Restante" |
| Clic en el canvas | Busca (seek) a esa posición en el audio en reproducción |
| Clic derecho en el canvas | Abre un menú para adelantar o atrasar el punto de reproducción |

#### 🎚️ Faders de Salida (`output-faders`)

| Fader | ID | Descripción |
|---|---|---|
| PGM (Programa) | `#master-volume` | **Volumen master** de toda la salida al aire. Slider vertical, rango 0-100 |
| MON (Monitor) | `#monitor-volume` | Volumen de los altavoces de cabina. Solo visible si los monitores están habilitados en configuración |

#### ⏰ Widget de Reloj (`#btn-reloj`)
| Pregunta | Respuesta |
|---|---|
| 🧩 **Quién** | Widget de reloj en la esquina superior derecha. Muestra fecha y hora en tiempo real |
| ⚡ **Qué** | Clic izquierdo: lanza inmediatamente la Locución de Hora (el audio que anuncia la hora). Clic derecho: agrega la Locución de Hora a la playlist como un ítem programado |
| ⏱️ **Cuándo** | Clic izquierdo: solo si hay una carpeta de locuciones configurada. Clic derecho: siempre disponible |
| 📍 **Dónde** | Clic izquierdo: la locución de hora suena inmediatamente. Clic derecho: aparece un ítem de tipo "time" en la playlist |
| 💡 **Por qué** | Permite al operador anunciar la hora con un solo clic durante la transmisión, sin buscar el archivo manualmente |

#### 🌡️ Widgets de Clima
| Widget | ID | Descripción |
|---|---|---|
| Temperatura | `#temp-widget` | Muestra temperatura en °C. Configurable desde el archivo `config/weather.json` |
| Humedad | `#hum-widget` | Muestra porcentaje de humedad. Configurable desde `config/weather.json` |

#### 📋 Panel "Siguiente" (`#panel-siguiente`)
| Pregunta | Respuesta |
|---|---|
| 🧩 **Quién** | Panel pequeño debajo del reloj, muestra el título de la siguiente pista |
| ⚡ **Qué** | Indicador visual — muestra el título de la pista que sonará a continuación |
| ⏱️ **Cuándo** | Visible siempre. Muestra "(Vacío)" si la playlist está vacía |
| 📍 **Dónde** | Actualiza su texto cada vez que cambia la pista siguiente en la playlist |
| 💡 **Por qué** | Permite al operador saber con anticipación qué viene, para prepararse o intervenir si es necesario |
> *Atajo para forzar la siguiente pista manualmente: tecla `Q` sobre una fila seleccionada de la playlist*

---

### 3. Panel Izquierdo — Sidebar (`left-sidebar`)

El sidebar tiene 3 pestañas:

#### Pestaña "Explorador" (`#tab-btn-explorador`)
| Pregunta | Respuesta |
|---|---|
| 🧩 **Quién** | Primera pestaña del sidebar. Muestra el árbol de carpetas musicales |
| ⚡ **Qué** | Navega por las carpetas de música configuradas y permite agregar canciones a la playlist |
| ⏱️ **Cuándo** | Siempre disponible. Las carpetas se configuran en Ajustes |
| 📍 **Dónde** | El panel lateral muestra el árbol de directorios |
| 💡 **Por qué** | Permite al operador buscar y agregar música directamente desde el disco sin abrir la librería completa |

**Menú contextual de carpeta (clic derecho):**
| Opción | Qué hace |
|---|---|
| `🔀 Agregar carpeta como pista aleatoria` | Agrega la carpeta a la playlist como un ítem de "pista aleatoria" — cuando llegue su turno, reproducirá una canción al azar de esa carpeta |
| `➕ Agregar todo el contenido normal` | Agrega todas las canciones de la carpeta a la playlist en orden |
| `Establecer tipo de archivo ▶` | Submenú para asignar un tipo de archivo (Comercial, Jingle, etc.) a toda la carpeta |

**Menú contextual de archivo (clic derecho):**
| Opción | Qué hace |
|---|---|
| `➕ Agregar a la lista` | Agrega el archivo al final de la playlist activa |
| `🔊 Escucha previa` | Abre la ventana de Preview para escuchar el audio sin emitirlo al aire |
| `🎧 Editor de Pistas Avanzado` | Abre el Editor de Audio para configurar cue in/out, mezclas y transiciones |

> **IPC enviado (preview):** `open-preview`
> **IPC enviado (editor):** `open-audio-editor`

---

#### Pestaña "Eventos" (`#tab-btn-eventos`)
Gestión de eventos automáticos programados que dispara la consola.

| Elemento | ID | Descripción |
|---|---|---|
| Checkbox "Activar Eventos" | `#chk-events-master` | Activa/desactiva el disparador automático de eventos. Si está desactivado, ningún evento suena aunque llegue su hora |
| Checkbox "Solo Manual" | `#chk-events-manual` | Cuando está marcado, los eventos NO se disparan solos — requieren que el operador haga clic en "▶ Ejecutar" |
| Botón "▶ Ejecutar" | `#btn-events-exec` | Ejecuta manualmente el evento seleccionado en la lista |
| Checkbox "Proteger antes de evento" | `#chk-event-prehold` | Si una canción termina poco antes de un evento programado, el sistema espera al evento en lugar de arrancar otra pista |
| Campo de segundos de protección | `#event-prehold-seconds` | Cantidad de segundos de anticipación para activar la protección |
| Lista de eventos | `#events-list` | Muestra todos los eventos activos con su hora, nombre y estado |
| Botón "Añadir" | `#btn-events-add` | Abre el Editor de Eventos para crear un nuevo evento |
| Botón "Modificar" | `#btn-events-mod` | Abre el Editor de Eventos con el evento seleccionado para editarlo |
| Botón "Lista ▼" | `#btn-events-list` | Abre el menú contextual de gestión de la lista de eventos |

**Menú contextual de la lista de eventos:**
| Opción | Qué hace |
|---|---|
| `🗓️ Abrir Calendario Semanal` | Abre la ventana del Calendario |
| `Cargar Evento...` | Carga eventos desde un archivo `.eventolf` o `.eventoslf` |
| `Guardar Todo (Respaldo General)` | Exporta todos los eventos a un archivo de respaldo |

**Menú contextual de ítem de evento (clic derecho sobre un evento):**
| Opción | Qué hace |
|---|---|
| `▶ Ejecutar ahora` | Dispara el evento inmediatamente sin esperar su hora |
| `⛔ Ignorar este pase` | Omite el disparo del evento en el próximo horario programado (sin eliminarlo) |
| `✏️ Modificar evento` | Abre el Editor de Eventos |
| `🗑️ Eliminar evento` | Elimina el evento permanentemente |

---

#### Pestaña "FX" (`#tab-btn-fx`)
Cadena de efectos de audio aplicada a toda la señal de salida principal.

| Módulo FX | ID | Descripción |
|---|---|---|
| 🎚️ Ecualizador Master | `#fx-eq-enable` | Toggle para activar/desactivar el EQ de 8 bandas. El botón "🎛️ Abrir Panel Master" abre el modal de EQ |
| 🗜️ Compresor (AGC) | `#fx-comp-enable` | Toggle para activar/desactivar la compresión automática de ganancia. Nivela el volumen automáticamente |
| 🛑 Limitador | `#fx-limiter-enable` | Toggle para activar/desactivar el limitador. Previene saturación en picos de volumen |
| ▲ Subir módulo | `#btn-fx-up` | Mueve el módulo FX seleccionado hacia arriba en la cadena de efectos (mayor prioridad) |
| ▼ Bajar módulo | `#btn-fx-down` | Mueve el módulo FX seleccionado hacia abajo en la cadena |

> **Nota:** El orden de la cadena importa — el módulo de arriba se aplica *después* (tiene mayor prioridad final en la señal).

---

#### Panel Encoder (`#btn-open-encoder`)
| Pregunta | Respuesta |
|---|---|
| 🧩 **Quién** | Botón 📡 rojo en el extremo derecho de las pestañas del sidebar |
| ⚡ **Qué** | Abre la ventana del Encoder para transmitir por internet (streaming) |
| ⏱️ **Cuándo** | Siempre disponible |
| 📍 **Dónde** | Se abre la ventana `encoder.html` |
| 💡 **Por qué** | Acceso rápido a la configuración y control del stream desde la consola principal |
> **IPC enviado:** `open-encoder`

---

#### 📊 Centro de Estado e Incidencias (`#incident-panel`)
Panel en la parte inferior del sidebar. Muestra el estado general del sistema en tiempo real.

**Tarjetas de estado:**
| Tarjeta | ID | Posibles valores |
|---|---|---|
| Aire | `#status-air` | "En aire" (verde), "Pausa manual" (azul), "En espera" (naranja), "Detenido" (gris) |
| Eventos | `#status-events` | "Activos" (verde), "Manual" (azul), "Pausados" (gris), "Con alertas" (rojo) |
| Encoder | `#status-encoder` | "En vivo" (verde), "Reconectando" (naranja), "Conectando" (naranja), "Error" (rojo), "Desconectado" (gris) |
| Sesión | `#status-session` | "Nueva", "Restaurada", "Guardada" |

**Contador AUTO:** Muestra cuántas acciones automáticas ha tomado el sistema (guardias de aire, recuperaciones de motor, etc.)

**Botón "Ver reportes":** Abre la ventana de Reportes.
> **IPC enviado:** `open-reports-window`

---

### 4. Divisor Redimensionable (`#sidebar-resizer`)
| Pregunta | Respuesta |
|---|---|
| 🧩 **Quién** | Barra vertical entre el sidebar y la playlist |
| ⚡ **Qué** | Al arrastrar, cambia el ancho del sidebar |
| ⏱️ **Cuándo** | Siempre disponible |
| 📍 **Dónde** | El sidebar se ensancha o achica en tiempo real |
| 💡 **Por qué** | Flexibilidad para operadores con diferentes tamaños de pantalla |

---

### 5. Área Central — Controles de Reproducción

#### Barra de Controles (`controls-bar`)

| Botón | ID | Atajo | Qué hace |
|---|---|---|---|
| ▶ Play | `#btn-play` | `P` | Inicia o reanuda la reproducción de la playlist |
| ⏸ Pausa | `#btn-pause` | — | Pausa la reproducción actual sin avanzar al siguiente |
| ⏹ Stop | `#btn-stop` | `S` | Detiene la reproducción completamente |
| ⏭ Siguiente | `#btn-next` | `N` | Avanza a la siguiente canción en la playlist |
| ⏸⏹ Pausar al Final | `#btn-stop-after` | `F` | Marca la pista actual para detenerse al terminar (no avanza a la siguiente) |

**Modos de Reproducción:**
| Botón | ID | Qué activa cuando está marcado |
|---|---|---|
| 🔁 Reproducción Infinita | `#btn-mode-looplist` | Al terminar la última canción, vuelve a la primera (loop de playlist) |
| 🗑️ Eliminar al Terminar | `#btn-mode-remove` | Cada canción se elimina de la playlist cuando termina de reproducirse |
| 🔂 Repetir Canción | `#btn-mode-repeat` | La misma canción se repite indefinidamente hasta que el operador avance |

---

### 6. Pestañas de Playlist (`playlist-tabs-container`)

El sistema tiene **4 playlists independientes** (Playlist 1, 2, 3, 4). Solo una está activa al aire en cada momento.

| Elemento | Descripción |
|---|---|
| Clic en una pestaña | Cambia la vista a esa playlist (no necesariamente cambia cuál está en el aire) |
| Punto de color (•) | Aparece en la pestaña de la playlist que está actualmente AL AIRE cuando el operador está viendo otra |

---

### 7. Tabla de Playlist (`#playlist-table`)

La lista de canciones, efectos y comandos que forman el programa.

**Columnas de la tabla:**
| Columna | Descripción |
|---|---|
| Hora | La hora estimada a la que comenzará a sonar esa pista |
| Título | El nombre del archivo o pista |
| Duración | La duración total de la pista |
| Intro | Duración del segmento de INTRO (voz sobre música) |
| Outro | Punto de mezcla con la siguiente pista |

> Las columnas son **redimensionables** arrastrando los bordes de los encabezados.

**Tipos de ítem en la playlist:**

| Tipo | Icono/Color | Descripción |
|---|---|---|
| Canción normal | Color del tipo de archivo | Un archivo de audio estándar |
| Pista Aleatoria | — | Carpeta configurada — reproduce una canción al azar cuando llega su turno |
| ⏰ Locución de Hora | Verde itálica | Reproduce el audio de la hora actual desde la carpeta configurada |
| ⏹ Comando STOP | — | Al llegar a este ítem, la reproducción se detiene |
| 📝 Nota | — | Un mensaje de texto solo visible para el operador, no se reproduce |
| ⏭ Saltar a Playlist | — | Al llegar, cambia la reproducción a otra de las 4 playlists |
| 📅 Ejecutar Evento | — | Al llegar, dispara el evento del sistema configurado |
| ⏳ Temporal | Prefijo ⏳ | Marcada como temporal — se puede eliminar en bloque fácilmente |

**Interacciones con la playlist:**

| Acción | Qué hace |
|---|---|
| Doble clic en una fila | Reproduce esa canción inmediatamente |
| Clic simple | Selecciona la fila |
| Shift+Clic | Selecciona un rango de filas |
| Clic + arrastar | Reordena las filas (drag & drop interno) |
| Arrastrar archivo desde explorador | Agrega el archivo al punto de destino |
| Arrastrar carpeta desde explorador | Agrega todos los audios de la carpeta |
| Tecla `Q` sobre fila seleccionada | Marca esa fila como "Siguiente" (la que sonará después de la actual, independientemente del orden) |
| `Delete` | Elimina las filas seleccionadas |
| `Ctrl+A` | Selecciona todas las filas |
| `Ctrl+C` / `Ctrl+X` / `Ctrl+V` | Copiar / Cortar / Pegar filas |
| `↑ ↓` / `Home` / `End` | Navegar por la playlist con el teclado |
| `Shift+↑↓` | Selección de rango con teclado |

**Menú contextual de fila de playlist (clic derecho):**
| Opción | Qué hace |
|---|---|
| `🔊 Escucha previa` | Abre Preview de esa pista en el monitor |
| `Cortar / Copiar / Pegar` | Operaciones de portapapeles de filas |
| `🎧 Editor de Pistas Avanzado` | Abre el Editor de Audio |
| `🔀 Editar Transición Musical` | Abre el Editor de Transiciones para configurar el crossfade con la pista anterior |
| `🎙️ Editar Cruce con Pisador` | Abre el Editor de Jingles para configurar un jingle que suena encima de la pista |
| `Pisadores automáticos...` | Configura un pisador sencillo que inicia a los segundos indicados. Puede respetar o ignorar los pisadores del Editor Avanzado. En una pista normal se aplica solo a esa fila. En una carpeta aleatoria el operador decide si se limita a la fila o se reutiliza cada vez que agregue la misma carpeta. |
| `Editar nombre simple...` | Permite cambiar el nombre que se muestra en la playlist |
| `Establecer tipo de archivo ▶` | Submenú para cambiar el tipo (Comercial, Jingle, Station ID, etc.) |
| `⏱️ Marcar / Desmarcar Temporal` | Marca la pista como temporal |
| `🔀 Mezclar lista` | Reordena aleatoriamente todas las filas de la playlist |
| `Agregar como siguiente (Q)` | Marca esa fila para sonar a continuación |
| `🗑️ Borrar toda la lista` | Vacía completamente la playlist |
| `❌ Borrar canción actual` | Elimina solo la fila seleccionada |

---

### 8. Footer de Playlist

| Elemento | Descripción |
|---|---|
| `Duración Lista Activa` — `#txt-duracion-total` | Suma total de duración de todas las pistas en la playlist activa |
| Advertencia `⛔️ Eventos desactivados` | Aparece en rojo si el checkbox de "Activar Eventos" está desactivado |

---

### 9. CartWall Acoplado (`#right-panel-cartwall`)

Cuando la Botonera de Efectos está en modo "acoplado", aparece como un panel adicional al lado derecho de la playlist. Tiene exactamente las mismas funciones que la ventana flotante del CartWall (ver [Documento 06 — CartWall](./06_cartwall.md)), con un botón adicional:

#### ⏏️ Botón Desacoplar (`#btn-undock-cartwall`)
| Pregunta | Respuesta |
|---|---|
| 🧩 **Quién** | Botón ⏏️ en la cabecera del CartWall acoplado |
| ⚡ **Qué** | Saca el CartWall de la consola y lo convierte en una ventana flotante independiente |
| ⏱️ **Cuándo** | Solo visible cuando el CartWall está en modo acoplado |
| 📍 **Dónde** | El panel del CartWall desaparece de la consola y aparece una ventana nueva |
| 💡 **Por qué** | Flexibilidad de disposición para operadores con múltiples monitores |
> **IPC enviado:** `open-cartwall-window`

---

### 10. Modal del Ecualizador Master (`#eq-modal`)

Se abre desde la pestaña FX del sidebar → "🎛️ Abrir Panel Master".

| Elemento | Descripción |
|---|---|
| Selector de Preajuste | Lista desplegable con presets del EQ guardados |
| PRE-AMP / GAIN | Slider de -12 dB a +12 dB. Aumenta o baja el nivel antes de las bandas del EQ |
| PANEO (L/R) | Slider de -1 (todo izquierda) a +1 (todo derecha). Centro = 0. **Tiene efecto imán en el centro** — snap automático a 0 |
| MODO DE AUDIO (Mono/Estéreo) | Toggle: activo = Mono, desactivo = Estéreo |
| Bandas del EQ (8 bandas) | Sliders verticales para cada frecuencia. **Doble clic en cualquier slider = reinicia a 0** |
| 💾 Guardar nuevo | Guarda el EQ actual como un nuevo preset con nombre |
| 🗑️ Eliminar | Elimina el preset seleccionado |
| ↺ Restablecer Todo | Pone todos los sliders a 0 y el pan en el centro |
| ❌ Cancelar | Cierra sin guardar |
| 💾 Guardar Cambios | Aplica y guarda la configuración del EQ |

---

### 11. Modal del Generador de Playlists (`#rotation-modal`)
*(En desarrollo en la v1.0)*

Herramienta para generar playlists automáticas basadas en géneros y reglas de separación.

| Campo | Descripción |
|---|---|
| Patrón del reloj | Define la secuencia de tipos de contenido (ej: Música-Música-Comercial-Jingle) |
| Paleta de categorías | Botones para insertar tipos de contenido en el patrón |
| Duración objetivo | Cantidad de minutos que debe durar la playlist generada |
| Separación mínima de Artista | Mínimo de pistas entre dos canciones del mismo artista |
| Separación mínima de Título | Mínimo de pistas entre dos apariciones del mismo título |
| `Preflight` | Verifica si la biblioteca tiene suficiente contenido para cumplir el patrón |
| `Generar en playlist` | Construye la playlist y la inserta en la pestaña activa |

---

## ⌨️ Mapa Completo de Atajos de Teclado

> Los atajos NO funcionan si el cursor está dentro de un campo de texto (`INPUT` o `TEXTAREA`).

| Atajo | Acción |
|---|---|
| `P` | ▶ Play / Reanudar reproducción |
| `S` | ⏹ Stop — Detener reproducción |
| `N` | ⏭ Siguiente canción |
| `F` | ⏸⏹ Pausar al final de la pista actual |
| `Q` | Marcar fila seleccionada como "Siguiente" |
| `Delete` | Eliminar filas seleccionadas |
| `↑` / `↓` | Navegar por la playlist |
| `Home` / `End` | Ir al inicio / fin de la playlist |
| `Shift+↑↓` | Selección de rango con teclado |
| `Ctrl+N` | Limpiar playlist |
| `Ctrl+O` | Abrir playlist |
| `Ctrl+S` | Guardar playlist |
| `Ctrl+P` | Abrir Configuración General |
| `Ctrl+H` | Insertar Locución de Hora en la playlist |
| `Ctrl+A` | Seleccionar todas las filas |
| `Ctrl+C` | Copiar filas seleccionadas |
| `Ctrl+X` | Cortar filas seleccionadas |
| `Ctrl+V` | Pegar filas del portapapeles |
| `Escape` | Deseleccionar todo / Cerrar menús contextuales |
| `Alt` (al soltar) | Mostrar/ocultar la barra de menú del sistema |

---

## 📡 Mapa de Comunicación IPC

### Mensajes enviados al Backend (`ipcRenderer.send`)
| Canal | Cuándo se envía |
|---|---|
| `open-settings` | Al hacer clic en ⚙️ o `Ctrl+P` |
| `active-tab-changed` | Al cambiar de pestaña de playlist |
| `open-reports-window` | Al hacer clic en "Ver reportes" |
| `incident-sync-broadcast` | Cada vez que cambia el estado del Centro de Incidencias |
| `lib-start-analyzer-ffmpeg` | Cuando se encolan pistas para análisis automático de cue points |
| `update-metadata` | Al cambiar la pista en reproducción (actualiza `NowPlaying.txt`) |
| `open-preview` | Al abrir la escucha previa de una pista |
| `open-audio-editor` | Al abrir el Editor de Audio |
| `open-transition-editor` | Al abrir el Editor de Transiciones |
| `open-jingle-editor` | Al abrir el Editor de Jingles |
| `open-event-editor` | Al agregar o modificar un evento |
| `open-event-groups` | Al abrir el editor de Grupos de Eventos |
| `open-calendar` | Al abrir el Calendario Semanal |
| `open-encoder` | Al hacer clic en el botón 📡 |
| `open-cartwall-window` | Al desacoplar el CartWall |
| `db-save-events-full` | Cada vez que se modifica la lista de eventos |
| `emergency-stop-playback` | En caso de error crítico del motor de audio |
| `toggle-menu-bar` | Al soltar la tecla Alt |
| `confirm-app-quit` | Al cerrar la ventana (con confirmación si hay playlist) |
| `init-ffmpeg` | Al iniciar el encoder de streaming |
| `stop-encoder` | Al detener el encoder de streaming |
| `audio-chunk` | En tiempo real, enviando chunks de audio al encoder |
| `vu-levels` | En tiempo real, enviando niveles de audio para los VU Meters |
| `set-cartwall-ui-state` | Al cambiar perfil o pestaña del CartWall |
| `cartwall-play-state` | Al iniciar o detener un efecto del CartWall |
| `cartwall-progress` | En tiempo real, progreso de reproducción del CartWall |

### Mensajes invocados (`ipcRenderer.invoke` — espera respuesta)
| Canal | Qué retorna |
|---|---|
| `get-cache-dir` | Directorio de caché para formas de onda |
| `audio-engine-rust-command` | Comunicación con el motor Rust (peaks de audio, etc.) |
| `audio-build-waveform-peaks` | Peaks del audio para la forma de onda (fallback JS) |

---

## 🔮 Implicaciones para la v2.0 (Tauri/Rust)

| Elemento | Qué debe hacer Rust/Tauri |
|---|---|
| Motor de audio principal | **Ya en Rust** — `audio_engine_process.js` y `audio_engine_client.js` se reemplazarán por comandos Tauri nativos |
| Playlist y reproducción automática | El sistema de playlist (lógica de "qué suena después") ya existe en Rust como `rustPlaylistOwnerHealth` — debe ser el único responsable en v2.0 |
| IPC de ventanas | Todos los `ipcRenderer.send('open-XXX')` se convierten en `invoke('open_xxx_window')` en Tauri |
| NowPlaying.txt | Rust debe escribir este archivo al cambiar de pista |
| Encoder de streaming | Rust manejará la captura de audio y el envío al servidor Icecast/SHOUTcast |
| VU Meters | Rust emitirá eventos con niveles de audio en tiempo real vía `emit()` de Tauri |
| EQ y FX | Rust procesará la cadena de efectos en la capa de audio, no en el frontend |
| Forma de onda | Rust ya genera los peaks — el frontend solo los dibuja en el canvas |
| Atajos de teclado | Los mismos atajos se implementan en el frontend con `addEventListener('keydown')` — sin cambios |
| Sesión (session_state.json) | Rust guardará y restaurará el estado de la sesión |

---

*Documentado mediante auditoría automática de código — LF Automatizador v1.0*
*Referencia para LF Automatizador v2.0 (Tauri + Rust)*
