'use strict';

const assert = require('assert');
const test = require('node:test');

const { verifyMicrosoftAuthenticode } = require('../backend/utils/windows_authenticode');

test('Authenticode helper accepts only a valid Microsoft signer', () => {
    const accepted = verifyMicrosoftAuthenticode('C:\\temp\\vc_redist.x64.exe', {
        allowNonWindows: true,
        spawnSync: () => ({
            status: 0,
            stdout: JSON.stringify({
                Status: 'Valid',
                Subject: 'CN=Microsoft Corporation, O=Microsoft Corporation, C=US'
            }),
            stderr: ''
        })
    });
    assert.strictEqual(accepted.ok, true);

    const rejected = verifyMicrosoftAuthenticode('C:\\temp\\vc_redist.x64.exe', {
        allowNonWindows: true,
        spawnSync: () => ({
            status: 0,
            stdout: JSON.stringify({
                Status: 'Valid',
                Subject: 'CN=Untrusted Vendor, O=Untrusted Vendor, C=US'
            }),
            stderr: ''
        })
    });
    assert.strictEqual(rejected.ok, false);
});

test('Authenticode helper escapes single quotes in the executable path', () => {
    let encodedCommand = '';
    verifyMicrosoftAuthenticode("C:\\temp\\Luis' Radio\\vc_redist.x64.exe", {
        allowNonWindows: true,
        spawnSync: (_bin, args) => {
            encodedCommand = args[args.indexOf('-EncodedCommand') + 1];
            return {
                status: 0,
                stdout: JSON.stringify({
                    Status: 'Valid',
                    Subject: 'CN=Microsoft Corporation, O=Microsoft Corporation, C=US'
                }),
                stderr: ''
            };
        }
    });
    const script = Buffer.from(encodedCommand, 'base64').toString('utf16le');
    assert.match(script, /Luis'' Radio/);
});
