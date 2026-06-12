## 🚀 Novedades y Mejoras en la versión 0.9.16

### ⚡ Rendimiento (discos mecánicos y bibliotecas grandes)
* **Buscador sin congelamientos:** la búsqueda (interfaz principal y Biblioteca) ya no se ejecuta en el hilo de la interfaz: corre en un hilo de trabajo dedicado con índice precalculado. La ventana permanece fluida sin importar el tamaño de la biblioteca.
* **Carga masiva fuera del proceso principal:** las consultas de pistas en lote se movieron a un worker; se acabaron los congelamientos globales al abrir la Biblioteca y los falsos "Timeout esperando respuesta RustAudio" que reiniciaban el motor de audio.
* **Fin del "disco rayado":** el guardián de reproducción ahora espera cada vez más entre reintentos y, si la pista no avanza tras 3 intentos, salta a la siguiente en lugar de repetir el mismo segundo en bucle.

### 🔄 Actualización del índice musical
* El botón ↻ refresca primero el explorador de archivos y luego sincroniza el índice, mostrando el **porcentaje de avance** en el cuadro de estado.
* Al abrir el software, el cuadro de estado informa la situación del índice (pistas, pendientes, última sincronización) **sin ejecutar ningún análisis automático**.

### 🔊 Motor de audio inmune a saturación de disco
* **Fin del "disco rayado" cuando el sistema está cargado:** cada pista se precarga completa a memoria al cargarse; una vez al aire, el antivirus o Windows Update pueden saturar el disco sin que el audio se entere (verificado: con el disco al 100%, la reproducción se mantiene perfecta donde antes había bucles de 1–3 segundos).
* **Prioridad de audio profesional:** el hilo de render se registra como tiempo real ante el sistema (MMCSS "Pro Audio" en Windows 10/11, RtKit en Linux) y el motor corre con prioridad elevada de proceso. Sin requerir administrador.

### 🛠️ Estabilidad e instalación
* Corregido el error "A JavaScript error occurred in the main process (Object has been destroyed)" al cerrar ventanas mientras el analizador trabajaba.
* **Ya no se necesita ejecutar el programa como administrador:** el asistente de primer inicio pide permisos (UAC) únicamente para instalar el Visual C++ Redistributable, como debe ser.
* La guía de primer uso ahora sí se incluye en los instaladores generados por GitHub, y el paquete ya no arrastra documentación interna del desarrollador.
* El reporte de diagnóstico del motor de audio ahora se guarda correctamente en la versión instalada (antes se perdía en silencio).

## 🚀 Novedades y Mejoras en la versión 0.9.15

### ✨ Nuevas Funciones Principales
* **Nuevo Generador Automático de Playlist:** Se diseñó y construyó desde cero una ventana independiente dedicada exclusivamente a armar playlists automáticas basadas en patrones de reloj.
* **Organización Intuitiva:** El nuevo generador permite armar tu programación simplemente arrastrando y soltando carpetas. Su interfaz fue pulida para que reorganizar el orden (drag-and-drop) sea fluido y preciso.
* **Accesos Directos Conectados:** El Generador de Playlist ahora se sincroniza en tiempo real con el *Gestor de Tipos de Archivo*, mostrando tus carpetas personalizadas (Pisadores, etc.) con sus colores listos para usarse.

### 🌐 Internacionalización y Personalización
* **Soporte Multi-idioma:** Se inició la traducción parcial del software para dar soporte a nuevos idiomas, incluyendo **Inglés** y **Portugués**.
* **Playlists Personalizables:** Ahora tienes total libertad para renombrar, reordenar y restablecer las pestañas principales de reproducción (Playlist 1, 2, 3, 4) según las necesidades de tu emisora.

### ⚡ Rendimiento y Estabilidad
* **Optimización de Carga de Archivos:** Se cambió el método de lectura de carpetas pesadas de modo síncrono a asíncrono. Ya no congelará ni pondrá lento el programa al elegir canciones aleatorias, mejorando drásticamente la fluidez general y previniendo "bucles" de audio.
* **Arranque Seguro con Windows:** Se implementó un sistema de auto-recuperación con reintentos. Esto soluciona el error de la "pantalla en blanco" que ocurría a veces cuando el software arrancaba automáticamente junto con el encendido de la computadora.

### 🐛 Corrección de Errores (Bug Fixes) y Ajustes
* **Cola de Eventos Inteligente:** Se corrigió un fallo donde los eventos automáticos sonaban al instante o en la pestaña equivocada. Además, ahora el sistema organiza la fila de espera inteligentemente, respetando primero la **prioridad** del evento (Crítico/Alto) y luego su **orden de llegada**.
* **Doble Clic Seguro ("Arrancar o Encolar"):** El botón de doble clic ahora escucha directamente al motor de audio. Si hay música de fondo y cambias de playlist o limpias la lista, el doble clic no interrumpirá el audio de golpe, sino que lo encolará respetuosamente para que suene después.
* **Inserción de Carpetas:** Solucionado el problema que impedía agregar música o carpetas a tu vista actual si tenías una pista seleccionada en otra playlist diferente.
* **Módulo de Comerciales:** Se reubicó la opción en el editor de eventos y se le añadió la etiqueta de **"Experimental"**, ya que aún se encuentra en una fase de construcción básica y no es funcional.
