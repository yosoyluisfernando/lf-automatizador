const i18n = require('./i18n');

/**
 * Muestra una alerta estándar traducida.
 * @param {string} key - La clave de traducción (e.g. 'alerts.invalid_origin')
 * @param {object} params - Variables para interpolar en el texto
 */
function showAlert(key, params = null) {
    const message = i18n.t(key, params);
    // Fallback: si no encuentra traducción, asume que le pasaron el texto crudo temporalmente.
    const finalMessage = message.startsWith('alerts.') ? key : message;
    window.alert(finalMessage);
}

/**
 * Muestra un diálogo de confirmación traducido.
 * @param {string} key - La clave de traducción (e.g. 'confirms.delete_profile')
 * @param {object} params - Variables para interpolar en el texto
 * @returns {boolean} - True si el usuario aceptó, false en caso contrario
 */
function showConfirm(key, params = null) {
    const message = i18n.t(key, params);
    const finalMessage = message.startsWith('confirms.') ? key : message;
    return window.confirm(finalMessage);
}

module.exports = {
    showAlert,
    showConfirm
};
