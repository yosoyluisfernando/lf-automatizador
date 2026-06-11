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
