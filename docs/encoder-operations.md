# Encoder Operations

## Server Selection

The selected UI mode is the transport used on the wire:

| UI mode | Wire protocol | Required fields |
| --- | --- | --- |
| Icecast 2 | FFmpeg Icecast HTTP PUT | Host, source port, source user, password, mount |
| SHOUTcast v1/classic | ICY v1 source socket | Host, source port, password; optional admin port for metadata |
| SHOUTcast 2 native | Ultravox 2.1 | Host, source port, UID, password, positive SID |
| SHOUTcast 2 with ICY compatibility enabled | ICY v1 with `password:#SID` | Host, source port, password, positive SID |

Use the exact source port supplied by the streaming provider. It is not always
the listener port. ICY deployments commonly use the DNAS base port plus one.

SHOUTcast metadata updates can use an optional administrative port. When it is
empty, the encoder uses the source port for backward compatibility. Set it when
the provider exposes source ingestion and `/admin.cgi` on different ports.

The Rust master tap can feed multiple destinations. Renderer microphone capture
is intentionally restricted to one destination at a time because a second
FFmpeg process cannot safely join an already-running WebM stream mid-header.

## Codecs

Public Windows and Linux packages support:

- MP3 through `libmp3lame`.
- AAC-LC through the FFmpeg native AAC encoder.

Linux prefers the distribution FFmpeg package. If it is unavailable or lacks
MP3 support, the packaged `ffmpeg-static` binary is used as a fallback so the
AppImage remains usable.

AAC+ / HE-AAC is intentionally strict. Public packages do not bundle
`libfdk_aac`. An operator who is authorized to use that encoder can provide a
separate FFmpeg binary:

```powershell
$env:LF_FFMPEG_FDK_PATH = 'C:\tools\ffmpeg-fdk\bin\ffmpeg.exe'
npm start
```

```bash
LF_FFMPEG_FDK_PATH=/opt/ffmpeg-fdk/bin/ffmpeg npm start
```

The application probes the binary and enables AAC+ only if it actually exposes
`libfdk_aac`. It never silently sends AAC-LC when AAC+ was selected.

## Public Release Checklist

- Sign the Windows installer with the project's Authenticode certificate before
  publication. A local unsigned build is suitable for testing, not release.
  Tagged CI releases fail closed when the Windows installer signature is absent
  or its thumbprint differs from `vars.LF_WINDOWS_SIGNER_THUMBPRINT`. Configure
  `secrets.WINDOWS_CSC_LINK` and `secrets.WINDOWS_CSC_KEY_PASSWORD` for signing.
- Publish the corresponding source required by the GPL for the exact distributed
  FFmpeg binaries, including applicable external libraries, or remove those
  binaries from the public artifact. Tagged releases fail closed until a
  `build/compliance/ffmpeg-source-bundle-*.zip` archive is included. The ZIP
  must exceed 1 MB and contain `ffmpeg-source-manifest.json` with
  `ffmpegStaticRelease`, `includesExternalLibrarySources: true`, and the
  approved `binarySha256` values for `win32-x64` and `linux-x64`.
- The bundled VC++ redistributable is downloaded from Microsoft in CI and its
  Authenticode signer is verified. The first-run wizard verifies it again before
  execution.
- CI verifies the approved SHA-256 for `ffmpeg-static` on Windows and Linux and
  publishes `SHA256SUMS-*.txt` alongside release artifacts. GitHub Actions also
  attests those checksum manifests so consumers can verify build provenance.

## Credentials And Logs

Encoder preferences are stored atomically. Passwords are encrypted with
Electron `safeStorage`. If the operating system has no secure storage backend,
passwords stay session-only and the encoder displays a warning.

Persistent logs redact URL credentials, authorization headers, query-string
secrets and password-like fields. Old persistent log content is scrubbed on the
next application run before new lines are appended.
