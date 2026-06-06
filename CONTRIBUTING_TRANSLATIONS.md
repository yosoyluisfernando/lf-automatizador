# Guía de Traducciones (i18n) - LF Automatizador

Este documento contiene las reglas y pautas para añadir o modificar traducciones en el proyecto.

## Reglas Obligatorias para Desarrollo e IA

1. **Textos Técnicos y Soporte NO se traducen:**
   - **Términos estándar:** `PGM`, `CUE`, `Master`, `Monitor`, ` Fade In`, `Fade Out`, `MIX`, `AGC`, `EQ`, `dB`, `Hz`, `FX`, `ID3`, `Encoder`, `Icecast`, `Shoutcast`, `FFmpeg`
   - **Logs e Incidencias:** El texto usado para soporte técnico (logs del sistema, visor de reportes, centro de incidencias) permanecerá en español/técnico para facilitar el soporte remoto.

2. **Paridad de Idiomas:** Al crear una nueva clave en `es.json`, DEBE crearse en `en.json`, `pt-PT.json` y `pt-BR.json`. Si no conoces la traducción exacta, copia el texto en español pero ponle el prefijo `[TODO] `.

3. **Pruebas y Cierre Forzoso (Solo Entorno Dev/IAs):**
   - Antes de dar por completado un cambio, la IA debe cerrar forzosamente el programa (`taskkill /F /IM electron.exe`).
   - Arranca el programa con `npm start`.
   - Valida visualmente que el programa no colapsa y los textos cargaron.
   - Cierra el programa nuevamente.

4. **Prohibido "Parche sobre Parche":** Si una traducción rompe el diseño o causa un error, está estrictamente prohibido amontonar parches rápidos (ej: condicionales mágicos). Se debe buscar y solucionar la raíz del problema (ej: un CSS flexbox mal implementado o una etiqueta HTML mal cerrada).

5. **Aclaración de Dudas (IAs):** Las IAs deben hacer preguntas siempre que lo consideren necesario antes de asumir cómo traducir o implementar un texto ambiguo.

## Estructura de Claves
Las claves se organizan por pantalla o componente:
- `main_window.*` (Ventana Principal)
- `settings.*` (Configuración)
- `library.*` (Librería)
- `common.*` (Botones generales: Aceptar, Cancelar)
- `errors.*` (Alertas de error)

## Añadir un nuevo idioma
1. Copia el archivo `locales/_template.json`.
2. Renómbralo con el código del idioma (ej: `fr.json`).
3. Traduce los valores, manteniendo las claves (la parte izquierda) intactas.
4. Actualiza la sección `_meta` dentro del JSON.
