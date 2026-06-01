'use strict';

const fs = require('fs');

const DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024;
const DEFAULT_KEEP_LOG_BYTES = 1024 * 1024;

function redactSensitiveText(value) {
    let text = String(value ?? '');
    text = text.replace(
        /\b((?:https?|icecast):\/\/[^:\s/@]+:)[^@\s/]+(@)/gi,
        '$1[REDACTED]$2'
    );
    text = text.replace(
        /\b(Authorization\s*:\s*(?:Basic|Bearer)\s+)[^\s,]+/gi,
        '$1[REDACTED]'
    );
    text = text.replace(
        /([?&](?:pass|password|token|auth|api[_-]?key|secret)=)[^&\s]+/gi,
        '$1[REDACTED]'
    );
    text = text.replace(
        /\b(password|pass|token|api[_-]?key|clientSecret|secret)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
        '$1=[REDACTED]'
    );
    text = text.replace(
        /(["'])(password|pass|token|api[_-]?key|clientSecret|secret)\1\s*:\s*(?:"[^"]*"|'[^']*'|[^,}\s]+)/gi,
        '"$2":"[REDACTED]"'
    );
    text = text.replace(
        /\\"(password|pass|token|api[_-]?key|clientSecret|secret)\\"\s*:\s*\\"[^"]*\\"/gi,
        '\\"$1\\":\\"[REDACTED]\\"'
    );
    return text;
}

function rotateLogIfNeeded(filePath, options = {}) {
    const maxBytes = Number(options.maxBytes) || DEFAULT_MAX_LOG_BYTES;
    const keepBytes = Math.min(Number(options.keepBytes) || DEFAULT_KEEP_LOG_BYTES, maxBytes);
    try {
        if (!fs.existsSync(filePath)) return false;
        const stat = fs.statSync(filePath);
        if (stat.size <= maxBytes) return false;
        const bytesToRead = Math.min(keepBytes, stat.size);
        const fd = fs.openSync(filePath, 'r');
        const buffer = Buffer.alloc(bytesToRead);
        try {
            fs.readSync(fd, buffer, 0, bytesToRead, stat.size - bytesToRead);
        } finally {
            fs.closeSync(fd);
        }
        let tail = buffer.toString('utf8');
        const firstLineEnd = tail.indexOf('\n');
        if (firstLineEnd >= 0) tail = tail.slice(firstLineEnd + 1);
        const marker = `[LOG ROTATED ${new Date().toISOString()}]\n`;
        fs.writeFileSync(filePath, `${marker}${tail}`, 'utf8');
        return true;
    } catch (_) {
        return false;
    }
}

function scrubLogFile(filePath) {
    try {
        if (!fs.existsSync(filePath)) return false;
        const original = fs.readFileSync(filePath, 'utf8');
        const scrubbed = redactSensitiveText(original);
        if (scrubbed === original) return false;
        fs.writeFileSync(filePath, scrubbed, 'utf8');
        return true;
    } catch (_) {
        return false;
    }
}

module.exports = {
    DEFAULT_KEEP_LOG_BYTES,
    DEFAULT_MAX_LOG_BYTES,
    redactSensitiveText,
    rotateLogIfNeeded,
    scrubLogFile,
};
