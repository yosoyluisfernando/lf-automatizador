'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ENGINE = path.resolve(__dirname, '..', 'bin', 'lf-audio-engine.exe');
const REC_DIR = path.join(os.tmpdir(), 'lf-recorder-lab-' + Date.now());

let engine = null;
let buffer = '';
const responses = [];

function send(obj) {
    const line = JSON.stringify(obj);
    engine.stdin.write(line + '\n');
}

function waitFor(predicate, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
        const check = () => {
            const idx = responses.findIndex(predicate);
            if (idx >= 0) return resolve(responses.splice(idx, 1)[0]);
            if (Date.now() - start > timeoutMs) {
                return reject(new Error(`Timeout esperando respuesta. Últimas: ${JSON.stringify(responses.slice(-3))}`));
            }
            setTimeout(check, 50);
        };
        const start = Date.now();
        check();
    });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
    console.log(`[LAB] Directorio de grabacion: ${REC_DIR}`);
    fs.mkdirSync(REC_DIR, { recursive: true });

    engine = spawn(ENGINE, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env }
    });

    engine.stdout.on('data', chunk => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const msg = JSON.parse(line);
                responses.push(msg);
            } catch { /* skip non-JSON */ }
        }
    });

    engine.stderr.on('data', chunk => {
        const text = chunk.toString().trim();
        if (text) console.log(`  [stderr] ${text}`);
    });

    // ─── Test 1: Start recorder from input (mic) ───
    console.log('\n[TEST 1] Grabar desde microfono (input) por 2 segundos...');

    send({
        module: 'recorder',
        cmd: 'start',
        requestId: 'rec-input-start',
        recorderSource: 'input',
        deviceId: 'default',
        outputPath: REC_DIR,
        format: 'wav',
        sampleRate: 44100,
        channels: 2,
        naming: 'custom',
        namingPrefix: 'MicTest'
    });

    const startResp = await waitFor(m => m.requestId === 'rec-input-start');
    if (!startResp.ok) throw new Error(`Start fallo: ${JSON.stringify(startResp)}`);
    console.log(`  ✓ Grabacion iniciada: ${startResp.currentFile}`);
    console.log(`  Fuentes: ${JSON.stringify(startResp.sources)}`);

    await sleep(2500);

    // Snapshot
    send({ module: 'recorder', cmd: 'snapshot', requestId: 'rec-snap', recorderId: startResp.recorderId });
    const snap = await waitFor(m => m.requestId === 'rec-snap');
    console.log(`  Snapshot: status=${snap.status}, bytes=${snap.totalBytes}, frames=${snap.totalFrames}, durationMs=${snap.durationMs}`);

    // Stop
    send({ module: 'recorder', cmd: 'stop', requestId: 'rec-input-stop', recorderId: startResp.recorderId });
    const stopResp = await waitFor(m => m.requestId === 'rec-input-stop');
    if (!stopResp.ok) throw new Error(`Stop fallo: ${JSON.stringify(stopResp)}`);
    console.log(`  ✓ Grabacion detenida: totalBytes=${stopResp.totalBytes}, segments=${stopResp.segments}`);

    // Verify WAV file
    const wavFile = startResp.currentFile;
    if (fs.existsSync(wavFile)) {
        const stat = fs.statSync(wavFile);
        const header = Buffer.alloc(44);
        const fd = fs.openSync(wavFile, 'r');
        fs.readSync(fd, header, 0, 44, 0);
        fs.closeSync(fd);
        const riff = header.slice(0, 4).toString();
        const dataSize = header.readUInt32LE(40);
        console.log(`  ✓ WAV valido: ${stat.size} bytes, RIFF=${riff}, dataSize=${dataSize}`);
        if (riff !== 'RIFF') throw new Error('Header WAV invalido');
        if (stat.size < 100) throw new Error('WAV demasiado pequeno');
    } else {
        throw new Error(`Archivo no encontrado: ${wavFile}`);
    }

    // ─── Test 2: Start recorder from master (bus tap) ───
    console.log('\n[TEST 2] Grabar desde master (bus tap)...');

    send({
        module: 'recorder',
        cmd: 'start',
        requestId: 'rec-master-start',
        recorderSource: 'master',
        outputPath: REC_DIR,
        format: 'wav',
        naming: 'datetime'
    });

    const startMaster = await waitFor(m => m.requestId === 'rec-master-start');
    if (!startMaster.ok) throw new Error(`Start master fallo: ${JSON.stringify(startMaster)}`);
    console.log(`  ✓ Grabacion master iniciada: ${startMaster.currentFile}`);

    await sleep(1500);

    send({ module: 'recorder', cmd: 'stop', requestId: 'rec-master-stop', recorderId: startMaster.recorderId });
    const stopMaster = await waitFor(m => m.requestId === 'rec-master-stop');
    if (!stopMaster.ok) throw new Error(`Stop master fallo: ${JSON.stringify(stopMaster)}`);
    console.log(`  ✓ Master detenida: totalBytes=${stopMaster.totalBytes}`);

    // ─── Test 3: List recorders (should be empty after stops) ───
    console.log('\n[TEST 3] Listar grabaciones activas (debe estar vacia)...');
    send({ module: 'recorder', cmd: 'list', requestId: 'rec-list' });
    const listResp = await waitFor(m => m.requestId === 'rec-list');
    console.log(`  ✓ Grabaciones activas: ${listResp.recorders.length}`);
    if (listResp.recorders.length !== 0) throw new Error('Lista no vacia tras detener todo');

    // ─── Test 4: MP3 format (real FFmpeg encoding) ───
    console.log('\n[TEST 4] Grabar MP3 128kbps desde microfono (verifica header MP3 real)...');
    send({
        module: 'recorder',
        cmd: 'start',
        requestId: 'rec-mp3-start',
        recorderSource: 'input',
        deviceId: 'default',
        outputPath: REC_DIR,
        format: 'mp3',
        bitrate: '128',
        splitMinutes: 1,
        naming: 'playlist',
        playlistName: 'Mi Programa de Radio'
    });

    const startMp3 = await waitFor(m => m.requestId === 'rec-mp3-start');
    if (!startMp3.ok) throw new Error(`Start MP3 fallo: ${JSON.stringify(startMp3)}`);
    console.log(`  ✓ MP3 iniciada: ${startMp3.currentFile}`);

    await sleep(2500);

    send({ module: 'recorder', cmd: 'stop', requestId: 'rec-mp3-stop', recorderId: startMp3.recorderId });
    const stopMp3 = await waitFor(m => m.requestId === 'rec-mp3-stop');
    if (!stopMp3.ok) throw new Error(`Stop MP3 fallo: ${JSON.stringify(stopMp3)}`);
    console.log(`  ✓ MP3 detenida: totalBytes=${stopMp3.totalBytes}, segments=${stopMp3.segments}`);

    // Validate MP3 magic bytes
    const mp3File = startMp3.currentFile;
    if (fs.existsSync(mp3File)) {
        const stat = fs.statSync(mp3File);
        const header = Buffer.alloc(4);
        const fd = fs.openSync(mp3File, 'r');
        fs.readSync(fd, header, 0, 4, 0);
        fs.closeSync(fd);
        const isId3 = header[0] === 0x49 && header[1] === 0x44 && header[2] === 0x33;
        const isMpegSync = header[0] === 0xFF && (header[1] & 0xE0) === 0xE0;
        const isRiff = header.slice(0, 4).toString() === 'RIFF';
        if (isRiff) throw new Error('MP3 file has RIFF header — FFmpeg encoding failed, WAV was written instead');
        if (!isId3 && !isMpegSync) throw new Error(`MP3 header invalido: ${header.toString('hex')}`);
        console.log(`  ✓ MP3 valido: ${stat.size} bytes, ID3=${isId3}, sync=${isMpegSync}`);
    } else {
        throw new Error(`Archivo MP3 no encontrado: ${mp3File}`);
    }

    // ─── Test 5: FLAC format (real FFmpeg encoding) ───
    console.log('\n[TEST 5] Grabar FLAC desde microfono (verifica header fLaC)...');
    send({
        module: 'recorder',
        cmd: 'start',
        requestId: 'rec-flac-start',
        recorderSource: 'input',
        deviceId: 'default',
        outputPath: REC_DIR,
        format: 'flac',
        naming: 'custom',
        namingPrefix: 'FlacTest'
    });

    const startFlac = await waitFor(m => m.requestId === 'rec-flac-start');
    if (!startFlac.ok) throw new Error(`Start FLAC fallo: ${JSON.stringify(startFlac)}`);
    console.log(`  ✓ FLAC iniciada: ${startFlac.currentFile}`);

    await sleep(2500);

    send({ module: 'recorder', cmd: 'stop', requestId: 'rec-flac-stop', recorderId: startFlac.recorderId });
    const stopFlac = await waitFor(m => m.requestId === 'rec-flac-stop');
    if (!stopFlac.ok) throw new Error(`Stop FLAC fallo: ${JSON.stringify(stopFlac)}`);
    console.log(`  ✓ FLAC detenida: totalBytes=${stopFlac.totalBytes}, segments=${stopFlac.segments}`);

    // Validate FLAC magic bytes
    const flacFile = startFlac.currentFile;
    if (fs.existsSync(flacFile)) {
        const stat = fs.statSync(flacFile);
        const header = Buffer.alloc(4);
        const fd = fs.openSync(flacFile, 'r');
        fs.readSync(fd, header, 0, 4, 0);
        fs.closeSync(fd);
        const magic = header.toString();
        const isRiff = magic === 'RIFF';
        if (isRiff) throw new Error('FLAC file has RIFF header — FFmpeg encoding failed, WAV was written instead');
        if (magic !== 'fLaC') throw new Error(`FLAC header invalido: ${header.toString('hex')} (esperado: fLaC)`);
        console.log(`  ✓ FLAC valido: ${stat.size} bytes, magic=${magic}`);
    } else {
        throw new Error(`Archivo FLAC no encontrado: ${flacFile}`);
    }

    // ─── Cleanup ───
    console.log('\n[RESUMEN]');
    console.log(`  Tests: 5 pasando`);
    console.log(`  Directorio: ${REC_DIR}`);
    const files = fs.readdirSync(REC_DIR);
    console.log(`  Archivos generados: ${files.length}`);
    files.forEach(f => console.log(`    - ${f}`));

    engine.stdin.end();
    await sleep(300);
    engine.kill();

    // Cleanup temp
    try { fs.rmSync(REC_DIR, { recursive: true }); } catch { }
    console.log('\n✓ Laboratorio recorder completo.');
}

main().catch(err => {
    console.error(`\n✗ FALLO: ${err.message}`);
    if (engine) engine.kill();
    process.exit(1);
});
