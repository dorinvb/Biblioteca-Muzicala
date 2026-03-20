/* ═══════════════════════════════════════════════════════════════
   BIBLIOTECA MUZICALĂ — database/map.js
   Registrul central al genurilor și subgenurilor
   Format: window.musicMap
═══════════════════════════════════════════════════════════════ */

window.musicMap = {
    rock: {
        label: 'Rock',
        emoji: '🎸',
        subgenuri: {
            'classic-rock':  { label: 'Classic Rock',   emoji: '🎵' },
            'hard-rock':     { label: 'Hard Rock',       emoji: '🔥' },
            'alternative':   { label: 'Alternative',     emoji: '🌀' },
            'punk':          { label: 'Punk',             emoji: '⚡' },
        }
    },
    jazz: {
        label: 'Jazz',
        emoji: '🎷',
        subgenuri: {
            'jazz-vocal':    { label: 'Jazz Vocal',       emoji: '🎤' },
            'bebop':         { label: 'Bebop & Cool',     emoji: '🎺' },
            'smooth-jazz':   { label: 'Smooth Jazz',      emoji: '🌙' },
            'fusion':        { label: 'Jazz Fusion',      emoji: '🔀' },
        }
    },
    blues: {
        label: 'Blues',
        emoji: '🎻',
        subgenuri: {
            'blues-rock':    { label: 'Blues Rock',       emoji: '🔊' },
            'delta-blues':   { label: 'Delta Blues',      emoji: '🌿' },
            'chicago-blues': { label: 'Chicago Blues',    emoji: '🏙️' },
        }
    },
    soul: {
        label: 'Soul / R&B',
        emoji: '🎤',
        subgenuri: {
            'neo-soul':      { label: 'Neo Soul / R&B',   emoji: '💛' },
            'soul':          { label: 'Soul Clasic',      emoji: '🎶' },
            'funk':          { label: 'Funk',             emoji: '🕺' },
        }
    },
    country: {
        label: 'Country',
        emoji: '🤠',
        subgenuri: {
            'contemporary':    { label: 'Country Contemporan', emoji: '🌾' },
            'classic-country': { label: 'Country Clasic',      emoji: '🎸' },
        }
    },
    folk: {
        label: 'Folk / Indie',
        emoji: '🌲',
        subgenuri: {
            'indie-folk':    { label: 'Indie Folk & Americana', emoji: '🍂' },
        }
    },
    metal: {
        label: 'Metal',
        emoji: '🤘',
        subgenuri: {
            'heavy-metal':   { label: 'Heavy Metal',      emoji: '⚔️' },
            'progressive':   { label: 'Progressive Metal',emoji: '🌀' },
            'thrash':        { label: 'Thrash Metal',     emoji: '💥' },
        }
    },
};
