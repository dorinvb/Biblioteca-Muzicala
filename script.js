/* ═══════════════════════════════════════════════════════════════
   BIBLIOTECA MUZICALĂ — script.js  v3.1
   NOU: Preview audio 30sec | Backdrop artist | Fix iTunes Deluxe
═══════════════════════════════════════════════════════════════ */

const LASTFM_KEY  = '652c14677b5a1b0e9371e76b68b0a832';
const LASTFM_BASE = 'https://ws.audioscrobbler.com/2.0/';
const MB_BASE     = 'https://musicbrainz.org/ws/2';
const CAA_BASE    = 'https://coverartarchive.org';
const ITUNES_BASE = 'https://itunes.apple.com/search';

// URL-ul Worker-ului tău Cloudflare
const PROXY_BASE = 'https://music-proxy.dorin-birsan.workers.dev';
const USE_PROXY  = true;

function proxyUrl(url) {
    return USE_PROXY ? `${PROXY_BASE}?url=${encodeURIComponent(url)}` : url;
}

const apiCache        = new Map();
const coverCache      = new Map();
const coverInProgress = new Map();
const previewCache    = new Map(); // iTunes preview URLs per track

async function cachedFetch(url, opts = {}) {
    if (apiCache.has(url)) return apiCache.get(url);
    try {
        const res = await fetch(url, opts);
        if (!res.ok) return null;
        const data = await res.json();
        apiCache.set(url, data);
        return data;
    } catch { return null; }
}

/* ═══════════════════════════════════════════════════════════════
   FIX 1 — iTunes fără Deluxe/Remastered pentru albume vechi
═══════════════════════════════════════════════════════════════ */
const REMASTER_WORDS = ['deluxe','remastered','remaster','anniversary','expanded',
                        'edition','bonus','super','special','legacy'];

function _pickBestItunesAlbum(results, albumName, releaseYear) {
    if (!results?.length) return null;
    const norm = s => (s||'').toLowerCase().replace(/[^\w\s]/g,' ').replace(/\s+/g,' ').trim();
    const albumNorm = norm(albumName);
    const isOld     = releaseYear && parseInt(releaseYear) < 1995;

    // Scor pentru fiecare rezultat
    const scored = results.map(r => {
        const rNorm = norm(r.collectionName);
        let score = 0;
        // Potrivire titlu
        if (rNorm === albumNorm) score += 100;
        else if (rNorm.includes(albumNorm.slice(0,15))) score += 50;
        // Penalizare pentru versiuni remasterizate la albume vechi
        if (isOld && REMASTER_WORDS.some(w => rNorm.includes(w))) score -= 40;
        // Bonus dacă anul corespunde
        if (releaseYear && r.releaseDate?.startsWith(releaseYear)) score += 30;
        return { r, score };
    });

    scored.sort((a,b) => b.score - a.score);
    return scored[0]?.r || null;
}

/* ═══════════════════════════════════════════════════════════════
   COPERȚI — iTunes (rapid) → Cover Art Archive
═══════════════════════════════════════════════════════════════ */
async function getCover(artist, album, size = 500, year = null) {
    const key = `${artist}|||${album}`;
    if (coverCache.has(key)) return coverCache.get(key);
    if (coverInProgress.has(key)) return coverInProgress.get(key);

    const p = _fetchCover(artist, album, size, year).then(url => {
        coverCache.set(key, url);
        coverInProgress.delete(key);
        return url;
    });
    coverInProgress.set(key, p);
    return p;
}

async function _fetchCover(artist, album, size, year) {
    const itunesUrl = `${ITUNES_BASE}?term=${encodeURIComponent(artist+' '+album)}&entity=album&limit=8&media=music`;
    const iData = await cachedFetch(proxyUrl(itunesUrl));
    if (iData?.results?.length) {
        const best = _pickBestItunesAlbum(iData.results, album, year);
        if (best?.artworkUrl100)
            return best.artworkUrl100.replace('100x100bb', `${size}x${size}bb`);
    }
    // Cover Art Archive via MusicBrainz
    const mbUrl  = `${MB_BASE}/release-group?query=artist:"${encodeURIComponent(artist)}" AND releasegroup:"${encodeURIComponent(album)}"&fmt=json&limit=3`;
    const mbData = await cachedFetch(proxyUrl(mbUrl));
    const mbid   = mbData?.['release-groups']?.[0]?.id;
    if (mbid) {
        try {
            const caaData = await cachedFetch(proxyUrl(`${CAA_BASE}/release-group/${mbid}/front-${size}`));
            if (caaData?.url) return caaData.url;
        } catch {}
    }
    return '';
}

function preloadCovers(albums, concurrency = 5) {
    const queue = albums.filter(a => {
        const k = `${a.artist}|||${a.title}`;
        return a.artist && a.title && !coverCache.has(k);
    });
    let idx = 0;
    async function worker() {
        while (idx < queue.length) {
            const a = queue[idx++];
            await getCover(a.artist, a.title, 500, a.an);
            _updateCardInDOM(a.artist, a.title);
        }
    }
    Array.from({ length: Math.min(concurrency, queue.length) }, worker);
}

function _updateCardInDOM(artist, title) {
    const url = coverCache.get(`${artist}|||${title}`);
    if (!url) return;
    document.querySelectorAll(`[data-artist="${CSS.escape(artist)}"][data-album="${CSS.escape(title)}"]`)
        .forEach(card => {
            const img = card.querySelector('.card-cover-img');
            const np  = card.querySelector('.card-no-poster');
            if (!img || img.src === url) return;
            img.onload = () => { img.style.display=''; if(np) np.style.display='none'; };
            img.src = url;
        });
}

/* ═══════════════════════════════════════════════════════════════
   FIX 2 — Preview audio 30sec via iTunes
   Fetch preview URL pentru piesele unui album
═══════════════════════════════════════════════════════════════ */
async function getItunesTracks(artist, album) {
    const key = `tracks|||${artist}|||${album}`;
    if (previewCache.has(key)) return previewCache.get(key);
    const url  = `${ITUNES_BASE}?term=${encodeURIComponent(artist+' '+album)}&entity=song&limit=30&media=music`;
    const data = await cachedFetch(proxyUrl(url));
    const tracks = (data?.results||[]).filter(r => r.wrapperType==='track' && r.previewUrl);
    previewCache.set(key, tracks);
    return tracks;
}

/* ═══════════════════════════════════════════════════════════════
   METADATA ALBUM + ARTIST
═══════════════════════════════════════════════════════════════ */
async function getAlbumMetadata(artist, album) {
    const [lfData, mbData, iData] = await Promise.all([
        cachedFetch(`${LASTFM_BASE}?method=album.getinfo&artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(album)}&api_key=${LASTFM_KEY}&format=json&autocorrect=1`),
        cachedFetch(proxyUrl(`${MB_BASE}/release-group?query=artist:"${encodeURIComponent(artist)}" AND releasegroup:"${encodeURIComponent(album)}"&fmt=json&limit=1`)),
        cachedFetch(proxyUrl(`${ITUNES_BASE}?term=${encodeURIComponent(artist+' '+album)}&entity=album&limit=5&media=music`)),
    ]);
    const releaseYear = mbData?.['release-groups']?.[0]?.['first-release-date']?.slice(0,4) || '';
    return {
        lfAlbum: lfData?.album,
        mbRg:    mbData?.['release-groups']?.[0],
        iAlbum:  _pickBestItunesAlbum(iData?.results||[], album, releaseYear),
    };
}

async function getArtistMetadata(artistName) {
    const [lfInfo, lfAlbums, lfTracks, iData] = await Promise.all([
        cachedFetch(`${LASTFM_BASE}?method=artist.getinfo&artist=${encodeURIComponent(artistName)}&api_key=${LASTFM_KEY}&format=json`),
        cachedFetch(`${LASTFM_BASE}?method=artist.gettopalbums&artist=${encodeURIComponent(artistName)}&api_key=${LASTFM_KEY}&format=json&limit=20`),
        cachedFetch(`${LASTFM_BASE}?method=artist.gettoptracks&artist=${encodeURIComponent(artistName)}&api_key=${LASTFM_KEY}&format=json&limit=10`),
        cachedFetch(proxyUrl(`${ITUNES_BASE}?term=${encodeURIComponent(artistName)}&entity=musicArtist&limit=5`)),
    ]);
    return { lfInfo, lfAlbums, lfTracks, iData };
}

function lfCover(imageArr) {
    if (!imageArr?.length) return '';
    for (const sz of ['mega','extralarge','large','medium','small']) {
        const img = imageArr.find(i => i.size===sz && i['#text']);
        if (img) return img['#text'];
    }
    return imageArr[imageArr.length-1]?.['#text'] || '';
}

/* ─── STATE ─────────────────────────────────────────────────── */
let appState = { view:'idle', genre:null, subgen:null, query:null, albumId:null, artistId:null, scrollY:0 };

function navigateTo(s) {
    appState.scrollY = window.scrollY;
    appState = { ...appState, ...s };
    history.pushState({ ...appState }, '');
    renderFromState(appState);
}
window.addEventListener('popstate', (e) => {
    if (!e.state) { _doIdle(); return; }
    appState = e.state; renderFromState(appState);
});
function renderFromState(state) {
    switch (state.view) {
        case 'idle':    _doIdle(); break;
        case 'listing':
            _hideAllOverlays();
            syncSelectors(state.genre, state.subgen);
            renderListingView(state.genre, state.subgen, state.query);
            setTimeout(() => window.scrollTo(0, state.scrollY||0), 100);
            break;
        case 'album':
            _hideArtistOverlay();
            syncSelectors(state.genre, state.subgen);
            if (!document.getElementById('listing-rendered'))
                renderListingView(state.genre, state.subgen, state.query, true);
            document.getElementById('album-overlay').style.display = 'block';
            document.body.style.overflow = 'hidden';
            renderAlbumOverlay(state.albumId);
            break;
        case 'artist':
            syncSelectors(state.genre, state.subgen);
            document.getElementById('album-overlay').style.display  = 'block';
            document.getElementById('artist-overlay').style.display = 'block';
            document.body.style.overflow = 'hidden';
            renderArtistOverlay(state.artistId);
            break;
    }
}
function _doIdle() {
    _hideAllOverlays();
    document.getElementById('genre-select').value = '';
    const sgWrap = document.getElementById('subgen-wrap');
    if (sgWrap) sgWrap.style.display = 'none';
    renderIdleView();
}
function _hideAllOverlays() {
    ['album-overlay','artist-overlay'].forEach(id => {
        const el = document.getElementById(id); if (el) el.style.display='none';
    });
    document.getElementById('album-overlay-content').innerHTML  = '';
    document.getElementById('artist-overlay-content').innerHTML = '';
    document.body.style.overflow = '';
    stopPreview();
}
function _hideArtistOverlay() {
    const el = document.getElementById('artist-overlay');
    if (el) el.style.display='none';
    document.getElementById('artist-overlay-content').innerHTML = '';
}
function syncSelectors(genre, subgen) {
    document.getElementById('genre-select').value = genre||'';
    _updateSubgenSelect(genre, subgen);
}
function goHome() {
    const idle = { view:'idle', genre:null, subgen:null, query:null, albumId:null, artistId:null, scrollY:0 };
    history.pushState(idle,''); appState=idle; _doIdle();
}
function closeAlbumOverlay()  { history.back(); }
function closeArtistOverlay() { history.back(); }
document.addEventListener('keydown', (e) => {
    if (e.key==='Escape') {
        if (appState.view==='artist') { closeArtistOverlay(); return; }
        if (appState.view==='album')  { closeAlbumOverlay();  return; }
    }
});

/* ─── HANDLERS ───────────────────────────────────────────────── */
function handleGenreChange() {
    const genre = document.getElementById('genre-select').value;
    if (!genre) { navigateTo({ view:'idle', genre:null, subgen:null, query:null, albumId:null, artistId:null, scrollY:0 }); return; }
    _updateSubgenSelect(genre, null);
    navigateTo({ view:'listing', genre, subgen:null, query:null, albumId:null, artistId:null, scrollY:0 });
}
function handleSubgenChange() {
    const genre  = document.getElementById('genre-select').value;
    const subgen = document.getElementById('subgen-select')?.value||null;
    navigateTo({ view:'listing', genre, subgen:subgen||null, query:null, albumId:null, artistId:null, scrollY:0 });
}
function _updateSubgenSelect(genre, currentSubgen) {
    let sgWrap = document.getElementById('subgen-wrap');
    if (!genre||!window.musicMap?.[genre]?.subgenuri) {
        if (sgWrap) sgWrap.style.display='none'; return;
    }
    if (!sgWrap) {
        sgWrap = document.createElement('div');
        sgWrap.className='dropdown-group'; sgWrap.id='subgen-wrap';
        sgWrap.innerHTML=`<span class="dropdown-label">SUBGEN</span>
            <select id="subgen-select" onchange="handleSubgenChange()"></select>`;
        document.getElementById('main-header').querySelector('.header-right').appendChild(sgWrap);
    }
    document.getElementById('subgen-select').innerHTML =
        `<option value="">— Toate —</option>`+
        Object.entries(window.musicMap[genre].subgenuri).map(([k,v])=>
            `<option value="${k}" ${k===currentSubgen?'selected':''}>${v.emoji} ${v.label}</option>`
        ).join('');
    sgWrap.style.display='';
}
function handleSearch() {
    const q=(document.getElementById('idle-search-input')?.value||'').trim();
    if (!q) return;
    navigateTo({ view:'listing', genre:null, subgen:null, query:q, albumId:null, artistId:null, scrollY:0 });
}
function handleListingSearch() {
    const q=(document.getElementById('listing-search-input')?.value||'').trim();
    if (!q) return;
    navigateTo({ view:'listing', genre:null, subgen:null, query:q, albumId:null, artistId:null, scrollY:0 });
}
function clearListingSearch() {
    navigateTo({ view:'listing', genre:appState.genre, subgen:appState.subgen, query:null, albumId:null, artistId:null, scrollY:0 });
}
function handleQuickGenre(genre) {
    document.getElementById('genre-select').value = genre;
    _updateSubgenSelect(genre, null);
    navigateTo({ view:'listing', genre, subgen:null, query:null, albumId:null, artistId:null, scrollY:0 });
}

/* ═══════════════════════════════════════════════════════════════
   IDLE VIEW
═══════════════════════════════════════════════════════════════ */
function renderIdleView() {
    document.getElementById('app-viewport').innerHTML = `
        <div class="music-home">
            <div class="music-hero">
                <div class="music-hero-visual">
                    <div class="vinyl-anim">
                        <div class="vinyl-disc">
                            <div class="vinyl-groove v1"></div><div class="vinyl-groove v2"></div>
                            <div class="vinyl-groove v3"></div><div class="vinyl-center"></div>
                        </div>
                    </div>
                </div>
                <div class="music-hero-text">
                    <h1 class="music-hero-title">BIBLIOTECA<br><span>MUZICALĂ</span></h1>
                    <p class="music-hero-sub">Albume esențiale organizate pe genuri. Coperți HD, tracklist complet, preview audio.</p>
                    <div class="hero-search-wrap">
                        <i class="fas fa-search hero-search-icon"></i>
                        <input type="text" id="idle-search-input" class="hero-search-input"
                            placeholder="Caută un artist sau album..."
                            autocomplete="off" onkeydown="if(event.key==='Enter') handleSearch()">
                        <button class="hero-search-btn" onclick="handleSearch()">CAUTĂ</button>
                    </div>
                    <div class="quick-genres">
                        <span class="qg-label">Genuri:</span>
                        <div class="qg-pills" id="qg-pills"></div>
                    </div>
                </div>
            </div>
            <div id="home-charts"></div>
        </div>`;
    _populateQuickGenres();
    _loadHomeCharts();
}

function _populateQuickGenres() {
    const el = document.getElementById('qg-pills');
    if (!el||!window.musicMap) return;
    el.innerHTML = Object.entries(window.musicMap).map(([k,v])=>
        `<button class="qg-pill" onclick="handleQuickGenre('${k}')">${v.emoji} ${v.label}</button>`
    ).join('');
}

async function _loadHomeCharts() {
    const container = document.getElementById('home-charts');
    if (!container||!window.musicMap) return;
    for (const [genKey, genVal] of Object.entries(window.musicMap)) {
        const subgenuri = Object.keys(genVal.subgenuri||{});
        if (!subgenuri.length) continue;
        const rowId = `home-${genKey}`;
        const rowEl = createRowShell(`${genVal.emoji} ${genVal.label}`, rowId,
            ()=>navigateTo({ view:'listing', genre:genKey, subgen:null, query:null, albumId:null, artistId:null, scrollY:0 }));
        container.appendChild(rowEl);
        renderSkeletons(rowId, 8, 'album');
        loadLocalData(genKey, subgenuri[0]).then(data => {
            const row = document.getElementById(rowId); if (!row) return;
            row.innerHTML = '';
            const albume = (data?.albume||[]).slice(0,12);
            if (!albume.length) { row.innerHTML=`<div class="row-empty">Adaugă fișiere în database/${genKey}/</div>`; return; }
            albume.forEach(a => renderAlbumCard(rowId, normalizeLocalAlbum(a)));
            preloadCovers((data?.albume||[]).map(normalizeLocalAlbum));
        });
    }
}

/* ═══════════════════════════════════════════════════════════════
   DATE LOCALE
═══════════════════════════════════════════════════════════════ */
const loadedScripts  = new Set();
const localDataCache = new Map();
const VAR_MAP = {
    'rock/classic-rock':      'classicRockData',
    'rock/hard-rock':         'hardRockData',
    'rock/alternative':       'alternativeData',
    'rock/punk':              'punkData',
    'jazz/jazz-vocal':        'jazzVocalData',
    'jazz/bebop':             'bebopData',
    'jazz/smooth-jazz':       'smoothJazzData',
    'jazz/fusion':            'fusionData',
    'blues/blues-rock':       'bluesRockData',
    'blues/delta-blues':      'deltaBluesData',
    'blues/chicago-blues':    'chicagoBluesData',
    'soul/neo-soul':          'neoSoulData',
    'country/contemporary':   'contemporaryCountryData',
    'country/classic-country':'classicCountryData',
    'folk/indie-folk':        'indieFolkData',
};

function loadLocalData(gen, subgen) {
    const key = `${gen}/${subgen}`;
    if (localDataCache.has(key)) return Promise.resolve(localDataCache.get(key));
    if (loadedScripts.has(key))  return Promise.resolve(null);
    const varName = VAR_MAP[key];
    if (!varName) return Promise.resolve(null);
    return new Promise((resolve) => {
        const script = document.createElement('script');
        script.src = `database/${gen}/${subgen}.js`;
        const timer = setTimeout(()=>{ loadedScripts.add(key); resolve(null); }, 6000);
        script.onload = ()=>{
            clearTimeout(timer); loadedScripts.add(key);
            const data = window[varName]||null;
            if (data) localDataCache.set(key, data);
            resolve(data);
        };
        script.onerror = ()=>{ clearTimeout(timer); loadedScripts.add(key); resolve(null); };
        document.body.appendChild(script);
    });
}

async function fetchTopAlbums(genre, subgen) {
    if (subgen) {
        const data = await loadLocalData(genre, subgen);
        return (data?.albume||[]).map(normalizeLocalAlbum);
    }
    const all = [];
    for (const sg of Object.keys(window.musicMap?.[genre]?.subgenuri||{})) {
        const data = await loadLocalData(genre, sg);
        if (data?.albume?.length) all.push(...data.albume.slice(0,10).map(normalizeLocalAlbum));
    }
    return all.sort(()=>Math.random()-0.5);
}

async function fetchTopArtists(genre, subgen) {
    const data = subgen ? await loadLocalData(genre, subgen) : null;
    if (data?.albume) {
        const seen = new Set();
        return data.albume
            .filter(a=>{ if(seen.has(a.artist)) return false; seen.add(a.artist); return true; })
            .slice(0,20)
            .map(a=>({ id:encodeURIComponent(a.artist), name:a.artist, picture:'', fans:0, type:'artist' }));
    }
    const d = await cachedFetch(`${LASTFM_BASE}?method=tag.gettopartists&tag=${encodeURIComponent(genre)}&api_key=${LASTFM_KEY}&format=json&limit=20`);
    return (d?.topartists?.artist||[]).map(normalizeLastfmArtist);
}

async function searchAlbums(query) {
    const d = await cachedFetch(`${LASTFM_BASE}?method=album.search&album=${encodeURIComponent(query)}&api_key=${LASTFM_KEY}&format=json&limit=20`);
    return (d?.results?.albummatches?.album||[]).map(normalizeLastfmAlbum);
}
async function searchArtists(query) {
    const d = await cachedFetch(`${LASTFM_BASE}?method=artist.search&artist=${encodeURIComponent(query)}&api_key=${LASTFM_KEY}&format=json&limit=20`);
    return (d?.results?.artistmatches?.artist||[]).map(normalizeLastfmArtist);
}

function normalizeLocalAlbum(a) {
    return { id:encodeURIComponent(a.artist+'|||'+a.album), title:a.album, artist:a.artist, an:a.an, cover:'', type:'album' };
}
function normalizeLastfmAlbum(a) {
    return { id:encodeURIComponent((a.artist?.name||a.artist||'')+'|||'+a.name), title:a.name, artist:a.artist?.name||a.artist||'', cover:lfCover(a.image), type:'album' };
}
function normalizeLastfmArtist(a) {
    return { id:encodeURIComponent(a.name), name:a.name, picture:lfCover(a.image), fans:parseInt(a.listeners||0), type:'artist' };
}

/* ═══════════════════════════════════════════════════════════════
   LISTING VIEW
═══════════════════════════════════════════════════════════════ */
async function renderListingView(genre, subgen, query, silent=false) {
    const vp = document.getElementById('app-viewport');
    const sgLabel  = subgen?(window.musicMap?.[genre]?.subgenuri?.[subgen]?.label||subgen):'';
    const genLabel = genre?(window.musicMap?.[genre]?.label||genre):'';
    if (!silent) {
        const msg = query?`Se caută „${query}"...`:`Se încarcă ${sgLabel||genLabel||'biblioteca'}...`;
        vp.innerHTML=`
            <div id="listing-rendered">
                <div class="listing-search-bar">
                    <i class="fas fa-search listing-search-icon"></i>
                    <input type="text" id="listing-search-input" class="listing-search-input"
                        placeholder="Caută artist sau album..." value="${esc(query||'')}"
                        autocomplete="off" onkeydown="if(event.key==='Enter') handleListingSearch()">
                    <button class="listing-search-btn" onclick="handleListingSearch()">CAUTĂ</button>
                    ${query?`<button class="listing-clear-btn" onclick="clearListingSearch()">✕</button>`:''}
                </div>
                <div class="context-msg"><div class="context-dot"></div><span>${msg}</span></div>
            </div>`;
    } else {
        if (!document.getElementById('listing-rendered')) vp.innerHTML='<div id="listing-rendered"></div>';
    }
    const container = document.getElementById('listing-rendered')||vp;
    if (query) await renderSearchResults(container, query);
    else        await renderChartRows(container, genre, subgen);
}

async function renderChartRows(container, genre, subgen) {
    container.querySelector('.context-msg')?.remove();
    const genMeta = window.musicMap?.[genre];
    const sgMeta  = subgen?genMeta?.subgenuri?.[subgen]:null;
    const emoji   = sgMeta?.emoji||genMeta?.emoji||'🎵';
    const label   = sgMeta?.label||genMeta?.label||'BIBLIOTECA';
    const hdr = document.createElement('div');
    hdr.className='fest-sticky-header';
    hdr.innerHTML=`<span class="fest-sticky-emoji">${emoji}</span><span class="fest-sticky-name">${label.toUpperCase()}</span>`;
    container.appendChild(hdr);

    if (subgen) {
        const aId = `alb-${subgen}`, rId = `art-${subgen}`;
        const aRow = createRowShell('🎼 ALBUME', aId);
        container.appendChild(aRow); renderSkeletons(aId, 10, 'album');
        fetchTopAlbums(genre, subgen).then(items => {
            const row=document.getElementById(aId); if(!row) return;
            row.innerHTML='';
            if (!items.length) { row.innerHTML='<div class="row-empty">Adaugă fișierul .js</div>'; return; }
            items.forEach(a=>renderAlbumCard(aId, a));
            preloadCovers(items);
        });
        const rRow = createRowShell('🎤 ARTIȘTI', rId);
        container.appendChild(rRow); renderSkeletons(rId, 10, 'artist');
        fetchTopArtists(genre, subgen).then(items => {
            const row=document.getElementById(rId); if(!row) return;
            row.innerHTML='';
            items.forEach(a=>renderArtistCard(rId, a));
        });
    } else if (genMeta?.subgenuri) {
        for (const [sgKey, sgVal] of Object.entries(genMeta.subgenuri)) {
            const rowId=`row-${genre}-${sgKey}`;
            const rowEl=createRowShell(`${sgVal.emoji} ${sgVal.label}`, rowId,
                ()=>navigateTo({ view:'listing', genre, subgen:sgKey, query:null, albumId:null, artistId:null, scrollY:0 }));
            container.appendChild(rowEl); renderSkeletons(rowId, 8, 'album');
            loadLocalData(genre, sgKey).then(data=>{
                const row=document.getElementById(rowId); if(!row) return;
                row.innerHTML='';
                const items=(data?.albume||[]).slice(0,15).map(normalizeLocalAlbum);
                if (!items.length) { row.innerHTML=`<div class="row-empty">Adaugă database/${genre}/${sgKey}.js</div>`; return; }
                items.forEach(a=>renderAlbumCard(rowId, a));
                preloadCovers((data?.albume||[]).map(normalizeLocalAlbum));
            });
        }
    }
}

async function renderSearchResults(container, query) {
    container.querySelector('.context-msg')?.remove();
    const hdr=document.createElement('div');
    hdr.className='fest-sticky-header';
    hdr.innerHTML=`<span class="fest-sticky-emoji">🔍</span><span class="fest-sticky-name">${esc(query)}</span>`;
    container.appendChild(hdr);
    const ts=Date.now(), aId=`sa-${ts}`, rId=`sr-${ts}`;
    const aRow=createRowShell('🎼 ALBUME', aId);
    container.appendChild(aRow); renderSkeletons(aId, 8, 'album');
    searchAlbums(query).then(items=>{
        const row=document.getElementById(aId); if(!row) return;
        row.innerHTML='';
        if (!items.length) { row.innerHTML='<div class="row-empty">Niciun album găsit.</div>'; return; }
        items.forEach(a=>renderAlbumCard(aId, a));
    });
    const rRow=createRowShell('🎤 ARTIȘTI', rId);
    container.appendChild(rRow); renderSkeletons(rId, 8, 'artist');
    searchArtists(query).then(items=>{
        const row=document.getElementById(rId); if(!row) return;
        row.innerHTML='';
        if (!items.length) { row.innerHTML='<div class="row-empty">Niciun artist găsit.</div>'; return; }
        items.forEach(a=>renderArtistCard(rId, a));
    });
}

/* ═══════════════════════════════════════════════════════════════
   CARDURI
═══════════════════════════════════════════════════════════════ */
function renderAlbumCard(rowId, album) {
    const row=document.getElementById(rowId); if(!row) return;
    const uid=Math.random().toString(36).slice(2,8);
    const card=document.createElement('div');
    card.className='music-card';
    card.dataset.artist=album.artist||'';
    card.dataset.album=album.title||'';
    card.innerHTML=`
        <div class="card-poster">
            <img class="card-cover-img" id="ci-${uid}" src="" alt="${esc(album.title)}" loading="lazy" style="display:none">
            <div class="card-no-poster" id="cn-${uid}"><i class="fas fa-compact-disc"></i></div>
            <div class="card-hover-overlay"><div class="hover-play"><i class="fas fa-play-circle"></i></div></div>
        </div>
        <div class="card-info">
            <div class="card-title">${esc(album.title)}</div>
            <div class="card-person">${esc(album.artist)}${album.an?' · '+album.an:''}</div>
        </div>`;
    card.style.cursor='pointer';
    card.addEventListener('click',()=>navigateTo({ view:'album', albumId:album.id }));
    row.appendChild(card);
    const key=`${album.artist}|||${album.title}`;
    if (album.cover) _applyCardCover(`ci-${uid}`,`cn-${uid}`,album.cover);
    else if (coverCache.has(key)&&coverCache.get(key)) _applyCardCover(`ci-${uid}`,`cn-${uid}`,coverCache.get(key));
    else getCover(album.artist, album.title, 500, album.an).then(url=>_applyCardCover(`ci-${uid}`,`cn-${uid}`,url));
}

function renderArtistCard(rowId, artist) {
    const row=document.getElementById(rowId); if(!row) return;
    const uid=Math.random().toString(36).slice(2,8);
    const card=document.createElement('div');
    card.className='music-card artist-card-item';
    card.innerHTML=`
        <div class="card-poster artist-poster">
            <img id="ai-${uid}" src="" alt="${esc(artist.name)}" loading="lazy" style="display:none">
            <div class="card-no-poster" id="an-${uid}"><i class="fas fa-microphone"></i></div>
            <div class="card-hover-overlay"><div class="hover-play"><i class="fas fa-user"></i></div></div>
        </div>
        <div class="card-info">
            <div class="card-title">${esc(artist.name)}</div>
            ${artist.fans?`<div class="card-person">${formatFans(artist.fans)} ascultători</div>`:''}
        </div>`;
    card.style.cursor='pointer';
    card.addEventListener('click',()=>navigateTo({ view:'artist', artistId:artist.id }));
    row.appendChild(card);
    const setImg=(url)=>{ if(url) _applyCardCover(`ai-${uid}`,`an-${uid}`,url); };
    if (artist.picture) setImg(artist.picture);
    else cachedFetch(proxyUrl(`${ITUNES_BASE}?term=${encodeURIComponent(artist.name)}&entity=musicArtist&limit=1`))
        .then(d=>{ const url=d?.results?.[0]?.artworkUrl100?.replace('100x100bb','300x300bb'); if(url) setImg(url); });
}

function _applyCardCover(imgId, npId, url) {
    if (!url) return;
    const img=document.getElementById(imgId), np=document.getElementById(npId);
    if (!img) return;
    img.onload=()=>{ img.style.display=''; if(np) np.style.display='none'; };
    img.onerror=()=>{};
    img.src=url;
}

function createRowShell(title, rowId, onClickHeader) {
    const div=document.createElement('div');
    div.className='festival-row';
    div.innerHTML=`
        <div class="row-header ${onClickHeader?'row-header-clickable':''}">
            <span class="row-title">${title}</span>
            ${onClickHeader?'<span class="row-arrow">→</span>':''}
        </div>
        <div class="row-scroll-wrap">
            <button class="scroll-btn scroll-btn-left">&#8249;</button>
            <div class="row-films" id="${rowId}"></div>
            <button class="scroll-btn scroll-btn-right">&#8250;</button>
        </div>`;
    if (onClickHeader) div.querySelector('.row-header').addEventListener('click', onClickHeader);
    const getRow=()=>document.getElementById(rowId);
    div.querySelector('.scroll-btn-left').addEventListener('click', (e)=>{ e.stopPropagation(); getRow()?.scrollBy({left:-520,behavior:'smooth'}); });
    div.querySelector('.scroll-btn-right').addEventListener('click',(e)=>{ e.stopPropagation(); getRow()?.scrollBy({left: 520,behavior:'smooth'}); });
    return div;
}

function renderSkeletons(rowId, count, type) {
    const row=document.getElementById(rowId); if(!row) return;
    row.innerHTML='';
    for (let i=0;i<count;i++) {
        const sk=document.createElement('div');
        sk.className=`music-card skeleton ${type==='artist'?'artist-card-item':''}`;
        sk.innerHTML=`
            <div class="card-poster skeleton-base ${type==='artist'?'artist-poster':''}"></div>
            <div class="card-info">
                <div class="skeleton-base sk-line" style="margin-bottom:5px"></div>
                <div class="skeleton-base sk-line short"></div>
            </div>`;
        row.appendChild(sk);
    }
}

/* ═══════════════════════════════════════════════════════════════
   FIX 3 — BACKDROP CU IMAGINEA ARTISTULUI în overlay album
   + PREVIEW AUDIO în tracklist
═══════════════════════════════════════════════════════════════ */
async function renderAlbumOverlay(albumId) {
    const overlay=document.getElementById('album-overlay');
    const content=document.getElementById('album-overlay-content');
    overlay.scrollTop=0;
    content.innerHTML=`
        <div style="position:relative">
            <div class="overlay-close-bar">
                <button class="btn-home-overlay" onclick="goHome()"><i class="fas fa-home"></i> HOME</button>
                <button class="btn-close-overlay" onclick="closeAlbumOverlay()">✕</button>
            </div>
            <div class="overlay-backdrop" style="background:var(--bg-lighter)"></div>
            <div class="film-header-block">
                <div class="film-poster-wrap">
                    <div class="skeleton-base" style="width:220px;height:220px;border-radius:12px;border:2px solid var(--accent)"></div>
                </div>
                <div class="film-meta-wrap" style="padding-top:60px">
                    <div class="loading-inline"><i class="fas fa-circle-notch fa-spin" style="color:var(--accent)"></i> Se încarcă...</div>
                </div>
            </div>
        </div>`;

    const decoded=decodeURIComponent(albumId);
    const sepIdx=decoded.indexOf('|||');
    const artistName=decoded.slice(0,sepIdx);
    const albumName=decoded.slice(sepIdx+3);

    // Fetch paralel: metadata + copertă + tracks iTunes + poza artist
    const [{ lfAlbum, mbRg, iAlbum }, coverUrl, itunesTracks, artistMeta] = await Promise.all([
        getAlbumMetadata(artistName, albumName),
        getCover(artistName, albumName, 600),
        getItunesTracks(artistName, albumName),
        getArtistMetadata(artistName),
    ]);

    // Poza artistului pentru backdrop
    const iArtists = (artistMeta.iData?.results||[]).filter(r=>r.wrapperType==='artist');
    const artistPicUrl = iArtists[0]?.artworkUrl100?.replace('100x100bb','1000x1000bb') || '';

    const tracks    = lfAlbum?.tracks?.track||[];
    const lfTracksArr = Array.isArray(tracks)?tracks:(tracks?[tracks]:[]);
    const tags      = lfAlbum?.tags?.tag||[];
    const tagsArr   = (Array.isArray(tags)?tags:[tags]).slice(0,6);
    const wiki      = lfAlbum?.wiki?.content||lfAlbum?.wiki?.summary||'';
    const bio       = wiki.replace(/<a [^>]+>.*?<\/a>/gi,'').replace(/\s+/g,' ').trim();
    const listeners = parseInt(lfAlbum?.listeners||0);
    const playcount = parseInt(lfAlbum?.playcount||0);
    const releaseYear = mbRg?.['first-release-date']?.slice(0,4)||(iAlbum?.releaseDate?iAlbum.releaseDate.slice(0,4):'');
    const itunesGenre = iAlbum?.primaryGenreName||'';

    // Mapează preview URLs după titlu melodie
    const previewMap = {};
    itunesTracks.forEach(t => {
        const k = (t.trackName||'').toLowerCase().trim();
        if (k && t.previewUrl) previewMap[k] = t.previewUrl;
    });

    // Tracklist: Last.fm dacă are → altfel iTunes (are mereu piese + preview)
    const tracksArr = lfTracksArr.length ? lfTracksArr :
        itunesTracks.map(t => ({
            name: t.trackName||'',
            duration: t.trackTimeMillis ? Math.round(t.trackTimeMillis/1000) : 0,
            '@attr': { rank: String(t.trackNumber||'') }
        }));
    const trackCount = parseInt(iAlbum?.trackCount||tracksArr.length||0);

    // Tracklist cu butoane preview
    const tracklistHtml = tracksArr.length ? `
        <div class="music-section">
            <div class="section-title">Lista de melodii${trackCount?` (${trackCount} piese)`:''}</div>
            <div class="tracklist-wrap">
                ${tracksArr.map((t,i)=>{
                    const tKey=(t.name||'').toLowerCase().trim();
                    const preview=previewMap[tKey]||'';
                    return `<div class="track-row ${preview?'has-preview':''}">
                        <span class="track-num">${t['@attr']?.rank||i+1}</span>
                        <span class="track-name">${esc(t.name)}</span>
                        <span class="track-dur">${formatDuration(parseInt(t.duration||0))}</span>
                        ${preview?`<button class="track-play-btn" onclick="togglePreview(this,'${preview}')" title="Preview 30 sec">
                            <i class="fas fa-play"></i>
                        </button>`:''}
                    </div>`;
                }).join('')}
            </div>
        </div>` : '';

    const bioHtml = bio?`
        <div class="music-section">
            <div class="section-title">Despre album</div>
            <p class="film-overview" id="ov-bio">${esc(bio.length>500?bio.slice(0,500)+'…':bio)}</p>
            ${bio.length>500?`<button class="read-more-btn" onclick="toggleText('ov-bio','${btoa(encodeURIComponent(bio))}')">Citește mai mult ↓</button>`:''}
        </div>`:'';

    const linksHtml=`
        <div class="music-section">
            <div class="section-title">Ascultă pe</div>
            <div class="external-btns">
                <a class="ext-btn spotify" target="_blank" href="https://open.spotify.com/search/${encodeURIComponent(artistName+' '+albumName)}"><i class="fab fa-spotify"></i> Spotify</a>
                <a class="ext-btn youtube" target="_blank" href="https://www.youtube.com/results?search_query=${encodeURIComponent(artistName+' '+albumName+' full album')}"><i class="fab fa-youtube"></i> YouTube</a>
                <a class="ext-btn deezer"  target="_blank" href="https://www.deezer.com/search/${encodeURIComponent(artistName+' '+albumName)}/album">💜 Deezer</a>
                <a class="ext-btn tidal"   target="_blank" href="https://listen.tidal.com/search?query=${encodeURIComponent(artistName+' '+albumName)}&type=albums">🔷 Tidal</a>
            </div>
        </div>`;

    // Backdrop: imaginea artistului (blur) sau coperta albumului
    const backdropSrc = artistPicUrl || coverUrl;

    content.innerHTML=`
        <div style="position:relative">
            <div class="overlay-close-bar">
                <button class="btn-home-overlay" onclick="goHome()"><i class="fas fa-home"></i> HOME</button>
                <button class="btn-close-overlay" onclick="closeAlbumOverlay()">✕</button>
            </div>
            <div class="overlay-backdrop">
                ${backdropSrc?`<img src="${backdropSrc}" alt="" id="overlay-backdrop-img">`:''}
                <div class="backdrop-gradient"></div>
            </div>
            <div class="film-header-block">
                <div class="film-poster-wrap">
                    ${coverUrl
                        ?`<img src="${coverUrl}" alt="${esc(albumName)}" style="width:220px;height:220px;border-radius:12px;border:2px solid var(--accent);object-fit:cover">`
                        :`<div style="width:220px;height:220px;background:var(--bg-lighter);border-radius:12px;border:2px solid var(--accent);display:flex;align-items:center;justify-content:center;font-size:4rem">🎵</div>`}
                </div>
                <div class="film-meta-wrap">
                    <h1 class="film-title-text">${esc(albumName)}</h1>
                    <button class="artist-link-btn"
                         onclick="navigateTo({view:'artist',artistId:encodeURIComponent('${esc(artistName)}')})">
                        <i class="fas fa-microphone"></i> ${esc(artistName)}
                        <span class="artist-link-arrow">→ pagina artistului</span>
                    </button>
                    <div class="film-tags">
                        ${releaseYear?`<span class="film-tag">📅 ${releaseYear}</span>`:''}
                        ${itunesGenre?`<span class="film-tag">${esc(itunesGenre)}</span>`:''}
                        ${trackCount?`<span class="film-tag">🎵 ${trackCount} piese</span>`:''}
                        ${tagsArr.map(t=>`<span class="film-tag">${esc(t.name)}</span>`).join('')}
                    </div>
                    <div class="ratings-row">
                        ${listeners?`<div class="rating-badge tmdb"><span class="rb-source">Ascultători</span><span class="rb-value">${formatFans(listeners)}</span></div>`:''}
                        ${playcount?`<div class="rating-badge imdb"><span class="rb-source">Redări</span><span class="rb-value">${formatFans(playcount)}</span></div>`:''}
                    </div>
                </div>
            </div>
            <div class="film-body">
                ${bioHtml}${linksHtml}${tracklistHtml}
                <div style="height:50px"></div>
            </div>
        </div>`;
}

/* ═══════════════════════════════════════════════════════════════
   ARTIST OVERLAY
═══════════════════════════════════════════════════════════════ */
async function renderArtistOverlay(artistId) {
    const overlay=document.getElementById('artist-overlay');
    const content=document.getElementById('artist-overlay-content');
    overlay.scrollTop=0;
    content.innerHTML=`
        <div style="position:relative;padding-top:70px;padding-left:28px">
            <div class="overlay-close-bar">
                <button class="btn-home-overlay" onclick="goHome()"><i class="fas fa-home"></i> HOME</button>
                <button class="btn-close-overlay" onclick="closeArtistOverlay()">✕</button>
            </div>
            <div class="loading-inline" style="padding:60px 0">
                <i class="fas fa-circle-notch fa-spin" style="color:var(--accent)"></i> Se încarcă artistul...
            </div>
        </div>`;

    const artistName=decodeURIComponent(artistId);
    const { lfInfo, lfAlbums, lfTracks, iData } = await getArtistMetadata(artistName);

    const artist    = lfInfo?.artist;
    const bio       = (artist?.bio?.content||artist?.bio?.summary||'').replace(/<a [^>]+>.*?<\/a>/gi,'').replace(/\s+/g,' ').trim();
    const shortBio  = bio.length>600?bio.slice(0,600)+'…':bio;
    const listeners = parseInt(artist?.stats?.listeners||0);
    const playcount = parseInt(artist?.stats?.playcount||0);
    const similar   = artist?.similar?.artist||[];
    const simArr    = (Array.isArray(similar)?similar:[similar]).slice(0,10);

    const tracksArr = (()=>{ const t=lfTracks?.toptracks?.track||[]; return (Array.isArray(t)?t:[t]).slice(0,10); })();
    const albumsArr = (()=>{ const a=lfAlbums?.topalbums?.album||[]; return (Array.isArray(a)?a:[a]).slice(0,20); })();

    // Poza artistului via iTunes
    let pictureUrl='';
    const iArtists=(iData?.results||[]).filter(r=>r.wrapperType==='artist');
    if (iArtists[0]?.artworkUrl100)
        pictureUrl=iArtists[0].artworkUrl100.replace('100x100bb','600x600bb');

    const topTracksHtml = tracksArr.length?`
        <div class="music-section" style="padding:0 28px">
            <div class="section-title">Top melodii</div>
            <div class="tracklist-wrap">
                ${tracksArr.map((t,i)=>`
                    <div class="track-row">
                        <span class="track-num">${i+1}</span>
                        <span class="track-name">${esc(t.name)}</span>
                        <span class="track-dur">${formatFans(parseInt(t.playcount||0))} red.</span>
                    </div>`).join('')}
            </div>
        </div>`:'';

    const albumsHtml = albumsArr.length?`
        <div class="filmography-section">
            <div class="section-title">Top Albume</div>
            <div class="filmography-scroll">
                ${albumsArr.map(a=>{
                    const cover=lfCover(a.image);
                    const aId=encodeURIComponent(artistName+'|||'+a.name);
                    return `<div class="filmo-card" onclick="navigateTo({view:'album',albumId:'${aId}'})">
                        ${cover
                            ?`<img src="${cover}" alt="${esc(a.name)}" loading="lazy">`
                            :`<div style="width:120px;height:120px;background:var(--bg-lighter);border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:2rem">🎵</div>`}
                        <p>${esc(a.name)}</p>
                        <span>${formatFans(parseInt(a.playcount||0))} red.</span>
                    </div>`;
                }).join('')}
            </div>
        </div>`:'';

    const relatedHtml = simArr.length?`
        <div class="filmography-section">
            <div class="section-title">Artiști similari</div>
            <div class="filmography-scroll">
                ${simArr.map(a=>{
                    const pic=lfCover(a.image);
                    return `<div class="filmo-card" onclick="navigateTo({view:'artist',artistId:encodeURIComponent('${esc(a.name)}')})">
                        ${pic
                            ?`<img src="${pic}" alt="${esc(a.name)}" loading="lazy" style="border-radius:50%">`
                            :`<div style="width:120px;height:120px;border-radius:50%;background:var(--bg-lighter);display:flex;align-items:center;justify-content:center;font-size:2rem">🎤</div>`}
                        <p>${esc(a.name)}</p>
                    </div>`;
                }).join('')}
            </div>
        </div>`:'';

    content.innerHTML=`
        <div style="position:relative">
            <div class="overlay-close-bar">
                <button class="btn-home-overlay" onclick="goHome()"><i class="fas fa-home"></i> HOME</button>
                <button class="btn-close-overlay" onclick="closeArtistOverlay()">✕</button>
            </div>
            <div class="actor-header-block">
                <div class="actor-photo-wrap">
                    ${pictureUrl
                        ?`<img src="${pictureUrl}" alt="${esc(artistName)}">`
                        :`<div class="actor-photo-placeholder"><i class="fas fa-microphone"></i></div>`}
                </div>
                <div class="actor-info-block">
                    <h1 class="actor-name-title">${esc(artistName)}</h1>
                    <div class="actor-facts">
                        ${listeners?`<div class="actor-fact"><i class="fas fa-headphones"></i> ${formatFans(listeners)} ascultători/lună</div>`:''}
                        ${playcount?`<div class="actor-fact"><i class="fas fa-play"></i> ${formatFans(playcount)} redări totale</div>`:''}
                    </div>
                    <p class="actor-bio-text" id="artist-bio-text">${esc(shortBio)||'Fără biografie disponibilă.'}</p>
                    ${bio.length>600?`<button class="read-more-btn" onclick="toggleText('artist-bio-text','${btoa(encodeURIComponent(bio))}')">Citește mai mult ↓</button>`:''}
                    <div class="external-btns" style="margin-top:16px">
                        <a class="ext-btn spotify" target="_blank" href="https://open.spotify.com/search/${encodeURIComponent(artistName)}"><i class="fab fa-spotify"></i> Spotify</a>
                        <a class="ext-btn youtube" target="_blank" href="https://www.youtube.com/results?search_query=${encodeURIComponent(artistName)}"><i class="fab fa-youtube"></i> YouTube</a>
                        <a class="ext-btn deezer"  target="_blank" href="https://www.deezer.com/search/${encodeURIComponent(artistName)}/artist">💜 Deezer</a>
                    </div>
                </div>
            </div>
            ${topTracksHtml}${albumsHtml}${relatedHtml}
            <div style="height:60px"></div>
        </div>`;
}

/* ═══════════════════════════════════════════════════════════════
   PREVIEW AUDIO — player global simplu
═══════════════════════════════════════════════════════════════ */
let _audio = null;
let _activeBtn = null;

function togglePreview(btn, url) {
    // Dacă același buton → stop
    if (_activeBtn === btn) {
        stopPreview();
        return;
    }
    stopPreview();
    _audio = new Audio(url);
    _audio.volume = 0.8;
    _audio.play();
    _audio.onended = () => { _resetBtn(btn); _audio=null; _activeBtn=null; };
    _activeBtn = btn;
    btn.innerHTML = '<i class="fas fa-pause"></i>';
    btn.classList.add('playing');
}

function stopPreview() {
    if (_audio) { _audio.pause(); _audio=null; }
    if (_activeBtn) { _resetBtn(_activeBtn); _activeBtn=null; }
}

function _resetBtn(btn) {
    if (btn) { btn.innerHTML='<i class="fas fa-play"></i>'; btn.classList.remove('playing'); }
}

/* ─── Utilitar ───────────────────────────────────────────────── */
function toggleText(elId, b64) {
    const el=document.getElementById(elId), btn=el?.nextElementSibling;
    if (!el||!btn) return;
    if (el.dataset.exp) {
        el.textContent=decodeURIComponent(atob(b64)).slice(0,parseInt(el.dataset.shortLen))+'…';
        btn.textContent='Citește mai mult ↓'; delete el.dataset.exp;
    } else {
        if (!el.dataset.shortLen) el.dataset.shortLen=el.textContent.length-1;
        el.textContent=decodeURIComponent(atob(b64));
        btn.textContent='Restrânge ↑'; el.dataset.exp='1';
    }
}
function esc(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
                      .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}
function formatFans(n) {
    n=Number(n);
    if (n>=1000000) return (n/1000000).toFixed(1)+'M';
    if (n>=1000)    return (n/1000).toFixed(0)+'K';
    return String(n);
}
function formatDuration(sec) {
    if (!sec) return '';
    return `${Math.floor(sec/60)}:${String(sec%60).padStart(2,'0')}`;
}

document.addEventListener('wheel',(e)=>{
    const row=e.target.closest('.row-films,.filmography-scroll,.tracklist-wrap');
    if (!row) return; e.preventDefault(); row.scrollLeft+=e.deltaY*1.5;
},{passive:false});

/* ═══════════════════════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded',()=>{
    const sel=document.getElementById('genre-select');
    if (window.musicMap) {
        Object.entries(window.musicMap).forEach(([k,v])=>{
            const opt=document.createElement('option');
            opt.value=k; opt.textContent=`${v.emoji} ${v.label}`;
            sel.appendChild(opt);
        });
    }
    history.replaceState({ view:'idle', genre:null, subgen:null, query:null, albumId:null, artistId:null, scrollY:0 },'');
    renderIdleView();
    initCustomScrollbar();
});

/* ─── CSS preview buton (injectat dinamic) ───────────────────── */
const previewStyle = document.createElement('style');
previewStyle.textContent = `
.artist-link-btn {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    background: var(--accent-dim);
    border: 1.5px solid var(--accent);
    border-radius: 24px;
    color: var(--accent);
    font-size: 1rem;
    font-weight: 700;
    padding: 8px 18px;
    cursor: pointer;
    margin-bottom: 14px;
    font-family: inherit;
    transition: all 0.2s;
    letter-spacing: 0.3px;
}
.artist-link-btn:hover {
    background: var(--accent);
    color: #000;
    transform: translateY(-2px);
    box-shadow: 0 6px 20px rgba(245,197,24,0.35);
}
.artist-link-btn i { font-size: 0.9rem; }
.artist-link-arrow {
    font-size: 0.75rem;
    font-weight: 400;
    opacity: 0.75;
    border-left: 1px solid currentColor;
    padding-left: 10px;
    margin-left: 2px;
}
.track-play-btn {
    width:28px; height:28px; border-radius:50%; border:none;
    background:var(--accent-dim); color:var(--accent);
    font-size:10px; flex-shrink:0; cursor:pointer;
    display:flex; align-items:center; justify-content:center;
    transition:background 0.2s, transform 0.15s;
}
.track-play-btn:hover { background:var(--accent); color:#000; transform:scale(1.1); }
.track-play-btn.playing {
    background:var(--accent); color:#000;
    animation:playPulse 1s ease-in-out infinite;
}
@keyframes playPulse {
    0%,100% { box-shadow:0 0 0 0 rgba(245,197,24,0.4); }
    50%      { box-shadow:0 0 0 6px rgba(245,197,24,0); }
}
.has-preview .track-name { color:var(--text); }
`;
document.head.appendChild(previewStyle);

/* ─── Custom scrollbar ───────────────────────────────────────── */
function initCustomScrollbar() {
    const s=document.createElement('style');
    s.textContent='html{scrollbar-width:none}html::-webkit-scrollbar{display:none}';
    document.head.appendChild(s);
    const track=document.createElement('div'); track.id='custom-scrollbar-track';
    const thumb=document.createElement('div'); thumb.id='custom-scrollbar-thumb';
    track.appendChild(thumb); document.body.appendChild(track);
    function upd() {
        const dH=document.documentElement.scrollHeight,wH=window.innerHeight,sY=window.scrollY,tH=track.offsetHeight;
        if (dH<=wH) { track.style.opacity='0'; return; }
        track.style.opacity='1';
        const thH=Math.max(40,(wH/dH)*tH);
        thumb.style.height=thH+'px';
        thumb.style.top=((sY/(dH-wH))*(tH-thH))+'px';
    }
    window.addEventListener('scroll',upd,{passive:true});
    window.addEventListener('resize',upd);
    new MutationObserver(upd).observe(document.getElementById('app-viewport'),{childList:true,subtree:true});
    upd();
    let drag=false,dy=0,ds=0;
    thumb.addEventListener('mousedown',(e)=>{ drag=true;dy=e.clientY;ds=window.scrollY; document.body.style.userSelect='none';thumb.style.transition='none';e.preventDefault(); });
    document.addEventListener('mousemove',(e)=>{ if(!drag) return; const r=(document.documentElement.scrollHeight-window.innerHeight)/(track.offsetHeight-thumb.offsetHeight); window.scrollTo({top:ds+(e.clientY-dy)*r}); });
    document.addEventListener('mouseup',()=>{ if(!drag) return; drag=false;document.body.style.userSelect='';thumb.style.transition=''; });
    track.addEventListener('click',(e)=>{ if(e.target===thumb) return; const r=(e.clientY-track.getBoundingClientRect().top)/track.offsetHeight; window.scrollTo({top:r*(document.documentElement.scrollHeight-window.innerHeight),behavior:'smooth'}); });
}
