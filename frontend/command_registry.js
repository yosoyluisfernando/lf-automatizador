const COMMAND_CATEGORIES = {
    REPRODUCCION: 'Reproducción',
    HERRAMIENTAS: 'Herramientas',
    INSERTAR:     'Insertar en Playlist',
    PISADORES:    'Pisadores en directo'
};

const COMMANDS = [
    // ── Reproducción ─────────────────────────────────────────────────────────
    { id: 'playlist.play',           label: 'Reproducir / Reanudar',           category: COMMAND_CATEGORIES.REPRODUCCION, mandatory: true,  defaultKey: 'P' },
    { id: 'playlist.stop',           label: 'Detener todo',                    category: COMMAND_CATEGORIES.REPRODUCCION, mandatory: true,  defaultKey: 'S' },
    { id: 'playlist.next',           label: 'Saltar a siguiente',              category: COMMAND_CATEGORIES.REPRODUCCION, mandatory: true,  defaultKey: 'N' },
    { id: 'playlist.set_next',       label: 'Marcar como siguiente',           category: COMMAND_CATEGORIES.REPRODUCCION, mandatory: true,  defaultKey: 'Q' },
    { id: 'playlist.stop_after',     label: 'Activar / Desactivar Stop-After', category: COMMAND_CATEGORIES.REPRODUCCION, mandatory: true,  defaultKey: 'F' },
    { id: 'playlist.delete_selected',label: 'Eliminar seleccionadas',          category: COMMAND_CATEGORIES.REPRODUCCION, mandatory: true,  defaultKey: 'Delete' },
    { id: 'playlist.clear_played',   label: 'Limpiar pistas reproducidas',     category: COMMAND_CATEGORIES.REPRODUCCION, mandatory: false, defaultKey: null },
    { id: 'playlist.check_links',    label: 'Comprobar enlaces rotos',         category: COMMAND_CATEGORIES.REPRODUCCION, mandatory: false, defaultKey: null },
    { id: 'playlist.toggle_temp',    label: 'Marcar / Desmarcar temporal',     category: COMMAND_CATEGORIES.REPRODUCCION, mandatory: false, defaultKey: 'Ctrl+T' },
    { id: 'playlist.shuffle',        label: 'Mezclar lista aleatoriamente',    category: COMMAND_CATEGORIES.REPRODUCCION, mandatory: false, defaultKey: null },
    { id: 'playlist.clear',          label: 'Vaciar toda la lista',            category: COMMAND_CATEGORIES.REPRODUCCION, mandatory: false, defaultKey: null },
    { id: 'playlist.loop_mode',      label: 'Activar modo bucle',              category: COMMAND_CATEGORIES.REPRODUCCION, mandatory: false, defaultKey: null },
    { id: 'playlist.repeat_mode',    label: 'Activar repetición de pista',     category: COMMAND_CATEGORIES.REPRODUCCION, mandatory: false, defaultKey: null },
    { id: 'playlist.remove_mode',    label: 'Activar quitar reproducidas',     category: COMMAND_CATEGORIES.REPRODUCCION, mandatory: false, defaultKey: null },
    // ── Herramientas ─────────────────────────────────────────────────────────
    { id: 'app.open_settings',       label: 'Configuración General',           category: COMMAND_CATEGORIES.HERRAMIENTAS, mandatory: false, defaultKey: 'Ctrl+P' },
    { id: 'app.open_library',        label: 'Biblioteca de Música',            category: COMMAND_CATEGORIES.HERRAMIENTAS, mandatory: false, defaultKey: 'Ctrl+B' },
    { id: 'app.open_encoder',        label: 'Abrir Encoder / Emisor',          category: COMMAND_CATEGORIES.HERRAMIENTAS, mandatory: false, defaultKey: null },
    { id: 'app.open_catalog',        label: 'Catálogo de Artistas',            category: COMMAND_CATEGORIES.HERRAMIENTAS, mandatory: false, defaultKey: 'Ctrl+Shift+A' },
    { id: 'app.open_genre_editor',   label: 'Editor de Géneros',               category: COMMAND_CATEGORIES.HERRAMIENTAS, mandatory: false, defaultKey: 'Ctrl+Shift+G' },
    { id: 'app.open_commercial_mgr', label: 'Gestor de Comerciales',           category: COMMAND_CATEGORIES.HERRAMIENTAS, mandatory: false, defaultKey: 'Ctrl+Shift+C' },
    { id: 'app.open_event_editor',   label: 'Gestor de Eventos',               category: COMMAND_CATEGORIES.HERRAMIENTAS, mandatory: false, defaultKey: null },
    { id: 'app.open_calendar',       label: 'Calendario Semanal',              category: COMMAND_CATEGORIES.HERRAMIENTAS, mandatory: false, defaultKey: null },
    { id: 'app.open_rotation',       label: 'Generador de Playlist',           category: COMMAND_CATEGORIES.HERRAMIENTAS, mandatory: false, defaultKey: null },
    { id: 'app.toggle_menu_bar',     label: 'Mostrar / Ocultar Barra de Menú', category: COMMAND_CATEGORIES.HERRAMIENTAS, mandatory: false, defaultKey: null },
    // ── Insertar en Playlist ──────────────────────────────────────────────────
    { id: 'insert.time_locution',    label: 'Insertar Locución de Hora',       category: COMMAND_CATEGORIES.INSERTAR,    mandatory: false, defaultKey: 'Ctrl+H' },
    { id: 'insert.temperature',      label: 'Insertar Temperatura en Playlist', category: COMMAND_CATEGORIES.INSERTAR,    mandatory: false, defaultKey: null },
    { id: 'insert.humidity',         label: 'Insertar Humedad en Playlist',     category: COMMAND_CATEGORIES.INSERTAR,    mandatory: false, defaultKey: null },
    // ── Pisadores en directo ───────────────────────────────────────────────────
    { id: 'overlay.time',            label: 'Lanzar hora como pisador',         category: COMMAND_CATEGORIES.PISADORES,  mandatory: false, defaultKey: 'H' },
    { id: 'overlay.temperature',     label: 'Lanzar temperatura como pisador',  category: COMMAND_CATEGORIES.PISADORES,  mandatory: false, defaultKey: null },
    { id: 'overlay.humidity',        label: 'Lanzar humedad como pisador',      category: COMMAND_CATEGORIES.PISADORES,  mandatory: false, defaultKey: null },
    { id: 'insert.stop_marker',      label: 'Insertar marcador de Stop',       category: COMMAND_CATEGORIES.INSERTAR,    mandatory: false, defaultKey: null },
    { id: 'insert.note',             label: 'Insertar Nota',                   category: COMMAND_CATEGORIES.INSERTAR,    mandatory: false, defaultKey: null },
    { id: 'insert.open_playlist',    label: 'Abrir archivo de Playlist',       category: COMMAND_CATEGORIES.INSERTAR,    mandatory: false, defaultKey: 'Ctrl+O' },
    { id: 'insert.save_playlist',    label: 'Guardar Playlist',                category: COMMAND_CATEGORIES.INSERTAR,    mandatory: false, defaultKey: 'Ctrl+S' },
    { id: 'insert.clear_playlist',   label: 'Limpiar Playlist',                category: COMMAND_CATEGORIES.INSERTAR,    mandatory: false, defaultKey: 'Ctrl+N' },
];

// Mapa { actionId → keyCombo } con los valores por defecto de fábrica
const DEFAULT_SHORTCUTS = Object.fromEntries(
    COMMANDS.filter(c => c.defaultKey).map(c => [c.id, c.defaultKey])
);

// Set con los IDs de acciones que siempre deben tener una tecla asignada
const MANDATORY_ACTIONS = new Set(COMMANDS.filter(c => c.mandatory).map(c => c.id));

// Teclas que NUNCA pueden ser asignadas a ninguna acción
const ALWAYS_RESERVED = new Set(['Escape', 'Enter', 'Tab', 'Alt+F4']);

module.exports = { COMMANDS, DEFAULT_SHORTCUTS, MANDATORY_ACTIONS, COMMAND_CATEGORIES, ALWAYS_RESERVED };
