// frontend/i18n.js — Sistema de internacionalización ligero para LF Automatizador
// Sin dependencias externas.
const fs = require('fs');
const path = require('path');

// Resolver la ruta correcta a la carpeta 'locales'
const isPackaged = process.defaultApp !== true && !process.argv[0].endsWith('electron') && !process.argv[0].endsWith('electron.exe');
let LOCALES_DIR;
if (isPackaged) {
    LOCALES_DIR = path.join(process.resourcesPath, 'locales');
} else {
    LOCALES_DIR = path.join(__dirname, '..', 'locales');
}

const FALLBACK_LOCALE = 'es';
let currentLocale = FALLBACK_LOCALE;
let translations = {};
let fallbackData = {};

function loadLocaleFile(locale) {
    const filePath = path.join(LOCALES_DIR, `${locale}.json`);
    try {
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        }
    } catch (err) {
        console.warn(`[i18n] Error loading ${locale}.json:`, err.message);
    }
    return null;
}

function init(preferredLocale) {
    fallbackData = loadLocaleFile(FALLBACK_LOCALE) || {};
    translations[FALLBACK_LOCALE] = fallbackData;
    
    if (preferredLocale && preferredLocale !== FALLBACK_LOCALE) {
        const data = loadLocaleFile(preferredLocale);
        if (data) {
            translations[preferredLocale] = data;
            currentLocale = preferredLocale;
        }
    }
}

function t(key, params) {
    const value = resolve(key, translations[currentLocale])
                || resolve(key, fallbackData)
                || key;
    
    if (!params) return value;
    return value.replace(/\{(\w+)\}/g, (_, k) => 
        params[k] !== undefined ? params[k] : `{${k}}`
    );
}

function resolve(key, data) {
    if (!data || !key) return null;
    const parts = key.split('.');
    let current = data;
    for (const part of parts) {
        if (current == null || typeof current !== 'object') return null;
        current = current[part];
    }
    return typeof current === 'string' ? current : null;
}

function setLocale(locale) {
    if (!locale) return;
    if (!translations[locale]) {
        const data = loadLocaleFile(locale);
        if (!data) return;
        translations[locale] = data;
    }
    currentLocale = locale;
}

function getLocale() { return currentLocale; }

function getAvailableLocales() {
    try {
        if (!fs.existsSync(LOCALES_DIR)) return [FALLBACK_LOCALE];
        return fs.readdirSync(LOCALES_DIR)
            .filter(f => f.endsWith('.json') && !f.startsWith('_'))
            .map(f => f.replace('.json', ''));
    } catch (err) { return [FALLBACK_LOCALE]; }
}

function applyToDOM(root = document) {
    root.querySelectorAll('[data-i18n]').forEach(el => {
        const rawValues = el.dataset.i18n.split(';');
        rawValues.forEach(rawValue => {
            const val = rawValue.trim();
            if (!val) return;
            
            let key = val;
            let attr = el.dataset.i18nAttr; // soporte legacy
            
            // Parsear prefijo [atributo]clave
            const match = val.match(/^\[([^\]]+)\](.*)$/);
            if (match) {
                attr = match[1];
                key = match[2];
            }
            
            const translated = t(key);
            if (translated === key) return; // Si no se encuentra traducción
            
            if (attr) {
                if (attr === 'html') el.innerHTML = translated;
                else if (attr === 'text') el.innerText = translated;
                else if (attr === 'value') el.value = translated;
                else el.setAttribute(attr, translated);
            } else {
                el.innerHTML = translated;
            }
        });
    });
}

module.exports = { init, t, setLocale, getLocale, getAvailableLocales, applyToDOM };
