'use strict';

function verifyReleaseTag(tag, version) {
    const expected = `v${version}`;
    if (tag !== expected) throw new Error(`Tag ${tag || '(vacio)'} no coincide con ${expected}`);
    return expected;
}

if (require.main === module) {
    const expected = verifyReleaseTag(process.env.GITHUB_REF_NAME, require('../package.json').version);
    console.log(`Tag de release verificado: ${expected}`);
}

module.exports = { verifyReleaseTag };
