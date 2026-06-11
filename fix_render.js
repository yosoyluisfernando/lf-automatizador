const fs = require('fs');

let content = fs.readFileSync('frontend/render.js', 'utf8');

const missingCode = `
window.addEventListener('lf-panel-focus', (e) => {
    if (e.detail && e.detail.panel !== 'main') {
        document.querySelectorAll('.playlist-table tr').forEach(el => el.classList.remove('selected-row'));
        anchorRowIndex = -1;
        lastSelectedRowIndex = -1;
    }
    if (e.detail && e.detail.panel !== 'library-shortcut') {
        if (typeof clearSelection === 'function') clearSelection();
    }
});

window.addEventListener('lf-clear-selections', () => {
    document.querySelectorAll('.playlist-table tr').forEach(el => el.classList.remove('selected-row'));
    anchorRowIndex = -1;
    lastSelectedRowIndex = -1;
    if (typeof clearSelection === 'function') clearSelection();
});
`;

if (!content.includes("window.addEventListener('lf-clear-selections'")) {
    content += missingCode;
}

const targetEmptyClick = `if (playlistSection) {
    playlistSection.addEventListener('click', (e) => {
        if (e.target === playlistSection || e.target.tagName === 'TABLE' || e.target.tagName === 'TBODY') {
            document.querySelectorAll('.playlist-table tr').forEach(el => el.classList.remove('selected-row'));
            lastSelectedRowIndex = -1; anchorRowIndex = -1;
        }
    });
}`;

const replacementEmptyClick = `if (playlistSection) {
    playlistSection.addEventListener('click', (e) => {
        if (e.target === playlistSection || e.target.tagName === 'TABLE' || e.target.tagName === 'TBODY') {
            document.querySelectorAll('.playlist-table tr').forEach(el => el.classList.remove('selected-row'));
            lastSelectedRowIndex = -1; anchorRowIndex = -1;
            window.dispatchEvent(new CustomEvent('lf-clear-selections'));
        }
    });
}`;

content = content.replace(targetEmptyClick, replacementEmptyClick);

fs.writeFileSync('frontend/render.js', content, 'utf8');
console.log('Fixed render.js missing events successfully!');
