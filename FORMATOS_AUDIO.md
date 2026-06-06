# 🎵 Formatos de audio soportados — LF Automatizador

El motor de audio de LF Automatizador es **nativo en Rust** (basado en
[Symphonia](https://github.com/pdeljanov/Symphonia), código abierto). Por ser
un proyecto de **código abierto que se compila y distribuye**, solo incorporamos
formatos cuya licencia permite compilarlos y redistribuirlos sin restricciones
de propiedad intelectual.

## ✅ Formatos que reproduce de forma nativa

| Formato | Extensión | Notas |
|---|---|---|
| **MP3** | `.mp3` | Patentes vencidas (2017), libre. |
| **WAV / PCM** | `.wav` | Sin compresión, sin patentes. |
| **FLAC** | `.flac` | Sin pérdida, licencia BSD. |
| **OGG Vorbis** | `.ogg` | Formato abierto. |
| **AAC / M4A** | `.m4a`, `.aac` | Vía componentes estándar. |
| **ALAC (Apple Lossless)** | `.m4a` | Apache-2.0, libre de regalías. |
| **AIFF / AIFF-C** | `.aiff`, `.aif` | PCM estándar de Apple, sin patentes. |
| **MPEG Audio Layer II** | `.mp2` | Usado en broadcast/DAB. Patentes vencidas. |
| **CAF (Core Audio Format)** | `.caf` | Contenedor Apple (reproducible, no catalogado por defecto). |
| **ADPCM** | dentro de `.wav` | IMA / Microsoft ADPCM. |

## ⚠️ Limitaciones conocidas

### 💿 CD de audio
- **Requiere hardware:** una unidad lectora de CD/DVD físicamente conectada.
- **No es un archivo:** el contenido de un CD de audio (CDDA) debe **extraerse**
  pista por pista antes de poder usarse en la programación.
- **Es más lento:** la lectura desde una unidad óptica es considerablemente más
  lenta que desde el disco duro, y la extracción puede tardar varios segundos
  por pista. No es apropiado para reproducción en directo "al vuelo".
- **Estado:** previsto como mejora futura; hoy no está implementado.

### 🚫 Formatos NO soportados (y por qué)

| Formato | Motivo |
|---|---|
| **OPUS** | Royalty-free, pero el motor Symphonia **aún no incluye** un decodificador. Requeriría la librería en C `libopus` más código propio de integración. Previsto para una fase futura (vía FFmpeg o binding nativo). **No es un problema de licencia, sino técnico.** |
| **WMA** | Formato **propietario de Microsoft**. No existe decodificador en Symphonia y **no contamos con licencia** para incorporarlo. No se incluirá. |
| **DSD (DSF/DFF)** | Sin decodificador disponible en el motor. Formato de muy alta resolución (SACD), de nicho. Requeriría desarrollo específico y conversión a PCM. |
| **AAC+ (HE-AAC)** | Se reproduce el núcleo (AAC-LC); las extensiones SBR/PS pueden no decodificarse completamente. |

---

> **Resumen para usuarios:** LF Automatizador reproduce de forma libre y legal
> los formatos más usados en radiodifusión (MP3, WAV, FLAC, OGG, AAC/M4A, ALAC,
> AIFF y MP2). **WMA** se omite deliberadamente por ser propietario; **Opus**,
> **DSD** y **CD de audio** están contemplados como mejoras futuras (Opus por
> trabajo técnico pendiente, CD por necesitar hardware y ser más lento).
