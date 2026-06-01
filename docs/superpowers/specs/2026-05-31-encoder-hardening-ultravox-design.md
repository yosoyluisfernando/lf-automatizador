# Encoder Hardening and Native SHOUTcast 2 Design

Date: 2026-05-31
Status: Approved

## Goals

- Keep multi-server transmission stable when one destination is slow or unavailable.
- Make each selectable server mode match the wire protocol actually used.
- Support Icecast 2, SHOUTcast 1 ICY legacy, SHOUTcast 1 compatibility into DNAS 2, and native SHOUTcast 2 Ultravox 2.1.
- Support MP3 and AAC-LC in public packages.
- Support AAC+ / HE-AAC only when an operator supplies an authorized FFmpeg binary with `libfdk_aac`.
- Preserve the intentional Rust encoder taps: pre-FX or post-FX, both before the master fader.
- Prevent secrets and misleading codec state from leaking into logs or the UI.

## Public Distribution Policy

The public Windows and Linux installers must not bundle `libfdk_aac`. The current
`ffmpeg-static` binary is GPL-enabled. Combining a GPL-enabled FFmpeg with
`libfdk_aac` requires `--enable-nonfree`, which FFmpeg documents as
unredistributable.

Public packages expose:

- MP3 through `libmp3lame`.
- AAC through AAC-LC.
- AAC+ / HE-AAC as an optional external capability only.

HE-AAC must never silently degrade to AAC-LC. If an authorized external FFmpeg
with `libfdk_aac` is unavailable, connection is blocked with a clear operator
message. `LF_FFMPEG_FDK_PATH` is the explicit external override.

## Server Modes

| UI mode | Transport |
| --- | --- |
| Icecast 2 | HTTP PUT through FFmpeg Icecast protocol |
| SHOUTcast classic | SC1 ICY source socket |
| SHOUTcast 2 compatibility | SC1 ICY source socket with `password:#SID` |
| SHOUTcast 2 native | Ultravox 2.1 binary protocol |

HTTP PUT and HTTP SOURCE compatibility attempts must not be labeled as native
SHOUTcast 2.

## Native Ultravox 2.1

Every UVOX message uses:

```text
5A | reserved/QoS | class+type BE16 | payloadLength BE16 | payload | 00
```

The canonical broadcaster handshake is:

1. `0x1009` request cipher with `2.1\0`.
2. `0x1001` authenticate with version, SID, XTEA-encrypted UID and password.
3. `0x1040` MIME type.
4. `0x1002` average and maximum bitrate.
5. `0x1003` buffer size negotiation.
6. `0x1008` maximum payload negotiation.
7. Optional `0x1100` to `0x1103` station metadata.
8. `0x1004` standby and transition to data transfer.

Encoded audio is framed by complete codec frames:

| Codec | MIME | UVOX message |
| --- | --- | --- |
| MP3 | `audio/mpeg` | `0x7000` |
| AAC-LC | `audio/aac` | `0x8001` |
| HE-AAC | `audio/aacp` | `0x8003` |

The implementation must parse fragmented and coalesced TCP frames, cap
pre-handshake audio memory, respect the negotiated payload limit, send
`0x1005` on intentional termination, and classify NAK responses for logs.

## Reliability Rules

- Closing or replacing a socket intentionally must not trigger reconnect errors.
- A destination waiting for FFmpeg stdin drain must be skipped until recovery.
- Handshake timeout remains active until the transport is live.
- Shutdown disconnects every socket and FFmpeg process before Electron quits.
- Frontend retries only transient network failures.
- Backend validation is authoritative even if IPC payloads bypass the UI.
- Persistent logs and UI errors redact credentials, URLs with credentials,
  authorization headers, and password-like query parameters.
- Persistent logs rotate by size.
- Encoder preferences are written atomically and save failures are visible.

## Rust Tap Contract

The pre-FX and post-FX taps stay before the master fader. Enabling a tap requires:

1. Rust ACK.
2. Explicit readiness state.
3. First PCM chunk within a bounded timeout.
4. Watchdog coverage while active.
5. Session invalidation after Rust restart.
6. Lock-free dropped-sample counters reported outside the audio thread.

## Test Strategy

- Unit tests for shutdown, backpressure, redaction, validation, retries and
  strict HE-AAC capability checks.
- TCP mock servers for ICY and UVOX handshakes, malformed frames, timeouts,
  authentication failures, reconnects, audio packetization and termination.
- Rust tests for readiness, stale sessions and ring-buffer drop telemetry.
- Syntax checks, Node tests, `cargo test`, `cargo check`, and package smoke checks.

## References

- https://web.archive.org/web/20240502000512/http://wiki.winamp.com/wiki/SHOUTcast_2_%28Ultravox_2.1%29_Protocol_Details
- https://sc-mirror.shoutca.st/docs/DNAS_Server_Source_Support.html
- https://ffmpeg.org/doxygen/trunk/md_LICENSE.html
- https://www.ffmpeg.org/general.html#OpenCORE_002c-VisualOn_002c-and-Fraunhofer-libraries
- https://ffmpeg.org/ffmpeg-codecs.html#libfdk_005faac
- https://android.googlesource.com/platform/external/aac/+/master/NOTICE
