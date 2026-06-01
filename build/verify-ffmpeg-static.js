'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const ffmpegPath = require('ffmpeg-static');

const EXPECTED_SHA256 = {
    'win32-x64': '04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00',
    'linux-x64': 'e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99',
};

const platformKey = `${os.platform()}-${os.arch()}`;
const expected = EXPECTED_SHA256[platformKey];
if (!expected) {
    throw new Error(`No hay SHA-256 aprobado para ffmpeg-static en ${platformKey}.`);
}
const actual = crypto.createHash('sha256').update(fs.readFileSync(ffmpegPath)).digest('hex');
if (actual !== expected) {
    throw new Error(`SHA-256 inesperado para ffmpeg-static en ${platformKey}: ${actual}`);
}
console.log(`ffmpeg-static verificado (${platformKey}): ${actual}`);
