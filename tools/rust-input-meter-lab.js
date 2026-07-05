const cp = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const enginePath = path.join(root, 'bin', process.platform === 'win32' ? 'lf-audio-engine.exe' : 'lf-audio-engine');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lastStatusWithMeter(messages, meterId) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const meters = messages[i]?.inputMeters;
    if (!Array.isArray(meters)) continue;
    const meter = meters.find((item) => item.id === meterId);
    if (meter) return { status: messages[i], meter };
  }
  return null;
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
  const meterId = 'lab:meter';

  send({
    module: 'input',
    cmd: 'meterStart',
    requestId: 'lab-meter-start',
    consumer: meterId,
    sourceId: 'lab.input.preview',
    deviceId: 'default',
    sampleRate: 44100,
    channelMap: [0],
    gain: 1,
  });
  await wait(1400);
  send({ cmd: 'status', requestId: 'lab-meter-status' });
  await wait(150);
  send({ module: 'input', cmd: 'meterStop', requestId: 'lab-meter-stop', consumer: meterId });
  await wait(150);
  send({ module: 'input', cmd: 'snapshot', requestId: 'lab-meter-input-after-stop' });
  await wait(150);
  child.stdin.end();

  const exitCode = await new Promise((resolve) => child.on('exit', (code) => resolve(code || 0)));
  if (exitCode !== 0) {
    throw new Error(`Motor Rust salio con codigo ${exitCode}: ${stderr}`);
  }

  const start = messages.find((message) => message.requestId === 'lab-meter-start');
  if (!start?.ok) {
    throw new Error(`meterStart no respondio ok: ${JSON.stringify(start)}\n${stderr}`);
  }
  const live = lastStatusWithMeter(messages, meterId);
  if (!live || !(Number(live.meter.peakDb) > -119)) {
    throw new Error(`No se publico inputMeter con audio real: ${JSON.stringify(live?.meter)}`);
  }
  const stop = messages.find((message) => message.requestId === 'lab-meter-stop');
  if (!stop?.ok) {
    throw new Error(`meterStop no respondio ok: ${JSON.stringify(stop)}`);
  }
  const inputSnapshot = messages.find((message) => message.requestId === 'lab-meter-input-after-stop');
  if (!inputSnapshot || (inputSnapshot.sources || []).length || (inputSnapshot.consumers || []).length) {
    throw new Error(`meterStop no limpio sources/consumers: ${JSON.stringify(inputSnapshot)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    enginePath,
    meter: live.meter,
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
