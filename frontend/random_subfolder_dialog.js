'use strict';

// Dialogo "¿Incluir tambien las subcarpetas?" para carpetas aleatorias.
// Reutiliza las clases de modal/botones existentes (.modal-overlay,
// .modal-content, .settings-btn) y los colores verde/rojo del resto de la app.
// Devuelve { recursive, remember }.

function askIncludeSubfolders(folderName = '') {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.tabIndex = -1;

        const content = document.createElement('div');
        content.className = 'modal-content';
        content.style.maxWidth = '420px';
        content.style.gap = '14px';

        const title = document.createElement('div');
        title.style.fontSize = '15px';
        title.style.fontWeight = 'bold';
        title.style.color = '#fff';
        title.textContent = '¿Desea incluir también las subcarpetas?';

        const subtitle = document.createElement('div');
        subtitle.style.fontSize = '12px';
        subtitle.style.color = '#aaa';
        subtitle.textContent = folderName
            ? `Carpeta aleatoria: ${folderName}`
            : 'Carpeta aleatoria';

        const rememberRow = document.createElement('label');
        rememberRow.style.display = 'flex';
        rememberRow.style.alignItems = 'center';
        rememberRow.style.gap = '8px';
        rememberRow.style.fontSize = '12px';
        rememberRow.style.color = '#ccc';
        rememberRow.style.cursor = 'pointer';
        const remember = document.createElement('input');
        remember.type = 'checkbox';
        remember.checked = false;
        const rememberText = document.createElement('span');
        rememberText.textContent = 'No volver a preguntar';
        rememberRow.appendChild(remember);
        rememberRow.appendChild(rememberText);

        const hint = document.createElement('div');
        hint.style.fontSize = '11px';
        hint.style.color = '#6f6f73';
        hint.style.lineHeight = '1.4';
        hint.textContent = 'Podrás cambiar esta preferencia en cualquier momento desde Herramientas → Reglas de separación musical.';

        const buttons = document.createElement('div');
        buttons.style.display = 'flex';
        buttons.style.justifyContent = 'flex-end';
        buttons.style.gap = '10px';

        const btnNo = document.createElement('button');
        btnNo.className = 'settings-btn';
        btnNo.textContent = 'No';
        btnNo.style.background = '#c0392b';
        btnNo.style.borderColor = '#c0392b';

        const btnYes = document.createElement('button');
        btnYes.className = 'settings-btn';
        btnYes.textContent = 'Sí';
        btnYes.style.background = '#27ae60';
        btnYes.style.borderColor = '#27ae60';

        buttons.appendChild(btnNo);
        buttons.appendChild(btnYes);

        content.appendChild(title);
        content.appendChild(subtitle);
        content.appendChild(rememberRow);
        content.appendChild(hint);
        content.appendChild(buttons);
        overlay.appendChild(content);
        document.body.appendChild(overlay);

        let settled = false;
        const close = recursive => {
            if (settled) return;
            settled = true;
            const rememberChoice = remember.checked === true;
            document.removeEventListener('keydown', onKey, true);
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            resolve({ recursive, remember: rememberChoice });
        };

        const onKey = event => {
            if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); close(false); }
            else if (event.key === 'Enter') { event.stopPropagation(); event.preventDefault(); close(true); }
        };

        btnYes.addEventListener('click', () => close(true));
        btnNo.addEventListener('click', () => close(false));
        overlay.addEventListener('mousedown', event => { if (event.target === overlay) close(false); });
        document.addEventListener('keydown', onKey, true);
        btnYes.focus();
    });
}

module.exports = { askIncludeSubfolders };
