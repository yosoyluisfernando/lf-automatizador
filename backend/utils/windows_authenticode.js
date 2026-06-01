'use strict';

const cp = require('child_process');

function verifyMicrosoftAuthenticode(executablePath, options = {}) {
    if (process.platform !== 'win32' && options.allowNonWindows !== true) {
        return { ok: false, error: 'Authenticode solo esta disponible en Windows.' };
    }
    const spawnSync = options.spawnSync || cp.spawnSync;
    const literalPath = String(executablePath || '').replace(/'/g, "''");
    const script = [
        `$signature = Get-AuthenticodeSignature -LiteralPath '${literalPath}'`,
        '[pscustomobject]@{ Status = [string]$signature.Status; Subject = [string]$signature.SignerCertificate.Subject } | ConvertTo-Json -Compress'
    ].join('; ');
    const encodedCommand = Buffer.from(script, 'utf16le').toString('base64');
    let result;
    try {
        result = spawnSync(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand],
            { encoding: 'utf8', windowsHide: true, timeout: 15000 }
        );
    } catch (err) {
        return { ok: false, error: err?.message || String(err) };
    }
    if (result.error || result.status !== 0) {
        return {
            ok: false,
            error: result.error?.message || String(result.stderr || 'No se pudo verificar la firma Authenticode.').trim()
        };
    }
    try {
        const signature = JSON.parse(String(result.stdout || '').trim());
        const subject = String(signature.Subject || '');
        const microsoftSigner = /(?:^|,\s*)(?:CN|O)=Microsoft Corporation(?:,|$)/i.test(subject);
        if (signature.Status !== 'Valid' || !microsoftSigner) {
            return { ok: false, error: `Firma Authenticode no confiable: ${signature.Status || 'sin estado'}; ${subject || 'sin firmante'}` };
        }
        return { ok: true, status: signature.Status, subject };
    } catch (err) {
        return { ok: false, error: 'Respuesta Authenticode invalida: ' + (err?.message || String(err)) };
    }
}

module.exports = { verifyMicrosoftAuthenticode };
