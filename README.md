# LF Automatizador

> "Un software diseñado por un operador de audio para operadores de audio"

![Estado](https://img.shields.io/badge/Estado-Open_Source-green)
![Plataforma](https://img.shields.io/badge/Plataforma-Windows%20%7C%20Linux-blue)

**LF Automatizador** es un software multiplataforma avanzado diseñado específicamente para **radio profesional** y **transmisión por Internet** (Web Radio / Streaming). Ofrece herramientas precisas de ruteo, programación de eventos, gestión de librerías y control de emisión de primer nivel, todo impulsado por un potente motor de audio nativo escrito en **Rust**.

---

## 🎛️ Características Destacadas

*   **Consola de Audio Virtual:** Enrutamiento avanzado (Aire/Master, Monitores, Preescucha) tratado como una mesa de mezclas física.
*   **Gestión Inteligente de Biblioteca:** Analizador automático de puntos de mezcla (Mix), Inicio/Fin y normalización de volumen mediante FFmpeg y SQLite ultra-rápido.
*   **Editores de Pistas Profesionales:** Edición avanzada de 1, 2 y 3 pistas simultáneas para lograr transiciones y *crossfades* perfectos.
*   **Automatización Total:** Calendario visual de eventos, Cartwall (botonera de efectos) y locuciones dinámicas de hora/temperatura.
*   **Encoder Integrado:** Transmisión directa hacia servidores Icecast o Shoutcast sin software externo.

---

## 🚀 Instalación y Despliegue

La instalación es sencilla gracias a los scripts automatizados que preparan el entorno Node.js y compilan las dependencias nativas automáticamente.

**Requisitos Previos:**
- [Node.js](https://nodejs.org/) (v18 LTS o superior).
- Windows: Visual Studio Build Tools y Python.
- Linux: `build-essential` y `ffmpeg` del sistema.

**Paso a paso:**
1. Clona el repositorio: `git clone https://github.com/yosoyluisfernando/lf-automatizador.git`
2. **En Windows:** Ejecuta `Instalar_Dependencias.bat`. Luego, inicia la app con `Iniciar_Automatizador.bat`.
3. **En Linux:** Da permisos de ejecución (`chmod +x *.sh`), corre `./instalar_dependencias.sh` y luego `./iniciar.sh`.

Para consultar el manual de usuario completo, ejecuta `npm run manual:dev` (actualmente en construcción).

---

## 📖 La Historia y Filosofía detrás de LF Automatizador

**LF Automatizador** no es solo un proyecto de software; es el resultado de la pasión, la resiliencia y el amor por la radio. 

Mi nombre es Luis Fernando Velásquez. Fui operador de audio durante 11 años en una emisora comunitaria en Venezuela, mi tierra natal, la cual tuve que dejar para emigrar a Perú. Desde muy niño perdí mi ojo derecho a causa de un glaucoma congénito, y en los últimos años la visión de mi ojo izquierdo ha decaído significativamente. 

Comencé este proyecto sin saber escribir una sola línea de código. Apoyándome en herramientas de Inteligencia Artificial (Gemini, Claude, Cursor, entre otras), la lupa de Windows y lectores de pantalla, trabajé desde una computadora antigua, sacrificando horas de sueño y mi propia salud visual. Tras meses de ensayo y error, logramos construir una arquitectura robusta de más de 10,000 líneas de código, logrando el inmenso hito de migrar el corazón del sistema a un motor nativo en Rust.

### ¿Por qué Código Abierto?

> *"El desarrollo de este programa comenzó desde el principio pensado para Linux, porque considero que Linux necesita más software profesional enfocado a radio. Sin embargo, en el camino me di cuenta de que también sería sumamente útil para la comunidad de Windows, por lo que decidí hacerlo multiplataforma."*

He decidido hacer **LF Automatizador** 100% de código abierto porque sé que mi salud visual no me permitirá mantenerlo solo a largo plazo. Si conservo el control total, mi pasión me impedirá detenerme, y eso perjudicará mi visión aún más. Planto esta semilla en el mundo del Open Source con la esperanza de que desarrolladores y programadores apasionados la rieguen, mejoren el código (especialmente el renderizador principal) y hagan de este software el corazón de muchas emisoras comunitarias y comerciales en el futuro. 

Todo desarrollo nuevo bajo este proyecto deberá mantenerse libre y de código abierto. *(Próximamente publicaré un video en mi canal de YouTube personal contando esta historia y mostrando el proyecto en acción).*

---

## 💬 Comunidad y Contacto

¡Únete a la familia de LF Automatizador! He creado estos espacios para que podamos conversar, reportar errores, discutir nuevas ideas y organizar el futuro desarrollo del proyecto:

- 📢 **Canal de Telegram (Noticias):** [Suscríbete al Canal](https://t.me/+XKof2wDvGVw1YTRh)
- 👥 **Grupo de Telegram (Comunidad):** [Únete al Grupo](https://t.me/+bXppwWvJvSg5YjNh)

---

## 💖 Apoyo y Donaciones

Las donaciones están destinadas exclusivamente a ayudarme a costear mis consultas médicas y los tratamientos para mi vista, los cuales no he podido mantener de forma regular desde que emigré. 

💙 **[Haz clic aquí para apoyarme a través de PayPal](https://www.paypal.com/paypalme/yosoyluisfernando)**

---

## ✒️ Licencia y Autoría

💻 **Desarrollado y Arquitecturado originalmente por Luis Fernando Velásquez.**  
⚖️ Distribuido bajo la licencia **GPL-3.0**. Todo trabajo derivado debe mantenerse libre y abierto a la comunidad.
