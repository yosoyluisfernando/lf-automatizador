const cp = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const enginePath = path.join(root, 'bin', process.platform === 'win32' ? 'lf-audio-engine.exe' : 'lf-audio-engine');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveFfmpegPath() {
  try {
    const ffmpegStatic = require('ffmpeg-static');
    if (ffmpegStatic) return ffmpegStatic;
  } catch {
    // Dependency is optional in some local lab environments.
  }
  return process.platform === 'win32' ? 'C:\\ffmpeg\\bin\\ffmpeg.exe' : 'ffmpeg';
}

function lastServerSnapshot(messages, serverId) {
  const sid = String(serverId);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const servers = messages[i]?.servers || messages[i]?.encoderServers;
    if (!Array.isArray(servers)) continue;
    const server = servers.find((item) => String(item.serverId) === sid);
    if (server) return server;
  }
  return null;
}

function lastEncoderStatus(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.type === 'status' && messages[i]?.encoder) return messages[i].encoder;
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
  const serverId = 'lab-input-encoder';
  const ffmpegPath = resolveFfmpegPath();

  send({
    module: 'encoder',
    cmd: 'startLocalNull',
    requestId: 'lab-input-encoder-start',
    serverId,
    serverType: 'icecast',
    ip: '127.0.0.1',
    port: '8000',
    user: 'source',
    password: 'lab-password',
    mount: '/lab',
    codec: 'mp3',
    bitrate: '96',
    source: 'mic',
    sourceId: 'default',
    sampleRate: 44100,
    captureFormat: 'pcm_s16le',
    ffmpegPath,
  });
  await wait(2500);
  send({ module: 'encoder', cmd: 'serverSnapshot', requestId: 'lab-input-encoder-snapshot' });
  await wait(150);
  send({ module: 'encoder', cmd: 'stopServer', requestId: 'lab-input-encoder-stop', serverId });
  await wait(200);
  send({ module: 'input', cmd: 'snapshot', requestId: 'lab-input-encoder-input-snapshot' });
  await wait(150);
  child.stdin.end();

  const exitCode = await new Promise((resolve) => child.on('exit', (code) => resolve(code || 0)));
  if (exitCode !== 0) {
    throw new Error(`Motor Rust salio con codigo ${exitCode}: ${stderr}`);
  }

  const start = messages.find((message) => message.requestId === 'lab-input-encoder-start');
  if (!start?.ok) {
    throw new Error(`startLocalNull no respondio ok: ${JSON.stringify(start)}\n${stderr}`);
  }
  const server = lastServerSnapshot(messages, serverId);
  if (!server || !(server.pcmBytes > 0) || !(server.pcmChunks > 0)) {
    throw new Error(`FFmpeg local-null no recibio PCM de entrada: ${JSON.stringify(server)}`);
  }
  const encoderStatus = lastEncoderStatus(messages);
  if (!encoderStatus || !Number.isFinite(Number(encoderStatus.inputPeakDb)) || Number(encoderStatus.inputPeakDb) <= -119) {
    throw new Error(`El status Rust no publico nivel de entrada del encoder: ${JSON.stringify(encoderStatus)}`);
  }
  const inputSnapshot = messages.find((message) => message.requestId === 'lab-input-encoder-input-snapshot');
  if (!inputSnapshot || (inputSnapshot.sources || []).length || (inputSnapshot.consumers || []).length) {
    throw new Error(`La ruta input del encoder no se limpio: ${JSON.stringify(inputSnapshot)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    enginePath,
    ffmpegPath,
    server: {
      serverId: server.serverId,
      status: server.status,
      mode: server.mode,
      pcmBytes: server.pcmBytes,
      pcmChunks: server.pcmChunks,
    },
    encoderInputMeter: {
      peakDb: encoderStatus.inputPeakDb,
      rmsDb: encoderStatus.inputRmsDb,
      updatedAt: encoderStatus.inputMeterUpdatedAt,
    },
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
