'use strict';

// patch_locales.js — Inyecta las claves de texto del "Gestor de Tipos de
// Archivo" y del mini-modal de asignacion en los 4 archivos de /locales.
// Usa exclusivamente fs.readFileSync + JSON.parse + JSON.stringify para no
// corromper el JSON (nada de sed/regex de terminal). Es idempotente: solo
// rellena claves que falten, conservando las traducciones existentes.

const fs = require('fs');
const path = require('path');

const LOCALES_DIR = path.join(__dirname, 'locales');

const patches = {
    es: {
        menu: { file_types_manager: 'Gestor de tipos de archivos' },
        modals: {
            assign_type: {
                title: 'Asignar tipo de archivo',
                title_modify: 'Modificar asignación',
                include_subfolders: '¿Incluir subcarpetas?',
                ignore_separation: '¿Ignorar las reglas de separación musical?',
                save_history: '¿Guardar en el historial de reproducción?',
                cancel: 'Cancelar',
                accept: 'Aceptar',
                items_count: '{count} elementos'
            }
        },
        file_types_manager: {
            title_window: 'Gestor de Tipos de Archivo - LF Automatizador',
            title_main: '🗂️ Gestor de Tipos de Archivo',
            subtitle: 'Asocia carpetas y archivos a cada tipo para aplicarles color, separación e historial automáticos.',
            types_title: 'Tipos de Archivo',
            add_type: 'Añadir tipo',
            del_type: 'Eliminar tipo seleccionado',
            props_title: 'Propiedades del Tipo',
            prop_name: 'Nombre:',
            prop_identifier: 'Identificador:',
            prop_color: 'Color (Lista):',
            assign_title: 'Carpetas y Archivos Asignados',
            add_folder: '📁 Añadir carpeta',
            add_file: '🎵 Añadir archivo',
            modify: 'Modificar',
            delete: 'Eliminar',
            th_path: 'Ruta',
            th_kind: 'Tipo',
            th_subfolders: 'Subcarpetas',
            th_ignore_sep: 'Ignora sep.',
            th_history: 'Historial',
            empty_assign: 'Este tipo no tiene carpetas ni archivos asignados. Usa los botones de arriba para añadir.',
            btn_cancel: 'Cancelar',
            btn_apply: 'Aplicar',
            btn_accept: 'Aceptar y Cerrar',
            yes: 'Sí',
            no: 'No',
            kind_folder: 'Carpeta',
            kind_file: 'Archivo',
            pick_folder_title: 'Seleccionar carpeta',
            pick_file_title: 'Seleccionar archivo de audio',
            confirm_delete_assign: '¿Eliminar la asignación seleccionada?',
            confirm_delete_type: '¿Eliminar el tipo "{name}" y sus asignaciones?',
            new_type: 'Nuevo Tipo',
            migrate_notice: 'Hay {count} carpeta(s)/archivo(s) con tipo asignado de antes que aún no tienen configuración. ¿Revisarlos ahora?',
            migrate_review: 'Revisar',
            migrate_dismiss: 'Ahora no',
            pending_hint: 'Pendiente de configurar'
        }
    },
    en: {
        menu: { file_types_manager: 'File Type Manager' },
        modals: {
            assign_type: {
                title: 'Assign file type',
                title_modify: 'Modify assignment',
                include_subfolders: 'Include subfolders?',
                ignore_separation: 'Ignore music separation rules?',
                save_history: 'Save to playback history?',
                cancel: 'Cancel',
                accept: 'Accept',
                items_count: '{count} items'
            }
        },
        file_types_manager: {
            title_window: 'File Type Manager - LF Automatizador',
            title_main: '🗂️ File Type Manager',
            subtitle: 'Associate folders and files with each type to apply color, separation and history automatically.',
            types_title: 'File Types',
            add_type: 'Add type',
            del_type: 'Delete selected type',
            props_title: 'Type Properties',
            prop_name: 'Name:',
            prop_identifier: 'Identifier:',
            prop_color: 'Color (List):',
            assign_title: 'Assigned Folders and Files',
            add_folder: '📁 Add folder',
            add_file: '🎵 Add file',
            modify: 'Modify',
            delete: 'Delete',
            th_path: 'Path',
            th_kind: 'Kind',
            th_subfolders: 'Subfolders',
            th_ignore_sep: 'Ignore sep.',
            th_history: 'History',
            empty_assign: 'This type has no folders or files assigned. Use the buttons above to add some.',
            btn_cancel: 'Cancel',
            btn_apply: 'Apply',
            btn_accept: 'Accept & Close',
            yes: 'Yes',
            no: 'No',
            kind_folder: 'Folder',
            kind_file: 'File',
            pick_folder_title: 'Select folder',
            pick_file_title: 'Select audio file',
            confirm_delete_assign: 'Delete the selected assignment?',
            confirm_delete_type: 'Delete the type "{name}" and its assignments?',
            new_type: 'New Type',
            migrate_notice: 'There are {count} folder(s)/file(s) typed earlier that are not configured yet. Review them now?',
            migrate_review: 'Review',
            migrate_dismiss: 'Not now',
            pending_hint: 'Pending configuration'
        }
    },
    'pt-BR': {
        menu: { file_types_manager: 'Gerenciador de tipos de arquivo' },
        modals: {
            assign_type: {
                title: 'Atribuir tipo de arquivo',
                title_modify: 'Modificar atribuição',
                include_subfolders: 'Incluir subpastas?',
                ignore_separation: 'Ignorar as regras de separação musical?',
                save_history: 'Salvar no histórico de reprodução?',
                cancel: 'Cancelar',
                accept: 'Aceitar',
                items_count: '{count} itens'
            }
        },
        file_types_manager: {
            title_window: 'Gerenciador de Tipos de Arquivo - LF Automatizador',
            title_main: '🗂️ Gerenciador de Tipos de Arquivo',
            subtitle: 'Associe pastas e arquivos a cada tipo para aplicar cor, separação e histórico automaticamente.',
            types_title: 'Tipos de Arquivo',
            add_type: 'Adicionar tipo',
            del_type: 'Excluir tipo selecionado',
            props_title: 'Propriedades do Tipo',
            prop_name: 'Nome:',
            prop_identifier: 'Identificador:',
            prop_color: 'Cor (Lista):',
            assign_title: 'Pastas e Arquivos Atribuídos',
            add_folder: '📁 Adicionar pasta',
            add_file: '🎵 Adicionar arquivo',
            modify: 'Modificar',
            delete: 'Excluir',
            th_path: 'Caminho',
            th_kind: 'Tipo',
            th_subfolders: 'Subpastas',
            th_ignore_sep: 'Ignora sep.',
            th_history: 'Histórico',
            empty_assign: 'Este tipo não tem pastas nem arquivos atribuídos. Use os botões acima para adicionar.',
            btn_cancel: 'Cancelar',
            btn_apply: 'Aplicar',
            btn_accept: 'Aceitar e Fechar',
            yes: 'Sim',
            no: 'Não',
            kind_folder: 'Pasta',
            kind_file: 'Arquivo',
            pick_folder_title: 'Selecionar pasta',
            pick_file_title: 'Selecionar arquivo de áudio',
            confirm_delete_assign: 'Excluir a atribuição selecionada?',
            confirm_delete_type: 'Excluir o tipo "{name}" e suas atribuições?',
            new_type: 'Novo Tipo',
            migrate_notice: 'Há {count} pasta(s)/arquivo(s) com tipo atribuído antes que ainda não têm configuração. Revisar agora?',
            migrate_review: 'Revisar',
            migrate_dismiss: 'Agora não',
            pending_hint: 'Pendente de configuração'
        }
    },
    'pt-PT': {
        menu: { file_types_manager: 'Gestor de tipos de ficheiro' },
        modals: {
            assign_type: {
                title: 'Atribuir tipo de ficheiro',
                title_modify: 'Modificar atribuição',
                include_subfolders: 'Incluir subpastas?',
                ignore_separation: 'Ignorar as regras de separação musical?',
                save_history: 'Guardar no histórico de reprodução?',
                cancel: 'Cancelar',
                accept: 'Aceitar',
                items_count: '{count} itens'
            }
        },
        file_types_manager: {
            title_window: 'Gestor de Tipos de Ficheiro - LF Automatizador',
            title_main: '🗂️ Gestor de Tipos de Ficheiro',
            subtitle: 'Associe pastas e ficheiros a cada tipo para aplicar cor, separação e histórico automaticamente.',
            types_title: 'Tipos de Ficheiro',
            add_type: 'Adicionar tipo',
            del_type: 'Eliminar tipo selecionado',
            props_title: 'Propriedades do Tipo',
            prop_name: 'Nome:',
            prop_identifier: 'Identificador:',
            prop_color: 'Cor (Lista):',
            assign_title: 'Pastas e Ficheiros Atribuídos',
            add_folder: '📁 Adicionar pasta',
            add_file: '🎵 Adicionar ficheiro',
            modify: 'Modificar',
            delete: 'Eliminar',
            th_path: 'Caminho',
            th_kind: 'Tipo',
            th_subfolders: 'Subpastas',
            th_ignore_sep: 'Ignora sep.',
            th_history: 'Histórico',
            empty_assign: 'Este tipo não tem pastas nem ficheiros atribuídos. Use os botões acima para adicionar.',
            btn_cancel: 'Cancelar',
            btn_apply: 'Aplicar',
            btn_accept: 'Aceitar e Fechar',
            yes: 'Sim',
            no: 'Não',
            kind_folder: 'Pasta',
            kind_file: 'Ficheiro',
            pick_folder_title: 'Selecionar pasta',
            pick_file_title: 'Selecionar ficheiro de áudio',
            confirm_delete_assign: 'Eliminar a atribuição selecionada?',
            confirm_delete_type: 'Eliminar o tipo "{name}" e as suas atribuições?',
            new_type: 'Novo Tipo',
            migrate_notice: 'Há {count} pasta(s)/ficheiro(s) com tipo atribuído antes que ainda não têm configuração. Rever agora?',
            migrate_review: 'Rever',
            migrate_dismiss: 'Agora não',
            pending_hint: 'Pendente de configuração'
        }
    }
};

// Rellena solo las claves que falten; nunca pisa traducciones existentes.
function deepFill(target, source) {
    let added = 0;
    for (const key of Object.keys(source)) {
        const sVal = source[key];
        if (sVal && typeof sVal === 'object' && !Array.isArray(sVal)) {
            if (!target[key] || typeof target[key] !== 'object') target[key] = {};
            added += deepFill(target[key], sVal);
        } else if (!(key in target)) {
            target[key] = sVal;
            added++;
        }
    }
    return added;
}

let totalAdded = 0;
for (const locale of Object.keys(patches)) {
    const filePath = path.join(LOCALES_DIR, `${locale}.json`);
    if (!fs.existsSync(filePath)) {
        console.warn(`[patch_locales] No encontrado: ${filePath} (omitido)`);
        continue;
    }
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const added = deepFill(data, patches[locale]);
    // Los locales usan indentacion de 4 espacios y sin salto de linea final.
    fs.writeFileSync(filePath, JSON.stringify(data, null, 4), 'utf-8');
    totalAdded += added;
    console.log(`[patch_locales] ${locale}.json: ${added} clave(s) añadida(s).`);
}
console.log(`[patch_locales] Listo. Total: ${totalAdded} clave(s).`);
