(function () {
    const PLAYING_STATES = new Set(['playing', 'fading', 'buffering', 'connecting']);
    const AUX_PREFIXES = ['aux1-', 'aux2-'];

    function rustPlayers(status) {
        return Array.isArray(status?.players) ? status.players : [];
    }

    function isRustPlayerOnAir(player) {
        const state = String(player?.status || '').toLowerCase();
        return player?.audioReady !== false && PLAYING_STATES.has(state);
    }

    function isAuxiliaryOnAir(status) {
        return rustPlayers(status).some(player => {
            const id = String(player?.id || '');
            return AUX_PREFIXES.some(prefix => id.startsWith(prefix)) && isRustPlayerOnAir(player);
        });
    }

    function isProgramDeckOnAir(status, deckIds = []) {
        const ids = new Set(Array.isArray(deckIds) ? deckIds : []);
        return rustPlayers(status).some(player => ids.has(player?.id) && isRustPlayerOnAir(player));
    }

    function isHtmlPlayerOnAir(players = []) {
        return players.some(player => player && !player.paused && !player.ended);
    }

    window.EventAirState = {
        isAuxiliaryOnAir,
        isProgramDeckOnAir,
        isHtmlPlayerOnAir,
        isRustPlayerOnAir
    };
})();
