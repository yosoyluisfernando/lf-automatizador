const cp = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const enginePath = path.join(root, 'bin', process.platform === 'win32' ? 'lf-audio-engine.exe' : 'lf-audio-engine');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseF32LeBase64(data) {
  const bytes = Buffer.from(data || '', 'base64');
  const samples = [];
  for (let offset = 0; offset + 3 < bytes.length; offset += 4) {
    samples.push(bytes.readFloatLE(offset));
  }
  return samples;
}

function peak(samples) {
  return samples.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);
}

async function main() {
  const child = cp.spawn(enginePath, [], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages = [];
  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8');
    const lines = stdout.split(/\r?\n/);
    stdout = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        if (message.module === 'input' || String(message.requestId || '').startsWith('lab-input-')) {
          messages.push(message);
        }
      } catch {
        // Ignore periodic non-JSON noise if any appears in a dev build.
      }
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  const send = (payload) => {
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  };

  send({ module: 'input', cmd: 'startDevice', requestId: 'lab-input-start', deviceId: 'default', sampleRate: 44100 });
  await wait(350);
  send({ module: 'input', cmd: 'createSource', requestId: 'lab-input-source', sourceId: 'lab-mic', deviceId: 'default', channelMap: [0], gain: 1 });
  await wait(250);
  send({ module: 'input', cmd: 'subscribe', requestId: 'lab-input-sub', sourceId: 'lab-mic', consumer: 'lab:drain', target: 'lab' });
  await wait(1200);
  send({ module: 'input', cmd: 'drainConsumer', requestId: 'lab-input-drain', consumer: 'lab:drain', frames: 4096 });
  await wait(250);
  send({ module: 'input', cmd: 'snapshot', requestId: 'lab-input-snapshot' });
  await wait(100);
  send({ module: 'input', cmd: 'unsubscribe', requestId: 'lab-input-unsub', consumer: 'lab:drain' });
  await wait(100);
  send({ module: 'input', cmd: 'deleteSource', requestId: 'lab-input-delete', sourceId: 'lab-mic' });
  await wait(100);
  send({ module: 'input', cmd: 'stopDevice', requestId: 'lab-input-stop', deviceId: 'default' });
  await wait(200);
  child.stdin.end();

  const exitCode = await new Promise((resolve) => child.on('exit', (code) => resolve(code || 0)));
  if (exitCode !== 0) {
    throw new Error(`Motor Rust salio con codigo ${exitCode}: ${stderr}`);
  }

  const drain = messages.find((message) => message.requestId === 'lab-input-drain');
  if (!drain || drain.type !== 'inputPcm') {
    throw new Error('No se recibio inputPcm desde drainConsumer.');
  }
  if (!drain.frames || !drain.channels || !drain.data) {
    throw new Error(`Drain invalido: ${JSON.stringify(drain)}`);
  }
  const samples = parseF32LeBase64(drain.data);
  const expectedSamples = drain.frames * drain.channels;
  if (samples.length !== expectedSamples) {
    throw new Error(`Muestras drenadas inesperadas: ${samples.length} != ${expectedSamples}`);
  }
  const measuredPeak = peak(samples);
  const snapshot = messages.find((message) => message.requestId === 'lab-input-snapshot');
  const consumerSnapshot = snapshot && snapshot.consumers && snapshot.consumers[0];
  if (!consumerSnapshot || !consumerSnapshot.frames || !consumerSnapshot.callbacks) {
    throw new Error(`Snapshot de consumidor invalido: ${JSON.stringify(snapshot)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    enginePath,
    drain: {
      frames: drain.frames,
      channels: drain.channels,
      remainingFrames: drain.remainingFrames,
      peak: drain.peak,
      measuredPeak,
      bytes: Buffer.from(drain.data, 'base64').length,
    },
    snapshotConsumer: consumerSnapshot,
  }, null, 2));
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
