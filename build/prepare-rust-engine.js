'use strict';

const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const rustDir = path.join(rootDir, 'audio-engine-rust');
const ext = process.platform === 'win32' ? '.exe' : '';
const fileName = `lf-audio-engine${ext}`;
const source = path.join(rustDir, 'target', 'release', fileName);
const destinationDir = path.join(rootDir, 'bin');
const destination = path.join(destinationDir, fileName);

const result = cp.spawnSync('cargo', ['build', '--release'], {
    cwd: rustDir,
    stdio: 'inherit',
});
if (result.error || result.status !== 0) {
    console.error(`No se pudo compilar ${fileName}: ${result.error?.message || `cargo exit ${result.status}`}`);
    process.exit(result.status || 1);
}

fs.mkdirSync(destinationDir, { recursive: true });
fs.copyFileSync(source, destination);
if (process.platform !== 'win32') fs.chmodSync(destination, 0o755);
console.log(`Motor Rust listo para empaquetar: ${destination}`);
