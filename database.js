const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { getConfigDir } = require('./backend/utils/app_paths');

// Aseguramos que el directorio config existe
const configDir = getConfigDir(path.join(__dirname, 'config'), __dirname);

function readAppChannel() {
    const channelPath = path.join(configDir, 'app_channel.json');
    const fallback = { channel: 'stable', label: 'Principal', dbFile: 'lf_data.sqlite' };
    try {
        if (!fs.existsSync(channelPath)) return fallback;
        const parsed = JSON.parse(fs.readFileSync(channelPath, 'utf-8'));
        const channel = parsed.channel === 'beta' ? 'beta' : 'stable';
        const safeDbFile = /^[\w.-]+$/.test(parsed.dbFile || '') ? parsed.dbFile : (channel === 'beta' ? 'lf_data.beta.sqlite' : 'lf_data.sqlite');
        return {
            channel,
            label: parsed.label || (channel === 'beta' ? 'Beta' : 'Principal'),
            dbFile: safeDbFile
        };
    } catch (err) {
        return fallback;
    }
}

const appChannel = readAppChannel();
const stableDbPath = path.join(configDir, 'lf_data.sqlite');
const dbPath = path.join(configDir, appChannel.dbFile);

if (appChannel.channel === 'beta' && !fs.existsSync(dbPath) && fs.existsSync(stableDbPath)) {
    fs.copyFileSync(stableDbPath, dbPath);
}

// Inicializamos la base de datos SQLite
const db = new Database(dbPath);
db.appChannel = { ...appChannel, dbPath };
db.dbPath = dbPath;

// Optimizaciones de rendimiento para SQLite en apps de Audio
db.pragma('journal_mode = WAL'); 
db.pragma('synchronous = NORMAL'); 
db.pragma('cache_size = -32000');   // 32 MB de caché en memoria para accesos ultra rápidos
db.pragma('temp_store = MEMORY');  // Tablas temporales en RAM
db.pragma('mmap_size = 314572800'); // 300MB Memory-Mapped I/O para lecturas sin cuello de botella

// VACUUM es costoso en bases grandes; queda como mantenimiento explicito.
// Para ejecuciones de mantenimiento se puede activar con LF_AUTO_VACUUM=true.
function runMaintenanceVacuum() {
    try {
        db.exec('VACUUM');
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
}
db.runMaintenanceVacuum = runMaintenanceVacuum;
if (process.env.LF_AUTO_VACUUM === 'true') runMaintenanceVacuum();

// WAL checkpoint automático cada 30 minutos
const WAL_CHECKPOINT_INTERVAL_MS = 30 * 60 * 1000;
let _walCheckpointTimer = null;
function startWalCheckpointSchedule() {
    if (_walCheckpointTimer) return;
    _walCheckpointTimer = setInterval(() => {
        try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) {}
    }, WAL_CHECKPOINT_INTERVAL_MS);
    // No impedir que el proceso cierre si solo queda este timer
    if (_walCheckpointTimer.unref) _walCheckpointTimer.unref();
}
startWalCheckpointSchedule();


// ============================================================================
// CREACIÓN DE TABLAS
// ============================================================================
function initDB() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS tracks (
            file_path TEXT PRIMARY KEY, custom_title TEXT, custom_artist TEXT, album TEXT, year TEXT, genre TEXT,
            inicio REAL, intro REAL, mix REAL, outro REAL, fin REAL,
            p1_active INTEGER, p1_mode TEXT, p1_time TEXT, p1_file TEXT,
            p2_active INTEGER, p2_mode TEXT, p2_time TEXT, p2_file TEXT,
            p3_active INTEGER, p3_mode TEXT, p3_time TEXT, p3_file TEXT,
            phora_active INTEGER, phora_mode TEXT, phora_time TEXT,
            db REAL, bpm REAL, duration REAL, file_size INTEGER, file_mtime_ms INTEGER
        )
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS event_groups (
            id TEXT PRIMARY KEY, name TEXT, color_bg TEXT, color_text TEXT, is_readonly INTEGER
        )
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS commercial_blocks (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            mode TEXT DEFAULT 'basic',
            enabled INTEGER DEFAULT 1,
            priority TEXT DEFAULT 'normal',
            action TEXT DEFAULT 'temp',
            execution TEXT DEFAULT 'wait',
            primary_time TEXT,
            repeat_active INTEGER DEFAULT 0,
            repeat_interval INTEGER DEFAULT 0,
            repeat_unit TEXT DEFAULT 'minutes',
            validity_start TEXT,
            validity_end TEXT,
            notes TEXT,
            created_at TEXT,
            updated_at TEXT
        );

        CREATE TABLE IF NOT EXISTS commercial_block_items (
            id TEXT PRIMARY KEY,
            block_id TEXT NOT NULL,
            sort_order INTEGER DEFAULT 0,
            source_type TEXT DEFAULT 'file',
            file_path TEXT NOT NULL,
            title TEXT,
            duration REAL,
            temp INTEGER DEFAULT 1,
            created_at TEXT,
            updated_at TEXT,
            FOREIGN KEY(block_id) REFERENCES commercial_blocks(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_commercial_blocks_time ON commercial_blocks(primary_time);
        CREATE INDEX IF NOT EXISTS idx_commercial_items_block ON commercial_block_items(block_id, sort_order);

        CREATE TABLE IF NOT EXISTS commercial_assets (
            file_path TEXT PRIMARY KEY,
            title TEXT,
            root_type TEXT DEFAULT 'commercials',
            category TEXT DEFAULT 'paid',
            commercial_type TEXT DEFAULT 'paid',
            billing_mode TEXT DEFAULT 'paid',
            client_name TEXT,
            campaign_name TEXT,
            contract_code TEXT,
            folder_path TEXT,
            duration REAL,
            enabled INTEGER DEFAULT 1,
            status TEXT DEFAULT 'draft',
            entered_at TEXT,
            first_air_at TEXT,
            validity_start TEXT,
            validity_end TEXT,
            last_aired_at TEXT,
            air_count INTEGER DEFAULT 0,
            rotation_weight INTEGER DEFAULT 1,
            commercial_priority TEXT DEFAULT 'normal',
            daily_limit INTEGER DEFAULT 0,
            separation_rule TEXT DEFAULT 'category',
            frequency_rule TEXT DEFAULT 'manual',
            copy_notes TEXT,
            traffic_notes TEXT,
            notes TEXT,
            created_at TEXT,
            updated_at TEXT
        );

        CREATE TABLE IF NOT EXISTS commercial_categories (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            color TEXT DEFAULT '#00a8ff',
            is_builtin INTEGER DEFAULT 0,
            sort_order INTEGER DEFAULT 0,
            created_at TEXT,
            updated_at TEXT
        );

        CREATE TABLE IF NOT EXISTS commercial_logs (
            id TEXT PRIMARY KEY,
            asset_path TEXT,
            block_id TEXT,
            event_id TEXT,
            action TEXT,
            message TEXT,
            at TEXT,
            meta_json TEXT
        );

        CREATE TABLE IF NOT EXISTS commercial_settings (
            key TEXT PRIMARY KEY,
            value TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_commercial_assets_category ON commercial_assets(category);
        CREATE INDEX IF NOT EXISTS idx_commercial_assets_root ON commercial_assets(root_type, folder_path);
        CREATE INDEX IF NOT EXISTS idx_commercial_logs_asset ON commercial_logs(asset_path, at);
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS events (
            id TEXT PRIMARY KEY, name TEXT, group_id TEXT, source_type TEXT, file_path TEXT,
            primary_time TEXT, other_hours TEXT, day_mode TEXT, specific_days TEXT, target_weeks TEXT,
            validity_start TEXT, validity_end TEXT, action TEXT, execution TEXT, priority TEXT DEFAULT 'normal', color_text TEXT, color_bg TEXT,
            require_playing INTEGER, max_delay_active INTEGER, max_delay_minutes INTEGER, max_delay_seconds INTEGER,
            max_delay_time INTEGER, max_delay_action TEXT, cyclic_active INTEGER, cyclic_interval INTEGER,
            cyclic_unit TEXT, cyclic_limit INTEGER, last_fired TEXT
        )
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS schedule_programs (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            host TEXT,
            style TEXT DEFAULT 'musical',
            day_mode TEXT DEFAULT 'specific',
            specific_days TEXT DEFAULT '[]',
            start_time TEXT NOT NULL,
            end_time TEXT NOT NULL,
            color_bg TEXT DEFAULT '#34495e',
            color_text TEXT DEFAULT '#ffffff',
            notes TEXT,
            enabled INTEGER DEFAULT 1,
            sort_order INTEGER DEFAULT 0,
            created_at TEXT,
            updated_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_schedule_programs_time ON schedule_programs(start_time);
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS artist_profiles (
            artist_key TEXT PRIMARY KEY,
            display_name TEXT,
            habitual_genre TEXT,
            habitual_genres_json TEXT,
            country TEXT,
            country_code TEXT,
            energy_hint INTEGER,
            notes TEXT,
            updated_at TEXT
        );

        CREATE TABLE IF NOT EXISTS artist_aliases (
            alias_key TEXT PRIMARY KEY,
            artist_key TEXT,
            display_name TEXT,
            updated_at TEXT
        );

        CREATE TABLE IF NOT EXISTS genre_profiles (
            genre_key TEXT PRIMARY KEY,
            display_name TEXT,
            parent_genre TEXT,
            energy_level INTEGER,
            compatible_genres TEXT,
            bridge_genres TEXT,
            updated_at TEXT
        );

        CREATE TABLE IF NOT EXISTS genre_aliases (
            alias_key TEXT PRIMARY KEY,
            genre_key TEXT,
            display_name TEXT,
            updated_at TEXT
        );

        CREATE TABLE IF NOT EXISTS track_artist_links (
            file_path TEXT,
            artist_key TEXT,
            role TEXT,
            display_name TEXT,
            position INTEGER,
            PRIMARY KEY (file_path, artist_key, role)
        );

        -- Índice para JOIN WHERE role = 'main' en lib-get-full-db y consultas de país
        CREATE INDEX IF NOT EXISTS idx_tal_role_artist ON track_artist_links(role, artist_key);
        -- Índice para consultas por artista (catálogo, card, artistas de un track)
        CREATE INDEX IF NOT EXISTS idx_tal_artist_key ON track_artist_links(artist_key);

        CREATE TABLE IF NOT EXISTS track_genre_links (
            file_path TEXT,
            genre_key TEXT,
            role TEXT,
            confidence REAL,
            source TEXT,
            PRIMARY KEY (file_path, genre_key, role)
        );

        -- Índice para consultas por género en sincronización y editor de géneros
        CREATE INDEX IF NOT EXISTS idx_tgl_genre_key ON track_genre_links(genre_key);

        CREATE TABLE IF NOT EXISTS library_virtual_folders (
            id TEXT PRIMARY KEY,
            name TEXT,
            parent_id TEXT,
            source_path TEXT,
            genre_key TEXT,
            depth INTEGER,
            sort_order INTEGER,
            updated_at TEXT
        );

        CREATE TABLE IF NOT EXISTS country_profiles (
            country_code TEXT PRIMARY KEY,
            display_name TEXT,
            search_aliases TEXT,
            updated_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_artist_profiles_genre ON artist_profiles(habitual_genre);
        CREATE INDEX IF NOT EXISTS idx_genre_profiles_parent ON genre_profiles(parent_genre);
        CREATE INDEX IF NOT EXISTS idx_genre_aliases_genre ON genre_aliases(genre_key);
        CREATE INDEX IF NOT EXISTS idx_track_artist_links_artist ON track_artist_links(artist_key);
        CREATE INDEX IF NOT EXISTS idx_track_genre_links_genre ON track_genre_links(genre_key);
        CREATE INDEX IF NOT EXISTS idx_virtual_folders_parent ON library_virtual_folders(parent_id);
        CREATE INDEX IF NOT EXISTS idx_country_profiles_name ON country_profiles(display_name);
    `);
}

function ensureColumn(table, columnDefinition) {
    try {
        db.prepare(`ALTER TABLE ${table} ADD COLUMN ${columnDefinition}`).run();
    } catch (err) {}
}

function ensureMetadataSchema() {
    [
        'feat TEXT',
        'is_remix INTEGER DEFAULT 0',
        'peak_db TEXT',
        'file_size INTEGER',
        'file_mtime_ms INTEGER',
        'artists_json TEXT',
        'genres_json TEXT',
        'primary_genre TEXT',
        'subgenre TEXT',
        'subgenres_csv TEXT',
        'is_unusual_genre INTEGER DEFAULT 0',
        'genre_confidence REAL',
        'genre_source TEXT',
        'energy_level INTEGER',
        'mood TEXT',
        'folder_genre_path TEXT',
        'metadata_locked INTEGER DEFAULT 0',
        'metadata_updated_at TEXT'
    ].forEach(columnDefinition => ensureColumn('tracks', columnDefinition));
}

function ensureProfileSchema() {
    [
        'country TEXT',
        'country_code TEXT',
        'artist_type TEXT',
        'nationalities TEXT',
        'main_genre_key TEXT',
        'subgenres_csv TEXT',
        'biography TEXT',
        'photo_url TEXT',
        'photo_local_path TEXT',
        'external_source TEXT',
        'external_id TEXT',
        'metadata_fetched_at TEXT'
    ].forEach(columnDefinition => ensureColumn('artist_profiles', columnDefinition));
    db.prepare("CREATE INDEX IF NOT EXISTS idx_artist_profiles_country ON artist_profiles(country_code)").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_artist_profiles_main_genre ON artist_profiles(main_genre_key)").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_artist_profiles_external ON artist_profiles(external_source, external_id)").run();
}

function ensureGenreCurationSchema() {
    [
        "color_hex TEXT DEFAULT '#00a8ff'",
        "mood_energy TEXT DEFAULT 'media'",
        'search_anchors_csv TEXT',
        'sort_order INTEGER DEFAULT 0',
        'is_active INTEGER DEFAULT 1',
        "tipo TEXT DEFAULT 'sin_identificar'"
    ].forEach(columnDefinition => ensureColumn('genre_profiles', columnDefinition));

    db.exec(`
        CREATE TABLE IF NOT EXISTS relacion_generos (
            id_padre TEXT,
            id_subgenero TEXT,
            PRIMARY KEY (id_padre, id_subgenero),
            FOREIGN KEY(id_padre) REFERENCES genre_profiles(genre_key) ON DELETE CASCADE,
            FOREIGN KEY(id_subgenero) REFERENCES genre_profiles(genre_key) ON DELETE CASCADE
        );
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_genre_profiles_active_parent
        ON genre_profiles(is_active, parent_genre);

        CREATE INDEX IF NOT EXISTS idx_tracks_subgenres_csv
        ON tracks(subgenres_csv);
    `);
}

function ensureEventSchema() {
    [
        "priority TEXT DEFAULT 'normal'"
    ].forEach(columnDefinition => ensureColumn('events', columnDefinition));
}

function ensureCommercialSchema() {
    [
        "mode TEXT DEFAULT 'basic'",
        'enabled INTEGER DEFAULT 1',
        "priority TEXT DEFAULT 'normal'",
        "action TEXT DEFAULT 'temp'",
        "execution TEXT DEFAULT 'wait'",
        'primary_time TEXT',
        'repeat_active INTEGER DEFAULT 0',
        'repeat_interval INTEGER DEFAULT 0',
        "repeat_unit TEXT DEFAULT 'minutes'",
        'validity_start TEXT',
        'validity_end TEXT',
        'notes TEXT',
        'created_at TEXT',
        'updated_at TEXT'
    ].forEach(columnDefinition => ensureColumn('commercial_blocks', columnDefinition));
    [
        "source_type TEXT DEFAULT 'file'",
        'duration REAL',
        'temp INTEGER DEFAULT 1',
        'created_at TEXT',
        'updated_at TEXT'
    ].forEach(columnDefinition => ensureColumn('commercial_block_items', columnDefinition));
    [
        "root_type TEXT DEFAULT 'commercials'",
        "category TEXT DEFAULT 'paid'",
        "commercial_type TEXT DEFAULT 'paid'",
        "billing_mode TEXT DEFAULT 'paid'",
        'client_name TEXT',
        'campaign_name TEXT',
        'contract_code TEXT',
        'folder_path TEXT',
        'duration REAL',
        'enabled INTEGER DEFAULT 1',
        "status TEXT DEFAULT 'draft'",
        'entered_at TEXT',
        'first_air_at TEXT',
        'validity_start TEXT',
        'validity_end TEXT',
        'last_aired_at TEXT',
        'air_count INTEGER DEFAULT 0',
        'rotation_weight INTEGER DEFAULT 1',
        "commercial_priority TEXT DEFAULT 'normal'",
        'daily_limit INTEGER DEFAULT 0',
        "separation_rule TEXT DEFAULT 'category'",
        "frequency_rule TEXT DEFAULT 'manual'",
        'copy_notes TEXT',
        'traffic_notes TEXT',
        'notes TEXT',
        'created_at TEXT',
        'updated_at TEXT'
    ].forEach(columnDefinition => ensureColumn('commercial_assets', columnDefinition));
    db.exec(`
        CREATE TABLE IF NOT EXISTS commercial_categories (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            color TEXT DEFAULT '#00a8ff',
            is_builtin INTEGER DEFAULT 0,
            sort_order INTEGER DEFAULT 0,
            created_at TEXT,
            updated_at TEXT
        );
        CREATE TABLE IF NOT EXISTS commercial_logs (
            id TEXT PRIMARY KEY,
            asset_path TEXT,
            block_id TEXT,
            event_id TEXT,
            action TEXT,
            message TEXT,
            at TEXT,
            meta_json TEXT
        );
    `);
    db.prepare('CREATE INDEX IF NOT EXISTS idx_commercial_blocks_time ON commercial_blocks(primary_time)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_commercial_items_block ON commercial_block_items(block_id, sort_order)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_commercial_assets_category ON commercial_assets(category)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_commercial_assets_root ON commercial_assets(root_type, folder_path)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_commercial_assets_validity ON commercial_assets(validity_start, validity_end)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_commercial_logs_asset ON commercial_logs(asset_path, at)').run();
}

function seedCommercialCategories() {
    const now = new Date().toISOString();
    const categories = [
        ['paid', 'Publicidad pagada', '#2ecc71', 1],
        ['unpaid', 'No pagada / cortesia', '#95a5a6', 2],
        ['station_promo', 'Promocion emisora', '#00a8ff', 3],
        ['temporary', 'Publicidad temporal', '#f39c12', 4],
        ['sponsorship', 'Patrocinio', '#9b59b6', 5],
        ['psa', 'Servicio publico', '#1abc9c', 6],
        ['jingle', 'Jingle emisora', '#3498db', 7],
        ['legal_id', 'Identificacion legal', '#e67e22', 8],
        ['sweep', 'Cortina / sweep', '#e84393', 9],
        ['other', 'Otro', '#7f8c8d', 99]
    ];
    const stmt = db.prepare(`
        INSERT INTO commercial_categories (id, name, color, is_builtin, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            color = excluded.color,
            is_builtin = 1,
            sort_order = excluded.sort_order,
            updated_at = excluded.updated_at
    `);
    db.transaction((items) => {
        for (const [id, name, color, sortOrder] of items) stmt.run(id, name, color, sortOrder, now, now);
    })(categories);
}

function seedDefaultCountries() {
    const now = new Date().toISOString();
    const countries = [
        ['DO', 'Republica Dominicana', ['Dominicana', 'RD', 'DR']],
        ['PR', 'Puerto Rico', ['Boricua']],
        ['VE', 'Venezuela', []],
        ['CO', 'Colombia', []],
        ['CU', 'Cuba', []],
        ['MX', 'Mexico', []],
        ['PA', 'Panama', []],
        ['PE', 'Peru', []],
        ['EC', 'Ecuador', []],
        ['CL', 'Chile', []],
        ['AR', 'Argentina', []],
        ['UY', 'Uruguay', []],
        ['PY', 'Paraguay', []],
        ['BO', 'Bolivia', []],
        ['CR', 'Costa Rica', []],
        ['NI', 'Nicaragua', []],
        ['HN', 'Honduras', []],
        ['SV', 'El Salvador', []],
        ['GT', 'Guatemala', []],
        ['BZ', 'Belice', ['Belize']],
        ['US', 'Estados Unidos', ['USA', 'United States']],
        ['ES', 'Espana', ['Spain']],
        ['BR', 'Brasil', ['Brazil']],
        ['HT', 'Haiti', []],
        ['JM', 'Jamaica', []],
        ['TT', 'Trinidad y Tobago', []],
        ['CW', 'Curazao', ['Curacao']],
        ['AW', 'Aruba', []],
        ['BQ', 'Bonaire', []],
        ['GP', 'Guadalupe', []],
        ['MQ', 'Martinica', []],
        ['FR', 'Francia', []],
        ['IT', 'Italia', []],
        ['PT', 'Portugal', []],
        ['GB', 'Reino Unido', ['UK', 'Inglaterra']],
        ['CA', 'Canada', []],
        ['NG', 'Nigeria', []]
    ];
    const stmt = db.prepare(`
        INSERT INTO country_profiles (country_code, display_name, search_aliases, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(country_code) DO UPDATE SET
            display_name = excluded.display_name,
            search_aliases = excluded.search_aliases,
            updated_at = excluded.updated_at
    `);
    db.transaction((items) => {
        for (const [code, name, aliases] of items) {
            stmt.run(code, name, JSON.stringify(aliases || []), now);
        }
    })(countries);
}

// ============================================================================
// MIGRACIÓN AUTOMÁTICA (Rescate de JSONs)
// ============================================================================
function migrateDataFromJSON() {
    const tracksCount = db.prepare("SELECT count(*) as count FROM tracks").get().count;
    
    if (tracksCount === 0) {
        console.log("[BD] Base de datos vacía. Iniciando migración de rescate desde JSON...");
        
        // 1. MIGRAR PISTAS
        const manualCuesPath = path.join(configDir, 'manual_cues.json');
        const cachePathRoot = path.join(__dirname, 'track_cache.json');
        let cuesData = {}; let cacheData = {};
        
        if (fs.existsSync(manualCuesPath)) { try { cuesData = JSON.parse(fs.readFileSync(manualCuesPath, 'utf-8')); } catch(e) {} }
        if (fs.existsSync(cachePathRoot)) { try { cacheData = JSON.parse(fs.readFileSync(cachePathRoot, 'utf-8')); } catch(e) {} }

        const allPaths = new Set([...Object.keys(cuesData), ...Object.keys(cacheData)]);
        
        const insertTrack = db.prepare(`
            INSERT OR IGNORE INTO tracks (
                file_path, custom_title, custom_artist, album, year, genre, inicio, intro, mix, outro, fin,
                p1_active, p1_mode, p1_time, p1_file, p2_active, p2_mode, p2_time, p2_file,
                p3_active, p3_mode, p3_time, p3_file, phora_active, phora_mode, phora_time, db, bpm, duration
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `);

        db.transaction((paths) => {
            for (let fp of paths) {
                const mc = cuesData[fp] || {};
                const tc = cacheData[fp] || {};
                const parseNum = (val) => (val !== '' && val !== null && val !== undefined && !isNaN(val)) ? parseFloat(val) : null;
                
                insertTrack.run(
                    fp, mc.customTitle || null, mc.customArtist || null, mc.album || null, mc.year || null, mc.genre || null,
                    parseNum(mc.inicio), parseNum(mc.intro), parseNum(mc.mix) || parseNum(tc.mixDuration), parseNum(mc.outro), parseNum(mc.fin),
                    mc.p1_active ? 1 : 0, mc.p1_mode || 'start', mc.p1_time || null, mc.p1_file || null,
                    mc.p2_active ? 1 : 0, mc.p2_mode || 'start', mc.p2_time || null, mc.p2_file || null,
                    mc.p3_active ? 1 : 0, mc.p3_mode || 'start', mc.p3_time || null, mc.p3_file || null,
                    mc.phora_active ? 1 : 0, mc.phora_mode || 'start', mc.phora_time || null,
                    parseNum(mc.db) || parseNum(tc.targetDb), parseNum(mc.bpm), parseNum(tc.duration)
                );
            }
        })(allPaths);

        // 2. MIGRAR GRUPOS
        const groupsPath = path.join(configDir, 'event_groups.json');
        if (fs.existsSync(groupsPath)) {
            try {
                const groups = JSON.parse(fs.readFileSync(groupsPath, 'utf-8'));
                const insertGroup = db.prepare(`INSERT OR IGNORE INTO event_groups (id, name, color_bg, color_text, is_readonly) VALUES (?, ?, ?, ?, ?)`);
                db.transaction((grps) => {
                    for (let g of grps) insertGroup.run(g.id, g.name, g.colorBg, g.colorText, g.readonly ? 1 : 0);
                })(groups);
            } catch(e) {}
        } else {
            db.prepare(`INSERT OR IGNORE INTO event_groups (id, name, color_bg, color_text, is_readonly) VALUES (?, ?, ?, ?, ?)`).run('g_general', 'General', '#222225', '#00a8ff', 1);
        }

        // 3. MIGRAR EVENTOS
        const eventsPath = path.join(configDir, 'events_db.json');
        if (fs.existsSync(eventsPath)) {
            try {
                const events = JSON.parse(fs.readFileSync(eventsPath, 'utf-8'));
                const insertEvent = db.prepare(`
                    INSERT OR IGNORE INTO events (
                        id, name, group_id, source_type, file_path, primary_time, other_hours, day_mode, specific_days, target_weeks,
                        validity_start, validity_end, action, execution, priority, color_text, color_bg, require_playing,
                        max_delay_active, max_delay_minutes, max_delay_seconds, max_delay_time, max_delay_action,
                        cyclic_active, cyclic_interval, cyclic_unit, cyclic_limit, last_fired
                    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                `);
                
                db.transaction((evts) => {
                    for (let ev of evts) {
                        insertEvent.run(
                            ev.id, ev.name, ev.group || 'g_general', ev.sourceType || 'file', ev.filePath || '',
                            ev.primaryTime, JSON.stringify(ev.otherHours || []), ev.dayMode || 'daily', 
                            JSON.stringify(ev.specificDays || []), JSON.stringify(ev.targetWeeks || []), 
                            ev.validityStart || null, ev.validityEnd || null, ev.action || 'add', ev.execution || 'interrupt', ev.priority || 'normal',
                            ev.colorText || '#ffffff', ev.colorBg || '#1a1a1c', ev.requirePlaying ? 1 : 0, 
                            ev.maxDelayActive ? 1 : 0, ev.maxDelayMinutes || 0, ev.maxDelaySeconds || 0, ev.maxDelayTime || 0, ev.maxDelayAction || 'omit',
                            ev.cyclicActive ? 1 : 0, ev.cyclicInterval || 0, ev.cyclicUnit || 'minutes', ev.cyclicLimit || 0, ev.lastFired || null
                        );
                    }
                })(events);
            } catch(e) {}
        }
        console.log("[BD] Migración inicial completada con éxito.");
    }
}

initDB();
ensureMetadataSchema();
ensureProfileSchema();
ensureGenreCurationSchema();
ensureEventSchema();
ensureCommercialSchema();
seedCommercialCategories();
seedDefaultCountries();
migrateDataFromJSON();

function migrateGenreTypes() {
    // Solo ejecutar esta migración UNA VEZ — no en cada reinicio
    const migrated = db.prepare("SELECT value FROM app_settings WHERE key = 'genre_types_migrated'").get();
    if (migrated) return;

    // Solo asignar sin_identificar a los que genuinamente no tienen tipo
    const result = db.prepare("UPDATE genre_profiles SET tipo = 'sin_identificar' WHERE tipo IS NULL OR tipo = ''").run();
    if (result.changes > 0) {
        console.log(`[BD] Migrados ${result.changes} géneros sin tipo a 'sin_identificar'.`);
    }

    // Marcar como completada para que no se repita
    const now = new Date().toISOString();
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('genre_types_migrated', '1', ?)").run(now);
}
migrateGenreTypes();


// Exportar función de checkpoint para uso externo (ej. cierre de app)
db.walCheckpoint = () => { try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) {} };

module.exports = db;
