# Encoder Hardening and Native Ultravox Implementation Plan

Date: 2026-05-31
Design: `docs/superpowers/specs/2026-05-31-encoder-hardening-ultravox-design.md`

## Task 1: Immediate Backend Reliability

Files:
- `backend/ipc/windows.js`
- `tests/encoder_regressions.test.js`

Steps:
1. Extend the regression tests for handshake timeout and bounded buffering.
2. Mark socket closures intentional before destroying them.
3. Close sockets in individual, global and replacement paths.
4. Skip destinations waiting for drain.
5. Register quiet `before-quit` cleanup.
6. Run encoder and stream regression tests.

## Task 2: Validation, Redaction and UI Semantics

Files:
- `main.js`
- `backend/ipc/windows.js`
- `frontend/encoder.js`
- `tests/encoder_security_validation.test.js`

Steps:
1. Add central secret redaction and persistent log rotation.
2. Add authoritative backend validation with structured error categories.
3. Stop automatic reconnect for permanent configuration or auth failures.
4. Make preference writes atomic and report failures.
5. Rename UI modes so HTTP compatibility is not called native Ultravox.
6. Request the fields required by each selected protocol.

## Task 3: FFmpeg Resolution and Strict AAC+

Files:
- `backend/utils/ffmpeg_resolver.js`
- `main.js`
- `backend/audio_analysis_worker.js`
- `backend/waveform_worker.js`
- `backend/ipc/windows.js`
- `package.json`
- installer scripts
- `tests/ffmpeg_resolver.test.js`

Steps:
1. Centralize FFmpeg resolution and capability probing.
2. Keep public baseline FFmpeg separate from optional external FDK FFmpeg.
3. Read `LF_FFMPEG_PATH`, compatibility `FFMPEG_BIN`, and
   `LF_FFMPEG_FDK_PATH`.
4. Block HE-AAC when `libfdk_aac` is absent.
5. Remove the silent AAC-LC fallback.
6. Align Linux package behavior with system FFmpeg where appropriate.
7. Reconcile the package license metadata with the repository license.

## Task 4: Native SHOUTcast 2 Ultravox

Files:
- `backend/encoder/ultravox.js`
- `backend/ipc/windows.js`
- `tests/ultravox.test.js`

Steps:
1. Implement UVOX envelope encode/decode and streaming parser.
2. Implement XTEA authentication encoding.
3. Implement broadcaster handshake and structured NAK errors.
4. Parse MP3 and ADTS frames from arbitrary FFmpeg stdout chunks.
5. Frame audio using negotiated payload size.
6. Implement native XML metadata and clean termination.
7. Add deterministic TCP mock tests for fragmented responses, auth failure,
   payload negotiation, audio framing and shutdown.

## Task 5: Rust Tap Readiness and Telemetry

Files:
- `backend/audio_engine_process.js`
- `backend/ipc/windows.js`
- `audio-engine-rust/src/main.rs`
- `tests/audio_engine_process.test.js`

Steps:
1. Make `attachPcmConsumer` await Rust ACK and first PCM chunk.
2. Add generation-bound sessions and invalidate them on process exit.
3. Add active, ready, mode and dropped-sample state to Rust status.
4. Count encoder ring drops lock-free and report deltas.
5. Start FFmpeg only after confirmed tap readiness.
6. Preserve both encoder taps before the master fader.

## Task 6: Integration Review

Steps:
1. Run Node tests and syntax checks.
2. Run `cargo test` and `cargo check`.
3. Probe bundled FFmpeg capabilities.
4. Ask subagents for spec and code-quality review.
5. Fix all critical and important findings.
6. Report residual legal and packaging constraints clearly.
