const cp = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const enginePath = path.join(root, 'bin', process.platform === 'win32' ? 'lf-audio-engine.exe' : 'lf-audio-engine');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lastStatus(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.type === 'status') return messages[i];
  }
  return null;
}

function lastInputSnapshot(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.module === 'input' && Array.isArray(messages[i]?.captures)) return messages[i];
  }
  return null;
}

function findMeter(status, id) {
  return (status?.meters || []).find((meter) => meter.id === id) || null;
}

function findPlayer(status, id) {
  return (status?.players || []).find((player) => player.id === id) || null;
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
        messages.push(JSON.parse(line));
      } catch {
        // Ignore non-JSON dev output.
      }
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  const send = (payload) => child.stdin.write(`${JSON.stringify(payload)}\n`);

  send({
    module: 'input',
    cmd: 'pttStart',
    requestId: 'lab-ptt-start',
    deviceId: 'default',
    sourceId: 'lab-ptt',
    sampleRate: 44100,
    channelMap: [0],
    gain: 0.35,
    toGain: 0.25,
    durationMs: 150,
    ringBufferSeconds: 2,
  });
  await wait(1800);
  send({ cmd: 'status', requestId: 'lab-ptt-status-live' });
  await wait(150);
  send({ module: 'input', cmd: 'pttStop', requestId: 'lab-ptt-stop' });
  await wait(350);
  send({
    module: 'input',
    cmd: 'pttStart',
    requestId: 'lab-ptt-preview-start',
    deviceId: 'default',
    sourceId: 'lab-ptt-preview',
    sampleRate: 44100,
    channelMap: [0],
    gain: 0.35,
    enable: false,
    target: 'preview',
  });
  await wait(500);
  send({ cmd: 'status', requestId: 'lab-ptt-preview-status' });
  await wait(150);
  send({ module: 'input', cmd: 'pttStop', requestId: 'lab-ptt-preview-stop' });
  await wait(150);
  send({ module: 'input', cmd: 'snapshot', requestId: 'lab-ptt-input-after-stop' });
  await wait(150);
  child.stdin.end();

  const exitCode = await new Promise((resolve) => child.on('exit', (code) => resolve(code || 0)));
  if (exitCode !== 0) {
    throw new Error(`Motor Rust salio con codigo ${exitCode}: ${stderr}`);
  }

  const start = messages.find((message) => message.requestId === 'lab-ptt-start');
  if (!start?.ok) {
    throw new Error(`pttStart no respondio ok: ${JSON.stringify(start)}\n${stderr}`);
  }
  const liveStatus = messages.find((message) => message.requestId === 'lab-ptt-status-live') || lastStatus(messages);
  const pttPlayer = findPlayer(liveStatus, 'ptt:program');
  if (!pttPlayer || pttPlayer.status !== 'playing' || !pttPlayer.audioReady) {
    throw new Error(`PTT no quedo reproduciendo en Rust: ${JSON.stringify(pttPlayer)}`);
  }
  const pttMeter = findMeter(liveStatus, 'ptt:program');
  if (!pttMeter || !(Number(pttMeter.db) > -119)) {
    throw new Error(`PTT no publico medidor con audio: ${JSON.stringify(pttMeter)}`);
  }
  const masterMeter = findMeter(liveStatus, 'master');
  if (!masterMeter || !(Number(masterMeter.db) > -119)) {
    throw new Error(`PTT no llego al bus master: ${JSON.stringify(masterMeter)}`);
  }
  if (!liveStatus?.ptt?.routeToMaster || !(Math.abs(Number(liveStatus.ptt.masterGain) - 0.25) < 0.08)) {
    throw new Error(`PTT no aplico ducking Rust al master: ${JSON.stringify(liveStatus?.ptt)}`);
  }
  const stop = messages.find((message) => message.requestId === 'lab-ptt-stop');
  if (!stop?.ok) {
    throw new Error(`pttStop no respondio ok: ${JSON.stringify(stop)}`);
  }
  const previewStart = messages.find((message) => message.requestId === 'lab-ptt-preview-start');
  if (!previewStart?.ok || previewStart.routeToMaster !== false) {
    throw new Error(`PTT preview no respondio como ruta sin master: ${JSON.stringify(previewStart)}`);
  }
  const previewStatus = messages.find((message) => message.requestId === 'lab-ptt-preview-status') || lastStatus(messages);
  if (previewStatus?.ptt?.routeToMaster) {
    throw new Error(`PTT preview no debe crear player/master route: ${JSON.stringify(previewStatus?.ptt)}`);
  }
  const previewStop = messages.find((message) => message.requestId === 'lab-ptt-preview-stop');
  if (!previewStop?.ok) {
    throw new Error(`pttStop preview no respondio ok: ${JSON.stringify(previewStop)}`);
  }
  const inputSnapshot = messages.find((message) => message.requestId === 'lab-ptt-input-after-stop') || lastInputSnapshot(messages);
  if (!inputSnapshot || (inputSnapshot.sources || []).length || (inputSnapshot.consumers || []).length) {
    throw new Error(`PTT no limpio sources/consumers: ${JSON.stringify(inputSnapshot)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    enginePath,
    player: pttPlayer,
    pttMeter,
    masterMeter,
    ptt: liveStatus.ptt,
    inputAfterStop: {
      captures: (inputSnapshot.captures || []).length,
      sources: (inputSnapshot.sources || []).length,
      consumers: (inputSnapshot.consumers || []).length,
    },
  }, null, 2));
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
