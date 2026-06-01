'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { version } = require('../package.json');

const platform = String(process.argv[2] || '').trim();
if (!/^[a-z0-9_-]+$/i.test(platform)) throw new Error('Plataforma invalida para SHA256SUMS.');

const distDir = path.join(__dirname, '..', 'dist');
const artifacts = fs.readdirSync(distDir)
    .filter(name => /\.(?:exe|deb|AppImage)$/i.test(name))
    .filter(name => name.includes(`-${version}-`))
    .sort();
if (!artifacts.length) throw new Error('No hay artefactos de instalacion para calcular SHA-256.');

const lines = artifacts.map(name => {
    const bytes = fs.readFileSync(path.join(distDir, name));
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    return `${sha256}  ${name}`;
});
const outputPath = path.join(distDir, `SHA256SUMS-${platform}.txt`);
fs.writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
console.log(`SHA-256 generado: ${outputPath}`);
