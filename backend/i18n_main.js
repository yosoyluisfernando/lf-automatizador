// backend/i18n_main.js — Módulo i18n para el proceso main de Electron
const fs = require('fs');
const path = require('path');

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
        console.warn(`[i18n_main] Error loading ${locale}.json:`, err.message);
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

module.exports = { init, t, setLocale, getLocale };
