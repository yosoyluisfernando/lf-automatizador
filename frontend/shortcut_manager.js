const { ALWAYS_RESERVED } = require('./command_registry');

/**
 * Construye la cadena de combinación a partir de un KeyboardEvent.
 * Ej: Ctrl+Shift+P, Delete, Alt+F4
 * Devuelve null si la tecla es solo un modificador.
 */
function buildComboString(e) {
    const parts = [];
    if (e.ctrlKey)  parts.push('Ctrl');
    if (e.altKey)   parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return null;
    parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
    return parts.join('+') || null;
}

/**
 * ShortcutManager — despacha acciones a partir de pulsaciones de tecla.
 *
 * Uso en render.js:
 *   const manager = new ShortcutManager();
 *   manager.loadKeyMap({ 'playlist.play': 'P', ... });
 *   manager.registerHandlers({ 'playlist.play': () => resumeCurrentPlayback(), ... });
 */
class ShortcutManager {
    constructor() {
        this._keyToAction = {};   // { 'Ctrl+P': 'app.open_settings', ... }
        this._handlers    = {};   // { 'playlist.play': fn, ... }
        this._enabled     = true;
        this._boundKeydown = this._onKeydown.bind(this);
        window.addEventListener('keydown', this._boundKeydown, true);
    }

    /**
     * Recarga el mapa de atajos sin re-registrar el listener.
     * shortcutsObj: { actionId: keyCombo, ... }
     */
    loadKeyMap(shortcutsObj) {
        this._keyToAction = {};
        for (const [actionId, keyCombo] of Object.entries(shortcutsObj || {})) {
            if (keyCombo && typeof keyCombo === 'string') {
                this._keyToAction[keyCombo] = actionId;
            }
        }
    }

    /** Registra el mapa de handlers { actionId → función }. */
    registerHandlers(handlersMap) {
        this._handlers = handlersMap || {};
    }

    /** Ejecuta el handler de una acción por su ID. */
    dispatch(actionId) {
        const fn = this._handlers[actionId];
        if (typeof fn === 'function') fn();
    }

    /** Activa o desactiva la intercepción de teclas (útil en modales). */
    setEnabled(enabled) {
        this._enabled = !!enabled;
    }

    /**
     * Registra un fallback que se llama cuando la tecla NO está en el mapa general.
     * fn(combo, event) → true si fue manejada (se llama preventDefault), false si no.
     * Usado para atajos de la botonera en modo acoplado.
     */
    setCartwallFallback(fn) {
        this._cartwallFallback = fn;
    }

    /** Elimina el listener. Llamar al destruir la ventana. */
    destroy() {
        window.removeEventListener('keydown', this._boundKeydown, true);
    }

    _onKeydown(e) {
        if (!this._enabled) return;

        // Escape, Enter y Tab nunca son interceptados
        if (ALWAYS_RESERVED.has(e.key)) return;

        // Teclas sin modificador no se interceptan si hay un campo de texto enfocado
        const tag = document.activeElement?.tagName;
        const hasModifier = e.ctrlKey || e.altKey || e.metaKey;
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) && !hasModifier) return;

        const combo = buildComboString(e);
        if (!combo) return;

        const actionId = this._keyToAction[combo];
        if (!actionId) {
            if (this._cartwallFallback) {
                const handled = this._cartwallFallback(combo, e);
                if (handled) { e.preventDefault(); e.stopPropagation(); }
            }
            return;
        }

        e.preventDefault();
        e.stopPropagation();
        this.dispatch(actionId);
    }
}

module.exports = { ShortcutManager, buildComboString };
