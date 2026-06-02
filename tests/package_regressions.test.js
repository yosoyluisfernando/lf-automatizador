'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const rootDir = path.join(__dirname, '..');
const installerSource = fs.readFileSync(path.join(rootDir, 'build', 'installer.nsh'), 'utf8');
const workflowSource = fs.readFileSync(path.join(rootDir, '.github', 'workflows', 'release.yml'), 'utf8');
const mainSource = fs.readFileSync(path.join(rootDir, 'main.js'), 'utf8');
const packageJson = require('../package.json');

test('Windows installer tolerates CI builds without a bundled VC++ redistributable', () => {
    assert.match(installerSource, /!if\s+\/FileExists\s+"\$\{BUILD_RESOURCES_DIR\}\\vcredist\\vc_redist\.x64\.exe"/);
    assert.match(installerSource, /asistente de primer inicio/i);
    assert.doesNotMatch(installerSource, /ExecWait\s+'"\$PLUGINSDIR\\vc_redist\.x64\.exe"/);
});

test('VC++ redistributable is verified as Microsoft-signed before the wizard executes it', () => {
    assert.match(mainSource, /verifyMicrosoftAuthenticode\(exePath\)/);
    assert.match(mainSource, /fs\.mkdtempSync\(path\.join\(os\.tmpdir\(\), 'lf-vcredist-'\)\)/);
    assert.match(workflowSource, /Get-AuthenticodeSignature/);
    assert.match(workflowSource, /Microsoft Corporation/);
});

test('main process prevents app suspension while allowing the display to sleep and reports power transitions', () => {
    assert.match(mainSource, /powerMonitor,\s*powerSaveBlocker/);
    assert.match(mainSource, /powerSaveBlocker\.start\('prevent-app-suspension'\)/);
    assert.match(mainSource, /powerMonitor\.on\('suspend'/);
    assert.match(mainSource, /powerMonitor\.on\('resume'/);
    assert.match(mainSource, /audio-engine-power-event/);
});

test('build job uses read-only repository permissions and does not expose GH_TOKEN to electron-builder', () => {
    assert.match(workflowSource, /permissions:\s*\n\s*contents: read/);
    assert.doesNotMatch(workflowSource, /GH_TOKEN:/);
    assert.match(workflowSource, /publish-release:[\s\S]*permissions:\s*\n\s*contents: write/);
});

test('GitHub Actions dependencies are pinned to immutable commit SHAs', () => {
    const refs = [...workflowSource.matchAll(/uses:\s+([^@\s]+)@([^\s#]+)/g)];
    assert.ok(refs.length >= 7);
    refs.forEach(([, action, ref]) => {
        assert.match(ref, /^[a-f0-9]{40}$/, `${action} must use a full commit SHA`);
    });
});

test('tagged releases fail closed until the corresponding FFmpeg source bundle is attached', () => {
    assert.match(workflowSource, /Require Corresponding FFmpeg Source Bundle/);
    assert.match(workflowSource, /build\/compliance\/ffmpeg-source-bundle-\*\.zip/);
    assert.match(workflowSource, /release-assets\/ffmpeg-source-bundle-\*\.zip/);
    assert.match(workflowSource, /ffmpeg-source-manifest\.json/);
    assert.match(workflowSource, /includesExternalLibrarySources/);
    assert.match(workflowSource, /SHA256SUMS-sources\.txt/);
});

test('packaging verifies ffmpeg-static hashes and publishes installer checksums', () => {
    assert.match(workflowSource, /Verify ffmpeg-static SHA-256/);
    assert.match(workflowSource, /Require Signed Windows Installer For Tags/);
    assert.match(workflowSource, /LF_WINDOWS_SIGNER_THUMBPRINT/);
    assert.match(workflowSource, /Verify Release Tag Matches Package Version/);
    assert.match(workflowSource, /SHA256SUMS-\*\.txt/);
    assert.match(workflowSource, /uses: actions\/attest@[a-f0-9]{40}/);
    const verifySource = fs.readFileSync(path.join(rootDir, 'build', 'verify-ffmpeg-static.js'), 'utf8');
    assert.match(verifySource, /win32-x64/);
    assert.match(verifySource, /linux-x64/);
});

test('beta releases publish as prereleases without requiring an Authenticode certificate', () => {
    assert.match(workflowSource, /matrix\.platform == 'win' && startsWith\(github\.ref, 'refs\/tags\/'\) && !contains\(github\.ref_name, '-beta\.'\)/);
    assert.match(workflowSource, /prerelease:\s+\$\{\{\s*contains\(github\.ref_name, '-'\)\s*\}\}/);
});

test('beta releases may omit the FFmpeg source bundle while stable releases remain fail-closed', () => {
    assert.match(workflowSource, /Require Corresponding FFmpeg Source Bundle[\s\S]*if:\s+\$\{\{\s*!contains\(github\.ref_name, '-beta\.'\)\s*\}\}/);
    assert.match(workflowSource, /Attest FFmpeg Source Bundle Checksum[\s\S]*if:\s+\$\{\{\s*!contains\(github\.ref_name, '-beta\.'\)\s*\}\}/);
    assert.match(workflowSource, /fail_on_unmatched_files:\s+\$\{\{\s*!contains\(github\.ref_name, '-beta\.'\)\s*\}\}/);
});

test('release tag validation runs through a portable Node script', () => {
    assert.match(workflowSource, /node build\/verify-release-tag\.js/);
    const { verifyReleaseTag } = require('../build/verify-release-tag');
    assert.doesNotThrow(() => verifyReleaseTag('v0.9.12-beta.2', '0.9.12-beta.2'));
    assert.throws(() => verifyReleaseTag('v0.9.12-beta.1', '0.9.12-beta.2'), /no coincide/);
});

test('package version is valid SemVer so electron-builder preserves the release number', () => {
    assert.match(packageJson.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    assert.ok(packageJson.build.files.includes('LICENSE'));
});

test('Windows and Linux package scripts compile and copy the native Rust engine first', () => {
    assert.strictEqual(packageJson.scripts.predist, 'npm run verify:ffmpeg-static && npm run prepare:rust-engine');
    assert.strictEqual(packageJson.scripts['predist:win'], 'npm run verify:ffmpeg-static && npm run prepare:rust-engine');
    assert.strictEqual(packageJson.scripts['predist:linux'], 'npm run verify:ffmpeg-static && npm run prepare:rust-engine');
    const prepareSource = fs.readFileSync(path.join(rootDir, 'build', 'prepare-rust-engine.js'), 'utf8');
    assert.match(prepareSource, /cargo/);
    assert.match(prepareSource, /lf-audio-engine/);
    assert.match(prepareSource, /copyFileSync/);
});
