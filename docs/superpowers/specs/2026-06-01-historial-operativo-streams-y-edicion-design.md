# Historial operativo, estabilidad de streams y edicion de archivos

Fecha: 2026-06-01

## Objetivo

Extender LF Automatizador con mejoras operativas previas a la integracion en la carpeta raiz:

1. Completar la mini ventana de pisadores automaticos con eliminacion explicita, hidratacion de ajustes y confirmacion para el segundo cero.
2. Incorporar una edicion rapida del archivo fisico y sus metadatos habituales, conectada con el Editor de Pistas Avanzado.
3. Permitir revelar archivos locales en el explorador nativo de Windows o Linux.
4. Estabilizar el arranque de streams URL mediante un prebuffer configurable por fila y un Ring Buffer proporcional en Rust.
5. Separar el reporte visible de la telemetria tecnica y persistir un historial real de reproducciones en SQLite.
6. Usar ese historial para mejorar provisionalmente la variedad de carpetas aleatorias musicales.

No se implementaran todavia reglas avanzadas de separacion musical, interfaces de configuracion global o por carpeta, ni proteccion por artista.

## 1. Mini ventana de pisadores automaticos

La mini ventana reutilizada para configurar pisadores automaticos debe cargar la configuracion efectiva del elemento seleccionado cada vez que se abra.

### Hidratacion

- Si una fila normal tiene configuracion propia, se muestran sus valores.
- Si una carpeta aleatoria tiene una regla propia de la fila, se muestran esos valores.
- Si una carpeta aleatoria no tiene regla propia pero hereda una regla persistente de esa ruta, se muestran los valores heredados.
- La interfaz debe distinguir el alcance que esta mostrando para que `Eliminar` borre exactamente esa configuracion.

### Acciones

Los botones se muestran de izquierda a derecha:

1. `Eliminar`
2. `Cancelar`
3. `Guardar`

`Eliminar` actua segun el alcance visible:

- Fila normal: elimina solo la regla de esa fila.
- Carpeta aleatoria con alcance de fila: elimina solo la regla de esa fila.
- Carpeta aleatoria con regla persistente para la ruta: elimina la regla persistente recordada para esa carpeta y la regla aplicada a la fila actual.

### Segundo cero

El segundo `0` sigue siendo un valor valido. Antes de guardarlo se muestra una advertencia:

> El pisador se ejecutara en el segundo 0. Desea guardar esta configuracion?

- `Si`: guarda y cierra.
- `No`: no guarda y mantiene abierta la ventana.

## 2. Edicion rapida de archivo y metadatos

La opcion contextual se llamara `Editar archivo y metadatos...`.

Abrira una ventana rapida con estos campos:

- Nombre fisico del archivo
- Titulo
- Artista
- Artistas invitados
- Album
- Año
- Genero

La extension del archivo se mostrara bloqueada. El usuario podra cambiar el nombre base, pero no alterar la extension.

El campo `Remix` permanecera exclusivamente en el Editor de Pistas Avanzado. La ventana rapida y el editor avanzado comparten la misma informacion SQLite, por lo que los cambios de metadatos deben verse en ambas superficies.

### Resolucion del archivo fisico

- Pista local normal: se edita su ruta fisica.
- Carpeta aleatoria actualmente al aire: se edita el archivo fisico exacto resuelto para esa reproduccion.
- Carpeta aleatoria que no esta al aire: la opcion se deshabilita porque no existe un archivo fisico resuelto.
- URL, nota o comando: la opcion se deshabilita.

### Renombre fisico

- Si la pista no esta al aire, el renombre se aplica inmediatamente.
- Si la pista esta al aire, los metadatos se guardan inmediatamente y el renombre fisico queda pendiente hasta que finalice, se detenga o se salte esa pista.
- Mientras exista un renombre pendiente se muestra el aviso: `El archivo se renombrara al finalizar la pista`.
- Si la aplicacion se cierra antes de aplicar el renombre pendiente, el archivo conserva su nombre anterior. El renombre pendiente no se persiste entre reinicios.
- Si ya existe un archivo con el nombre de destino, se cancela la operacion y se informa claramente al usuario.
- No se sobrescriben archivos y no se generan sufijos automaticos.

Cuando el renombre fisico se complete, SQLite debe migrar la ruta anterior a la nueva y actualizar las referencias conocidas de playlists, metadatos, marcadores y asociaciones. La operacion debe ser transaccional: un fallo conserva la ruta anterior.

## 3. Mostrar en carpeta

Se agregara la opcion contextual `Mostrar en carpeta` inmediatamente debajo de `Editar archivo y metadatos...`.

Debe usar el explorador nativo del sistema operativo y funcionar en Windows y Linux.

### Playlist principal

- Pista local normal: revela su archivo.
- Carpeta aleatoria actualmente al aire: revela el archivo fisico exacto resuelto.
- Carpeta aleatoria que no esta al aire: opcion deshabilitada.
- URL, nota o comando: opcion deshabilitada.

### Reportes

Una entrada de historial de reproduccion debe admitir clic derecho y ofrecer `Mostrar en carpeta` cuando conserve una ruta fisica valida.

La opcion aparecera en:

- Panel compacto de incidencias.
- Ventana completa de Reportes.

## 4. Historial persistente de reproduccion

SQLite almacenara cada reproduccion valida como un evento individual.

Cada evento debe conservar como minimo:

- Ruta fisica exacta
- Tipo de archivo
- Fecha y hora
- Duracion reproducida
- Datos descriptivos suficientes para mostrar el historial

La memoria interna conserva `30 dias` por defecto. El usuario podra seleccionar una retencion entre `1` y `366 dias`.

### Configuracion por tipo de archivo

En Tipos de Archivo se mostraran por separado:

- `Incluir en Reportes de Emision`
- `Guardar en historial de reproduccion`
- Umbral minimo para considerar una reproduccion valida, entre `1` y `10 segundos`

Valores iniciales:

| Tipo | Guardar historial | Umbral |
| --- | --- | --- |
| Musica | Si | 10 segundos |
| Comerciales | Si | 1 segundo |
| Identificaciones de emisora | Si | 1 segundo |
| Locuciones | No | 1 segundo interno |
| Tipo personalizado nuevo | No | 10 segundos |

Solo los eventos que superen el umbral configurado se guardan en el historial real.

## 5. Seleccion provisional para carpetas aleatorias

La mejora provisional de aleatoriedad se aplica solo a carpetas de Musica.

Al elegir una pista:

1. El automatizador consulta el historial SQLite.
2. Excluye los archivos reproducidos durante las ultimas `24 horas`.
3. Selecciona aleatoriamente entre los candidatos restantes.
4. Si todos los archivos quedaron excluidos, reinicia el ciclo provisional de seleccion de esa carpeta y elige nuevamente sin detener la programacion.
5. La reproduccion elegida se registra normalmente cuando supera su umbral.

Reiniciar el ciclo provisional no borra el historial SQLite. Solo evita que el filtro temporal detenga la programacion.

Las futuras reglas globales y por carpeta se implementaran en otra etapa. Cuando existan, la configuracion por carpeta tendra prioridad sobre la global y aplicara unicamente a Musica.

## 6. Reporte visible y telemetria tecnica

El Reporte de Incidencias visible y el registro tecnico tendran responsabilidades separadas.

### Reporte visible

Solo mostrara:

- Errores reales y relevantes
- Estados relevantes del encoder
- Historial de reproduccion

No mostrara:

- Carga rutinaria de pistas
- Calculos internos de crossfade
- Clics
- Cambios rutinarios de botones
- Warmups
- Otros eventos de depuracion interna

El reporte visible persiste entre reinicios. Su retencion inicial es `24 horas`.

El usuario podra configurar:

- Una cantidad
- Una unidad exclusiva: `Horas` o `Dias`
- Si el reporte se conserva o se limpia al abrir la aplicacion

La configuracion predeterminada conserva el reporte durante `24 horas` y no lo limpia al abrir.

### Telemetria tecnica

`ERROR_ANALYZER_LOG.txt` conservara el detalle tecnico necesario para diagnostico.

La limpieza sera automatica y mantendra una ventana movil de `7 dias`: se eliminan unicamente las lineas mas antiguas, sin vaciar de golpe el archivo completo.

## 7. Streaming por URL

Cada fila URL tendra un valor propio de prebuffer configurable desde su ventana.

### Interfaz

- Rango: `1` a `15 segundos`
- Valor inicial: `5 segundos`
- Advertencia visible: aumentar el prebuffer mejora la estabilidad, pero demora el inicio

### Node y Rust

- Node debe esperar el prebuffer configurado para esa fila antes de iniciar el stream.
- El limite de acumulacion de Node debe admitir el maximo configurable con margen operativo.
- El comando enviado al motor Rust debe incluir la capacidad requerida.
- Rust debe dimensionar el Ring Buffer proporcionalmente al prebuffer seleccionado para evitar desbordamientos o perdidas al comenzar.

Se agregaran pruebas de regresion para:

- Valor inicial
- Limites minimo y maximo
- Persistencia por fila URL
- Propagacion entre interfaz, Node y Rust
- Dimensionado proporcional del Ring Buffer

## 8. Compatibilidad y entrega

- Las rutas de carpetas aleatorias y archivos deben manejarse como rutas del sistema, sin depender de prefijos exclusivos de Windows.
- `Mostrar en carpeta` debe funcionar en Windows y Linux.
- La base SQLite existente debe migrar sin romper datos anteriores.
- La entrega final se copiara a la carpeta raiz del proyecto.
- Se compilara una version de prueba sin publicar un release.

## 9. Verificacion esperada

La implementacion se guiara por pruebas automatizadas enfocadas y una verificacion manual final:

1. Pruebas de mini ventana e hidratacion de reglas.
2. Pruebas de confirmacion del segundo cero.
3. Pruebas del historial SQLite, retencion y umbrales.
4. Pruebas de seleccion aleatoria musical con reinicio provisional.
5. Pruebas de resolucion de archivo fisico y migracion transaccional de rutas.
6. Pruebas de filtrado del reporte visible y limpieza movil del log tecnico.
7. Pruebas de prebuffer configurable y dimensionado Rust.
8. Compilacion de prueba sin publicacion.

