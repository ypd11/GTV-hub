// Robust JSON parsing to prevent crashes
function safeJsonParse(key, fallback) {
    try {
        const item = localStorage.getItem(key);
        return item ? JSON.parse(item) : fallback;
    } catch (e) {
        console.warn(`Resetting corrupted key: ${key}`);
        return fallback;
    }
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[char]));
}

function escapeInlineJsString(value) {
    return String(value ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/"/g, '&quot;')
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

function stripHtml(value) {
    return String(value ?? '').replace(/<[^>]*>/g, '');
}

function setElementVisible(element, visible, display = 'block') {
    if (!element) return;
    element.style.display = visible ? display : 'none';
    element.setAttribute('aria-hidden', visible ? 'false' : 'true');
    element.inert = !visible;
}

function setModalActive(elementOrId, active) {
    const element = typeof elementOrId === 'string' ? document.getElementById(elementOrId) : elementOrId;
    if (!element) return;
    element.classList.toggle('active', active);
    element.style.display = active ? 'flex' : 'none';
    element.setAttribute('aria-hidden', active ? 'false' : 'true');
    element.inert = !active;
}

const DEFAULT_TMDB_KEY = '40117ec337540a1736d7f1839665c417';
let savedKeys = safeJsonParse('gtv_saved_keys', []);

// Migration for old key style
const oldSingleKey = localStorage.getItem('gtv_custom_api_key');
if (oldSingleKey && oldSingleKey !== DEFAULT_TMDB_KEY) {
    if (!savedKeys.includes(oldSingleKey)) {
        savedKeys.push(oldSingleKey);
        localStorage.setItem('gtv_saved_keys', JSON.stringify(savedKeys));
    }
    localStorage.setItem('gtv_active_custom_key', oldSingleKey);
    localStorage.setItem('gtv_use_default_key', 'false');
    localStorage.removeItem('gtv_custom_api_key');
}

let useDefaultKey = localStorage.getItem('gtv_use_default_key') === 'true';
if (savedKeys.length === 0) useDefaultKey = true;

let activeCustomKey = localStorage.getItem('gtv_active_custom_key');
if (!activeCustomKey && savedKeys.length > 0) activeCustomKey = savedKeys[0];

let TMDB_KEY = useDefaultKey ? DEFAULT_TMDB_KEY : (activeCustomKey || DEFAULT_TMDB_KEY);
const TMDB_BASE = 'https://api.themoviedb.org/3';
const IMG_BASE = 'https://image.tmdb.org/t/p/w500';
const IMG_HERO = 'https://image.tmdb.org/t/p/original';

const dashboard = document.getElementById('dashboard');
const rowsContainer = document.getElementById('rows-container');
const detailsView = document.getElementById('details-view');
const detailsContent = document.getElementById('details-content');
const categoryView = document.getElementById('category-view');
const categoryList = document.getElementById('category-list');
const playerContainer = document.getElementById('player-container');
let iframe = document.getElementById('stream-frame');

let currentTab = localStorage.getItem('gtv_default_tab') || 'movie';
let activeNavigationSection = currentTab;
let currentCategoryPage = 1;
let currentCategoryApiUrl = '';
let currentSearchPage = 1;
let currentSearchQuery = '';
let heroCache = { movie: null, tv: null };
let sessionRecItems = { movie: { like: null }, tv: { like: null } };
let heroInterval = null; // For carousel auto-rotation
let dashboardRequestId = 0;

// User Data (Populated after profile selection)
let watchlist = [];
let likedContent = [];
let excludedContent = [];
let currentProfile = null;
let profiles = safeJsonParse('gtv_profiles', []);

let itemToRemoveId = null;
let currentDetailsData = null;
let allLoadedCategoryItems = [];
let navigationStack = [];
let skipNextNavigationCapture = false;
let guestSessionId = localStorage.getItem('gtv_guest_session_id');
let guestSessionExpiry = localStorage.getItem('gtv_guest_session_expiry');
let searchDebounceTimer;
let playerSources = ['https://vidfast.net', 'https://vidfast.pro', 'https://vidfast.in', 'https://vidfast.io', 'https://vidfast.pm', 'https://vidfast.xyz', 'https://player.videasy.net', 'https://vidnest.fun', 'https://www.vidking.net/embed', 'https://111movies.net', 'https://vsembed.ru/embed', 'https://vsembed.su/embed', 'https://vidsrc.xyz/embed', 'https://vidsrc-embed.ru/embed', 'https://vidsrcme.su/embed'];
let savedSource = localStorage.getItem('gtv_active_source');
if (savedSource && playerSources.includes(savedSource)) {
    playerSources = [savedSource, ...playerSources.filter(s => s !== savedSource)];
}
let currentSourceIdx = 0;
let isManualBack = false;
let appHistoryIndex = 0;
let pendingDeepLink = null;
let pendingCommunityRoute = null;
let currentPersonCredits = { knownFor: [], filmography: [] };

if (localStorage.getItem('gtv_reduced_motion') === 'true') {
    document.body.classList.add('reduced-motion');
}

document.addEventListener('DOMContentLoaded', async () => {
    // Global Error Handler for stability
    window.onerror = function(msg, url, line, col, error) {
        console.error("GTV Error:", msg, error);
        return false; 
    };

    // Preserve community links until a viewer has been selected.
    pendingCommunityRoute = window.location.hash;

    // Capture deep link params immediately
    const urlParams = new URLSearchParams(window.location.search);
    const movieId = urlParams.get('movie');
    const tvId = urlParams.get('tv');
    if (movieId || tvId) {
        pendingDeepLink = { movieId, tvId };
    }

    setupBranding();
    await initializeAuthentication();
    history.replaceState({ gtvhubNavigation: true, gtvhubIndex: 0 }, '', window.location.href);
    history.pushState({ gtvhubNavigation: true, gtvhubIndex: 1 }, '', window.location.href);
    appHistoryIndex = 1;
    setupNewNavigation();
    setupMobileCheck();
    
    // Register Service Worker for Caching
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js').catch(console.error);
    }
    
    // Browser Back navigates through GTV hub screens instead of leaving the app.
    window.addEventListener('hashchange', () => {
        const route = window.location.hash;
        if (route === '#community') window.openCommunityDirectory(true, true);
        else if (route.indexOf('#profile/') === 0) {
            const username = decodeURIComponent(route.slice('#profile/'.length));
            if (username) window.openCommunityProfile(username, true, true);
        }
    });
    window.addEventListener('popstate', (event) => {
        const state = event.state;
        if (state && state.gtvhubNavigation) {
            const nextIndex = Number(state.gtvhubIndex) || 0;
            if (nextIndex < appHistoryIndex) {
                appHistoryIndex = nextIndex;
                if (navigationStack.length) {
                    handleBack(true);
                } else {
                    // Keep the app open when Back reaches its root screen.
                    appHistoryIndex = 1;
                    history.pushState({ gtvhubNavigation: true, gtvhubIndex: appHistoryIndex }, '', window.location.href);
                }
                return;
            }
        }
    });

    // Back to Top Button
    const backToTopBtn = document.createElement('button');
    backToTopBtn.id = 'back-to-top';
    backToTopBtn.className = 'back-to-top';
    backToTopBtn.innerHTML = '<span class="material-icons">arrow_upward</span>';
    backToTopBtn.onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });
    document.body.appendChild(backToTopBtn);

    // Navbar scroll effect & Back to Top visibility
    window.addEventListener('scroll', () => {
        const nav = document.querySelector('.top-nav');
        if (window.scrollY > 50) nav.classList.add('scrolled');
        else nav.classList.remove('scrolled');

        if (window.scrollY > 300) backToTopBtn.classList.add('visible');
        else backToTopBtn.classList.remove('visible');
    });

    document.getElementById('close-player').onclick = closePlayer;
    
    // Setup Player Header
    const playerCont = document.getElementById('player-container');
    const header = document.createElement('div');
    header.className = 'player-header';
    
    const closeBtn = document.getElementById('close-player');
    if(closeBtn) {
        closeBtn.className = 'hero-icon-btn';
        closeBtn.innerHTML = '<span class="material-icons">arrow_back</span>';
        header.appendChild(closeBtn);
    }

    const rightActions = document.createElement('div');
    rightActions.style.display = 'flex';
    rightActions.style.alignItems = 'center';
    rightActions.style.gap = '10px';

    // Hide button
    const hideBtn = document.createElement('button');
    hideBtn.id = 'player-hide-btn';
    hideBtn.className = 'hero-icon-btn destructive';
    hideBtn.innerHTML = '<span class="material-icons">visibility_off</span>';
    hideBtn.title = 'Hide Content';
    rightActions.appendChild(hideBtn);

    // Fullscreen button (independent of the embedded server UI)
    const fullscreenBtn = document.createElement('button');
    fullscreenBtn.id = 'player-fullscreen-btn';
    fullscreenBtn.className = 'hero-icon-btn';
    fullscreenBtn.innerHTML = '<span class="material-icons">fullscreen</span>';
    fullscreenBtn.title = 'Fullscreen';
    fullscreenBtn.setAttribute('aria-label', 'Enter fullscreen');
    fullscreenBtn.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();

        try {
            if (document.fullscreenElement === playerCont || document.webkitFullscreenElement === playerCont) {
                if (document.exitFullscreen) await document.exitFullscreen();
                else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
            } else {
                if (playerCont.requestFullscreen) await playerCont.requestFullscreen();
                else if (playerCont.webkitRequestFullscreen) playerCont.webkitRequestFullscreen();
            }
        } catch (error) {
            console.warn('GTV hub: fullscreen request was denied.', error);
        }
    };

    // Small hint shown whenever GTV hub enters fullscreen.
    const fullscreenHint = document.createElement('div');
    fullscreenHint.id = 'player-fullscreen-hint';
    fullscreenHint.className = 'player-fullscreen-hint';
    fullscreenHint.textContent = 'Press Esc to exit fullscreen';
    fullscreenHint.setAttribute('role', 'status');
    fullscreenHint.setAttribute('aria-live', 'polite');
    playerCont.appendChild(fullscreenHint);

    let fullscreenHintTimer = null;
    const updateFullscreenButton = () => {
        const isFullscreen = document.fullscreenElement === playerCont || document.webkitFullscreenElement === playerCont;
        fullscreenBtn.innerHTML = '<span class="material-icons">' + (isFullscreen ? 'fullscreen_exit' : 'fullscreen') + '</span>';
        fullscreenBtn.title = isFullscreen ? 'Exit Fullscreen' : 'Fullscreen';
        fullscreenBtn.setAttribute('aria-label', isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen');

        if (isFullscreen) {
            fullscreenHint.classList.add('visible');
            if (fullscreenHintTimer) clearTimeout(fullscreenHintTimer);
            fullscreenHintTimer = setTimeout(() => fullscreenHint.classList.remove('visible'), 3500);
        } else {
            fullscreenHint.classList.remove('visible');
            if (fullscreenHintTimer) clearTimeout(fullscreenHintTimer);
        }
    };

    const handlePlayerFullscreenChange = () => {
        updateFullscreenButton();
        if (document.fullscreenElement === playerCont || document.webkitFullscreenElement === playerCont) {
            showPlayerControls();
        }
    };
    document.addEventListener('fullscreenchange', handlePlayerFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handlePlayerFullscreenChange);
    rightActions.appendChild(fullscreenBtn);

    // Server Selector Dropdown
    const serverContainer = document.createElement('div');
    serverContainer.className = 'server-select-container';
    serverContainer.style.position = 'relative';

    const switchBtn = document.createElement('button');
    switchBtn.id = 'server-switch-btn';
    switchBtn.className = 'hero-icon-btn';
    switchBtn.innerHTML = `<span class="material-icons">dns</span>`;
    switchBtn.onclick = (e) => {
        e.stopPropagation();
        const dd = document.getElementById('server-dropdown-menu');
        if(dd) dd.classList.toggle('active');
    };

    const dropdown = document.createElement('div');
    dropdown.id = 'server-dropdown-menu';
    dropdown.className = 'server-dropdown';
    
    // Populate dropdown
    playerSources.forEach((src, idx) => {
        const domain = new URL(src).hostname.replace('www.', '');
        const item = document.createElement('div');
        item.className = `server-option ${idx === currentSourceIdx ? 'active' : ''}`;
        item.innerHTML = `<span>${domain}</span> <span class="material-icons">check</span>`;
        item.onclick = () => selectPlayerSource(idx);
        dropdown.appendChild(item);
    });

    serverContainer.appendChild(switchBtn);
    serverContainer.appendChild(dropdown);
    
    rightActions.appendChild(serverContainer);

    // TV episode browser (only shown while a TV show is playing).
    const episodeBrowser = document.createElement('div');
    episodeBrowser.className = 'player-episodes-container';
    episodeBrowser.id = 'player-episodes-container';
    const episodesBtn = document.createElement('button');
    episodesBtn.id = 'player-episodes-btn';
    episodesBtn.className = 'hero-icon-btn';
    episodesBtn.innerHTML = '<span class="material-icons">video_library</span>';
    episodesBtn.title = 'Episodes';
    episodesBtn.setAttribute('aria-label', 'Browse episodes');
    episodesBtn.style.display = 'none';
    const episodesPanel = document.createElement('div');
    episodesPanel.id = 'player-episodes-panel';
    episodesPanel.className = 'player-episodes-panel';
    episodesPanel.innerHTML = '<div class="player-episodes-heading">Episodes</div><div class="player-episodes-loading">Loading seasons...</div>';
    episodesBtn.onclick = async (e) => {
        e.stopPropagation();
        const opening = !episodesPanel.classList.contains('active');
        episodesPanel.classList.toggle('active', opening);
        if (!opening) { showPlayerControls(); return; }
        if (episodesPanel.dataset.loadedFor === String(window.currentPlayInfo?.id)) {
            showPlayerControls();
            return;
        }
        const info = window.currentPlayInfo;
        if (!info || info.type !== 'tv') return;
        episodesPanel.dataset.loadedFor = String(info.id);
        episodesPanel.innerHTML = '<div class="player-episodes-heading">Episodes</div><div class="player-episodes-loading">Loading seasons...</div>';
        try {
            const response = await fetch(`${TMDB_BASE}/tv/${info.id}?api_key=${TMDB_KEY}`);
            const show = await response.json();
            const seasons = (show.seasons || []).filter(season => season.season_number > 0);
            if (!seasons.length) throw new Error('No seasons available');
            const seasonSelect = document.createElement('select');
            seasonSelect.className = 'player-season-select';
            seasons.forEach(season => {
                const option = document.createElement('option');
                option.value = season.season_number;
                option.textContent = `Season ${season.season_number}`;
                if (Number(season.season_number) === Number(info.season)) option.selected = true;
                seasonSelect.appendChild(option);
            });
            const episodeList = document.createElement('div');
            episodeList.className = 'player-episode-list';
            episodesPanel.innerHTML = '<div class="player-episodes-heading">Episodes</div>';
            episodesPanel.appendChild(seasonSelect);
            episodesPanel.appendChild(episodeList);
            const loadSeason = async (seasonNumber) => {
                episodeList.innerHTML = '<div class="player-episodes-loading">Loading episodes...</div>';
                const seasonResponse = await fetch(`${TMDB_BASE}/tv/${info.id}/season/${seasonNumber}?api_key=${TMDB_KEY}`);
                const seasonData = await seasonResponse.json();
                episodeList.innerHTML = '';
                (seasonData.episodes || []).forEach(ep => {
                    const episodeBtn = document.createElement('button');
                    episodeBtn.type = 'button';
                    episodeBtn.className = 'player-episode-option';
                    if (Number(seasonNumber) === Number(window.currentPlayInfo?.season) && Number(ep.episode_number) === Number(window.currentPlayInfo?.episode)) episodeBtn.classList.add('active');
                    episodeBtn.textContent = `E${ep.episode_number} · ${ep.name || 'Episode'}`;
                    episodeBtn.title = ep.name || `Episode ${ep.episode_number}`;
                    episodeBtn.onclick = (event) => {
                        event.stopPropagation();
                        episodesPanel.classList.remove('active');
                        playItem(info.id, 'tv', Number(seasonNumber), Number(ep.episode_number));
                    };
                    episodeList.appendChild(episodeBtn);
                });
                if (!episodeList.children.length) episodeList.innerHTML = '<div class="player-episodes-loading">No episodes found.</div>';
            };
            seasonSelect.onchange = () => loadSeason(Number(seasonSelect.value));
            await loadSeason(Number(seasonSelect.value));
        } catch (error) {
            episodesPanel.innerHTML = '<div class="player-episodes-heading">Episodes</div><div class="player-episodes-loading">Could not load episodes.</div>';
            console.warn('GTV hub: failed to load player episodes.', error);
        }
        showPlayerControls();
    };
    episodeBrowser.appendChild(episodesBtn);
    episodeBrowser.appendChild(episodesPanel);
    rightActions.appendChild(episodeBrowser);

    header.appendChild(rightActions);
    
    // Close dropdown on click outside
    window.addEventListener('click', (e) => {
        if (!e.target.closest('.server-select-container')) {
             const dd = document.getElementById('server-dropdown-menu');
             if(dd) dd.classList.remove('active');
        }
    });
    
    playerCont.insertBefore(header, playerCont.firstChild);

    // Auto-hide GTV hub controls, including while the pointer remains over
    // the cross-origin video iframe (whose internal pointer movement is inaccessible).
    let controlsHideTimer = null;
    const scheduleControlsHide = () => {
        if (controlsHideTimer) clearTimeout(controlsHideTimer);
        controlsHideTimer = setTimeout(() => {
            const dropdownOpen = document.getElementById('server-dropdown-menu')?.classList.contains('active');
            const episodesOpen = document.getElementById('player-episodes-panel')?.classList.contains('active');
            if (!dropdownOpen && !episodesOpen) {
                playerCont.classList.add('controls-hidden');
                // Prevent a focused toolbar button (for example, the fullscreen
                // button) from keeping the controls visible indefinitely.
                if (header.contains(document.activeElement)) {
                    document.activeElement.blur();
                }
            }
        }, 2500);
    };

    const showPlayerControls = () => {
        playerCont.classList.remove('controls-hidden');
        scheduleControlsHide();
    };

    playerCont.addEventListener('mousemove', showPlayerControls);
    playerCont.addEventListener('pointermove', showPlayerControls);
    playerCont.addEventListener('touchstart', showPlayerControls, { passive: true });
    playerCont.addEventListener('click', showPlayerControls);
    playerCont.addEventListener('keydown', showPlayerControls);

    // F toggles GTV hub fullscreen while the player is open.
    document.addEventListener('keydown', (e) => {
        if (e.key.toLowerCase() !== 'f' || e.altKey || e.ctrlKey || e.metaKey || e.repeat) return;

        const activeElement = document.activeElement;
        const isEditing = activeElement && (
            activeElement.isContentEditable ||
            /^(INPUT|TEXTAREA|SELECT)$/.test(activeElement.tagName)
        );
        if (isEditing || playerCont.style.display === 'none') return;

        e.preventDefault();
        e.stopPropagation();
        showPlayerControls();
        fullscreenBtn.click();
    }, true);

    // The browser only exposes iframe boundary events, not pointer movement inside it.
    window.showGtvPlayerControls = showPlayerControls;
    window.bindGtvPlayerFrameEvents = () => {
        const streamFrame = document.getElementById('stream-frame');
        if (streamFrame && !streamFrame.dataset.controlsEventsBound) {
            streamFrame.dataset.controlsEventsBound = 'true';
            streamFrame.addEventListener('mouseenter', showPlayerControls);
            streamFrame.addEventListener('mouseleave', showPlayerControls);
        }
    };
    window.bindGtvPlayerFrameEvents();

    header.addEventListener('mouseenter', () => {
        if (controlsHideTimer) clearTimeout(controlsHideTimer);
        playerCont.classList.remove('controls-hidden');
    });
    header.addEventListener('mouseleave', showPlayerControls);

    // Inject Cast Modal HTML
    const modalHtml = `
    <div id="cast-modal-overlay" class="modal-overlay" onclick="closeCastModal(event)">
        <div class="cast-modal">
            <button class="close-modal-btn" onclick="closeCastModal(event, true)"><span class="material-icons">close</span></button>
            <div class="cast-modal-content">
                <div id="cast-modal-img-container"></div>
                <div class="cast-modal-info">
                    <h2 id="cast-modal-name"></h2>
                    <p id="cast-modal-bio"></p>
                    <div id="cast-modal-actions" style="margin-top: 20px;"></div>
                    <div id="cast-modal-meta" style="margin-top:15px; font-size:0.85rem; color:#888;"></div>
                </div>
            </div>
        </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', modalHtml);

    // Inject Trailer Modal HTML
    const trailerModalHtml = `
    <div id="trailer-modal-overlay" class="modal-overlay" onclick="closeTrailerModal(event)">
        <div class="trailer-modal">
            <button class="close-modal-btn" onclick="closeTrailerModal(event, true)" style="top: -40px; right: 0;"><span class="material-icons">close</span></button>
            <div class="trailer-container">
                <iframe id="trailer-frame" frameborder="0" allowfullscreen></iframe>
            </div>
        </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', trailerModalHtml);

    // Inject Confirmation Modal HTML
    const confirmModalHtml = `
    <div id="confirm-modal-overlay" class="modal-overlay">
        <div class="confirmation-modal">
            <h3>Remove from Watchlist?</h3>
            <div class="modal-body">Are you sure you want to remove this item?</div>
            <div class="confirmation-btns">
                <button onclick="closeConfirmModal()" class="more-info-btn" style="border:1px solid rgba(255,255,255,0.2);">Cancel</button>
                <button onclick="confirmRemove()" class="play-btn remove-confirm-btn">Remove</button>
            </div>
        </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', confirmModalHtml);

    // Inject Rating Modal HTML
    const ratingModalHtml = `
    <div id="rating-modal-overlay" class="modal-overlay" onclick="closeRatingModal(event)">
        <div class="confirmation-modal" style="max-width: 400px; width: 90%; padding: 0; overflow: hidden; background: #1a1a1a; border-radius: 16px; display: flex; flex-direction: column; border: 1px solid rgba(255,255,255,0.1);">
            
            <!-- Image Section -->
            <div style="position: relative; height: 180px; width: 100%; flex-shrink: 0; background: #222; display: flex; align-items: center; justify-content: center;">
                <span class="material-icons" style="font-size: 64px; color: rgba(255,255,255,0.1);">movie</span>
                <div id="rating-modal-bg" style="position: absolute; inset: 0; background-size: cover; background-position: center;"></div>
                <div style="position: absolute; inset: 0; background: linear-gradient(to bottom, rgba(0,0,0,0) 0%, rgba(26,26,26,1) 100%);"></div>
                <button class="close-modal-btn" onclick="closeRatingModal(event)" style="top: 15px; right: 15px; background: rgba(0,0,0,0.6); width: 32px; height: 32px; z-index: 10;"><span class="material-icons" style="font-size: 18px;">close</span></button>
                <h3 id="rating-modal-title" style="position: absolute; bottom: 15px; left: 25px; right: 25px; margin: 0; font-size: 1.3rem; text-shadow: 0 2px 10px rgba(0,0,0,0.8); color: #fff; z-index: 2; line-height: 1.2;">Rate Title</h3>
            </div>

            <!-- Rating UI Section -->
            <div style="padding: 10px 30px 30px 30px; text-align: center; background: #1a1a1a;">
                <div id="rating-value-display" style="font-size: 4rem; font-weight: 800; color: #f1c40f; line-height: 1; margin-bottom: 25px; text-shadow: 0 0 20px rgba(241, 196, 15, 0.2);">5.0</div>
                
                <div style="margin-bottom: 30px;">
                    <input type="range" id="rating-slider" min="0.5" max="10" step="0.5" value="5" style="width: 100%; accent-color: var(--accent); cursor: pointer; height: 6px; border-radius: 3px; margin-bottom: 12px;" oninput="const v=parseFloat(this.value); const d=document.getElementById('rating-value-display'); d.innerText=v.toFixed(1); d.style.color=getRatingColor(v); d.style.textShadow='0 0 20px '+getRatingColor(v)+'40';">
                    <div style="display:flex; justify-content:space-between; color:#666; font-size:0.7rem; font-weight:700; text-transform: uppercase; letter-spacing: 1px;">
                        <span>Poor</span>
                        <span>Average</span>
                        <span>Masterpiece</span>
                    </div>
                </div>
                <button id="submit-rating-btn" class="play-btn" style="width:100%; justify-content: center; padding: 14px; font-size: 1rem; box-shadow: 0 4px 20px rgba(52, 152, 219, 0.2);">Submit Rating</button>
            </div>
        </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', ratingModalHtml);
    document.querySelectorAll('.modal-overlay').forEach((modal) => setModalActive(modal, false));
    const searchOverlay = document.getElementById('search-modal-overlay');
    if (searchOverlay) {
        searchOverlay.setAttribute('aria-hidden', 'true');
        searchOverlay.inert = true;
    }

    // Check for Deep Links (Shared URLs)
    // This is now handled inside initApp() to ensure it runs before profile selection.
});


const SUPABASE_URL = 'https://fvjlovsvihuzrajzndap.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_d6tKvsXFUGkI59kXvKiy9Q_Z-6-tKMR';
let supabaseClient = null;
let authUser = null;
let guestMode = false;
let cloudProfileMode = false;
let authMode = 'login';
let cloudDataLoading = false;
let profileSettings = {};
let authDialogMode = false;
let authReturnToApp = false;
let authDialogPreviousNoScroll = false;
let authDialogPreviousProfileDisplay = null;
let passwordRecoveryPending = window.location.hash.includes('type=recovery') || new URLSearchParams(window.location.search).get('type') === 'recovery';

// Remove the initial startup cover only after the first real app screen is ready.
function dismissStartupScreen() {
    const startup = document.getElementById('startup-screen');
    if (!startup || startup.classList.contains('is-leaving')) return;
    startup.classList.add('is-leaving');
    window.setTimeout(() => startup.remove(), 300);
}

function showAuthMessage(message, isError = false) {
    const el = document.getElementById('auth-message');
    if (!el) return;
    el.textContent = message || '';
    el.classList.toggle('error', !!isError);
}

function renderAuthView(mode = 'login', message = '', isError = false, asDialog = true) {
    authMode = mode;
    // Authentication is always presented as a compact dialog, never as a full-page screen.
    authDialogMode = true;
    const authView = document.getElementById('auth-view');
    authView.classList.add('auth-dialog');
    setElementVisible(authView, true, 'flex');

    const closeButton = document.getElementById('auth-dialog-close');
    if (closeButton) closeButton.style.display = 'flex';
    document.body.classList.add('no-scroll');

    const signup = mode === 'signup';
    const reset = mode === 'reset';
    const updatePassword = mode === 'update-password';
    authView.classList.toggle('auth-reset-mode', reset || updatePassword);
    document.getElementById('auth-title').innerHTML = reset ? 'Reset your password' : (updatePassword ? 'Choose a new password' : (signup ? 'Create your account' : 'Your entertainment, all in one place.'));
    document.getElementById('auth-subtitle').textContent = reset
        ? 'We’ll email you a link to choose a new password.'
        : (updatePassword ? 'Choose a new password for your GTV hub account.' : (signup ? 'Create an account to keep your profiles and watchlist in sync.' : 'Sign in to continue where you left off.'));
    document.getElementById('auth-email').style.display = updatePassword ? 'none' : '';
    document.querySelector('label[for="auth-email"]').style.display = updatePassword ? 'none' : '';
    document.getElementById('auth-email').required = !updatePassword;
    document.getElementById('auth-password').style.display = reset ? 'none' : '';
    document.querySelector('label[for="auth-password"]').style.display = reset ? 'none' : '';
    document.getElementById('auth-password').required = !reset;
    document.getElementById('auth-confirm-wrap').style.display = (signup || updatePassword) ? 'block' : 'none';
    document.getElementById('auth-confirm-password').required = signup || updatePassword;
    document.getElementById('auth-submit').textContent = reset ? 'Send reset link' : (updatePassword ? 'Update Password' : (signup ? 'Create Account' : 'Sign In'));
    document.getElementById('auth-mode-toggle').style.display = (reset || updatePassword) ? '' : '';
    document.getElementById('auth-mode-toggle').textContent = (reset || updatePassword) ? 'Back to sign in' : (signup ? 'Already have an account? Sign in' : 'Create an account');
    document.getElementById('auth-reset-link').style.display = (!signup && !reset && !updatePassword) ? '' : 'none';
    document.querySelector('.auth-divider').style.display = (reset || updatePassword) ? 'none' : '';
    document.querySelector('.auth-guest-btn').style.display = (reset || updatePassword) ? 'none' : '';
    showAuthMessage(message, isError);
    dismissStartupScreen();
}
window.openAccountSignIn = () => {
    authDialogPreviousNoScroll = document.body.classList.contains('no-scroll');
    const profileView = document.getElementById('profile-view');
    authDialogPreviousProfileDisplay = profileView ? profileView.style.display : null;
    // The profile picker is a separate full-screen view; hide it while the dialog is open.
    if (profileView) profileView.style.display = 'none';
    authReturnToApp = true;
    const dropdown = document.getElementById('nav-dropdown');
    if (dropdown) dropdown.classList.remove('active');
    renderAuthView('login', '', false, true);
    document.getElementById('auth-email').focus();
};

window.closeAccountSignIn = () => {
    if (!authDialogMode) return;
    setElementVisible(document.getElementById('auth-view'), false);
    document.getElementById('auth-view').classList.remove('auth-dialog');
    authDialogMode = false;
    authReturnToApp = false;
    const profileView = document.getElementById('profile-view');
    if (profileView && authDialogPreviousProfileDisplay !== null) {
        profileView.style.display = authDialogPreviousProfileDisplay;
    }
    authDialogPreviousProfileDisplay = null;
    document.body.classList.toggle('no-scroll', authDialogPreviousNoScroll);
};

let gtvNoticeDialogAction = null;
let gtvNoticeDialogCancel = null;
let gtvNoticePreviousNoScroll = false;

window.showGtvNoticeDialog = (options = {}) => {
    let overlay = document.getElementById('gtv-notice-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'gtv-notice-overlay';
        overlay.className = 'gtv-notice-overlay';
        overlay.innerHTML = `
            <section class="gtv-notice-dialog" role="dialog" aria-modal="true" aria-labelledby="gtv-notice-title">
                <button class="gtv-notice-close" type="button" aria-label="Close dialog"><span class="material-icons">close</span></button>
                <div class="gtv-notice-icon"><span class="material-icons" id="gtv-notice-icon">info</span></div>
                <h2 id="gtv-notice-title"></h2>
                <p id="gtv-notice-message"></p>
                <div class="gtv-notice-actions">
                    <button class="play-btn gtv-notice-action" id="gtv-notice-action" type="button">Got it</button>
                    <button class="gtv-notice-secondary" id="gtv-notice-secondary" type="button">Not now</button>
                </div>
            </section>`;
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay || event.target.closest('.gtv-notice-close')) {
                window.closeGtvNoticeDialog();
            }
        });
        overlay.querySelector('#gtv-notice-action').addEventListener('click', () => {
            const action = gtvNoticeDialogAction;
            gtvNoticeDialogCancel = null;
            window.closeGtvNoticeDialog();
            if (typeof action === 'function') action();
        });
        overlay.querySelector('#gtv-notice-secondary').addEventListener('click', () => {
            window.closeGtvNoticeDialog();
        });
        document.body.appendChild(overlay);
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && overlay.classList.contains('active')) {
                window.closeGtvNoticeDialog();
            }
        });
    }

    gtvNoticePreviousNoScroll = document.body.classList.contains('no-scroll');
    document.getElementById('gtv-notice-icon').textContent = options.icon || 'info';
    document.getElementById('gtv-notice-title').textContent = options.title || 'A quick note';
    document.getElementById('gtv-notice-message').textContent = options.message || '';
    const actionButton = document.getElementById('gtv-notice-action');
    const secondaryButton = document.getElementById('gtv-notice-secondary');
    actionButton.textContent = options.buttonLabel || 'Got it';
    actionButton.style.display = options.buttonLabel === false ? 'none' : '';
    secondaryButton.textContent = options.secondaryButtonLabel || 'Not now';
    secondaryButton.style.display = options.secondaryButtonLabel ? '' : 'none';
    gtvNoticeDialogAction = typeof options.onAction === 'function' ? options.onAction : null;
    gtvNoticeDialogCancel = typeof options.onSecondaryAction === 'function' ? options.onSecondaryAction : null;
    overlay.classList.add('active');
    overlay.setAttribute('aria-hidden', 'false');
    document.body.classList.add('no-scroll');
    actionButton.focus();
};

window.closeGtvNoticeDialog = () => {
    const overlay = document.getElementById('gtv-notice-overlay');
    if (!overlay || !overlay.classList.contains('active')) return;
    overlay.classList.remove('active');
    overlay.setAttribute('aria-hidden', 'true');
    document.body.classList.toggle('no-scroll', gtvNoticePreviousNoScroll);
    gtvNoticeDialogAction = null;
    const cancel = gtvNoticeDialogCancel;
    gtvNoticeDialogCancel = null;
    if (typeof cancel === 'function') cancel();
};

window.showFeatureMaintenanceDialog = (featureName = 'This feature', onContinue = null) => {
    window.showGtvNoticeDialog({
        icon: 'build',
        title: featureName + ' is being improved',
        message: 'We’re currently working on this feature. Some parts of the experience are still being finalized. Thank you for your patience!',
        buttonLabel: 'Continue',
        onAction: onContinue
    });
};

window.toggleAuthMode = () => {
    if (authMode === 'signup' || authMode === 'reset' || authMode === 'update-password') {
        renderAuthView('login');
        return;
    }
    renderAuthView('signup');
};

window.submitAuthForm = async (event) => {
    event.preventDefault();
    if (!supabaseClient) return showAuthMessage('The sign-in service is unavailable. Please refresh and try again.', true);
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;
    const confirmPassword = document.getElementById('auth-confirm-password').value;
    const button = document.getElementById('auth-submit');
    button.disabled = true;
    showAuthMessage(authMode === 'signup' ? 'Creating your account…' : 'Please wait…');
    try {
        if (authMode === 'update-password') {
            if (password !== confirmPassword) throw new Error('The passwords do not match.');
            const { error } = await supabaseClient.auth.updateUser({ password });
            if (error) throw error;
            await supabaseClient.auth.signOut();
            renderAuthView('login', 'Your password has been updated. Please sign in with your new password.');
        } else if (authMode === 'signup') {
            if (password !== confirmPassword) throw new Error('The passwords do not match.');
            const { data, error } = await supabaseClient.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin + '/email-confirmed.html' } });
            if (error) throw error;
            if (data.session) {
                authUser = data.user;
                await enterAccount();
            } else {
                const wasDialog = authDialogMode;
                renderAuthView('login', '', false, wasDialog);
                document.getElementById('auth-password').value = '';
                document.getElementById('auth-confirm-password').value = '';
                window.showGtvNoticeDialog({
                    icon: 'mark_email_read',
                    title: 'Check your email',
                    message: 'Your account registration was successful. We sent a confirmation link to ' + email + '. Open that email and confirm your address before signing in to GTV hub.',
                    buttonLabel: 'Got it'
                });
            }
        } else if (authMode === 'login') {
            const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
            if (error) throw error;
            authUser = data.user;
            await enterAccount();
        } else if (authMode === 'reset') {
            const { error } = await supabaseClient.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin + '/reset-password.html' });
            if (error) throw error;
            renderAuthView('login', 'Password reset email sent. Check your inbox.', false, authDialogMode);
        }
    } catch (error) {
        showAuthMessage(error.message || 'Something went wrong. Please try again.', true);
    } finally {
        button.disabled = false;
    }
};

window.sendPasswordReset = () => {
    const email = document.getElementById('auth-email').value.trim();
    renderAuthView('reset', email ? 'We’ll send the reset link to ' + email + '.' : 'Enter your email address, then send the reset link.', false, authDialogMode);
    if (email) document.getElementById('auth-email').value = email;
};

window.continueAsGuest = () => {
    guestMode = true;
    cloudProfileMode = false;
    authUser = null;
    setElementVisible(document.getElementById('auth-view'), false);
    document.body.classList.remove('no-scroll');
    initApp();
};

function isAnonymousSupabaseUser(user) {
    return !!user && (
        user.is_anonymous === true ||
        (user.app_metadata && user.app_metadata.provider === 'anonymous')
    );
}

async function initializeAuthentication() {
    if (!window.supabase || !window.supabase.createClient) {
        renderAuthView('login', 'Could not load the sign-in service. Check your connection and refresh.', true);
        return;
    }
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    supabaseClient.auth.onAuthStateChange((event, session) => {
        if (event === 'PASSWORD_RECOVERY' && session) {
            passwordRecoveryPending = true;
            authUser = session.user;
            renderAuthView('update-password');
        }
    });
    const { data, error } = await supabaseClient.auth.getSession();
    if (error) console.warn('Could not restore Supabase session:', error.message);
    if (data && data.session) {
        const sessionUser = data.session.user;
        if (isAnonymousSupabaseUser(sessionUser)) {
            // Clean up legacy anonymous sessions created by the retired feature.
            await supabaseClient.auth.signOut();
            authUser = null;
            guestMode = true;
            cloudProfileMode = false;
            profiles = safeJsonParse('gtv_profiles', []);
            initApp();
        } else {
            authUser = sessionUser;
            if (passwordRecoveryPending) renderAuthView('update-password');
            else await enterAccount();
        }
    } else {
        // Start unauthenticated visitors in guest mode at the profile picker.
        guestMode = true;
        cloudProfileMode = false;
        authUser = null;
        profiles = safeJsonParse('gtv_profiles', []);
        initApp();
    }
}

async function enterAccount() {
    guestMode = false;
    cloudProfileMode = true;
    try {
        await loadAccountProfiles();
        setElementVisible(document.getElementById('auth-view'), false);
        document.getElementById('auth-view').classList.remove('auth-dialog');
        document.body.classList.remove('no-scroll');

        if (authReturnToApp) {
            authReturnToApp = false;
            authDialogMode = false;
            setElementVisible(document.getElementById('profile-view'), false);
            const nav = document.querySelector('.top-nav');
            if (nav) nav.style.display = 'flex';
            if (profiles.length) await selectProfile(profiles[0].id);
            else renderProfileScreen();
        } else {
            authDialogMode = false;
            renderProfileScreen();
        }
    } catch (error) {
        console.error('Could not load account profiles:', error);
        renderAuthView('login', 'Signed in, but your profiles could not be loaded. Please try again.', true, authReturnToApp);
    }
}

async function loadAccountProfiles() {
    const { data, error } = await supabaseClient
        .from('profiles')
        .select('id,name,color,position')
        .eq('user_id', authUser.id)
        .order('position', { ascending: true });
    if (error) throw error;
    profiles = data || [];

    const localProfiles = safeJsonParse('gtv_profiles', []);
    const migrationKey = 'gtv_cloud_migrated_' + authUser.id;
    if (localProfiles.length && !localStorage.getItem(migrationKey)) {
        const importableLocalProfiles = localProfiles.filter(profile =>
            profile && typeof profile.name === 'string' && profile.name.trim().toLowerCase() !== 'default'
        );
        if (importableLocalProfiles.length && profiles.length < 5) {
            const importLocal = await new Promise(resolve => {
                window.showGtvNoticeDialog({
                    icon: 'cloud_upload',
                    title: 'Import your profiles?',
                    message: 'We found profiles saved on this device. Import them into your GTV hub account to keep them in sync across your devices.',
                    buttonLabel: 'Import profiles',
                    secondaryButtonLabel: 'Not now',
                    onAction: () => resolve(true),
                    onSecondaryAction: () => resolve(false)
                });
            });
            if (importLocal) {
                const availableSlots = Math.max(0, 5 - profiles.length);
                const profilesToImport = importableLocalProfiles.slice(0, availableSlots);
                for (const old of profilesToImport) {
                    const { data: created, error: createError } = await supabaseClient
                        .from('profiles')
                        .insert({ user_id: authUser.id, name: old.name, color: old.color || '#3498db', position: profiles.length })
                        .select('id,name,color,position').single();
                    if (createError) throw createError;
                    const oldId = old.id;
                    const payload = {
                        profile_id: created.id,
                        watchlist: safeJsonParse('gtv_watchlist_' + oldId, []),
                        liked_content: safeJsonParse('gtv_liked_content_' + oldId, []),
                        excluded_content: safeJsonParse('gtv_excluded_content_' + oldId, []),
                        watch_history: safeJsonParse('gtv_watch_history_' + oldId, []),
                        settings: {}
                    };
                    const { error: dataError } = await supabaseClient.from('profile_data').insert(payload);
                    if (dataError) throw dataError;
                    profiles.push(created);
                }
                if (importableLocalProfiles.length > profilesToImport.length) {
                    showToast('Only the profiles that fit your account limit were imported. You can add the rest later.');
                }
            }
        }
        localStorage.setItem(migrationKey, 'true');
    }

    if (profiles.length === 0) {
        const { data: created, error: createError } = await supabaseClient
            .from('profiles')
            .insert({ user_id: authUser.id, name: 'Default', color: '#3498db', position: 0 })
            .select('id,name,color,position').single();
        if (createError) throw createError;
        const { error: dataError } = await supabaseClient.from('profile_data').insert({ profile_id: created.id });
        if (dataError) throw dataError;
        profiles = [created];
    }
}

async function persistCurrentProfileData() {
    if (!cloudProfileMode || !supabaseClient || !currentProfile || cloudDataLoading) return;
    const payload = {
        profile_id: currentProfile.id,
        watchlist: watchlist,
        liked_content: likedContent,
        excluded_content: excludedContent,
        watch_history: safeJsonParse('gtv_watch_history_' + currentProfile.id, []),
        settings: profileSettings
    };
    const { error } = await supabaseClient.from('profile_data').upsert(payload, { onConflict: 'profile_id' });
    if (error) console.error('Could not sync profile data:', error.message);
}

async function signOutAccount() {
    if (!supabaseClient) return;
    const { error } = await supabaseClient.auth.signOut();
    if (error) return showToast('Could not sign out: ' + error.message);

    authUser = null;
    cloudProfileMode = false;
    guestMode = true;
    authDialogMode = false;
    authReturnToApp = false;
    currentProfile = null;
    watchlist = [];
    likedContent = [];
    excludedContent = [];
    cloudDataLoading = false;
    profiles = safeJsonParse('gtv_profiles', []);

    setElementVisible(document.getElementById('auth-view'), false);
    document.getElementById('auth-view').classList.remove('auth-dialog');
    setElementVisible(document.getElementById('profile-view'), false);
    document.body.classList.remove('no-scroll');
    const nav = document.querySelector('.top-nav');
    if (nav) nav.style.display = 'flex';

    if (profiles.length) renderProfileScreen();
    else initApp();
}


function setupBranding() {
    document.title = 'GTV hub - Movies & TV Shows';
    const style = document.createElement('style');
    style.textContent = `
        :root {
            --accent: #3498db; /* GTV/hub style blue accent */
        }
    `;
    document.head.appendChild(style);
}

function initApp() {
    // Migration: Rename "My Profile" to "Default" if found
    const myProfile = profiles.find(p => p.name === 'My Profile');
    if (myProfile) {
        myProfile.name = 'Default';
        localStorage.setItem('gtv_profiles', JSON.stringify(profiles));
    }

    // Check if we have profiles
    if (profiles.length === 0) {
        createProfile('Default');
    } else {
        // Always show profile screen on reload to be like Netflix
        renderProfileScreen();
    }
}

function setupNewNavigation() {
    const navLinks = document.querySelector('.nav-links');
    if (!navLinks) return;
    
    // Clear existing items
    navLinks.innerHTML = '';

    // Movies
    const moviesBtn = document.createElement('div');
    moviesBtn.className = 'nav-item';
    moviesBtn.textContent = 'Movies';
    moviesBtn.onclick = () => switchTab('movie');
    moviesBtn.id = 'nav-movie';
    if(activeNavigationSection === 'movie') moviesBtn.classList.add('active');
    navLinks.appendChild(moviesBtn);

    // TV Shows
    const tvBtn = document.createElement('div');
    tvBtn.className = 'nav-item';
    tvBtn.textContent = 'TV Shows';
    tvBtn.onclick = () => switchTab('tv');
    tvBtn.id = 'nav-tv';
    if(activeNavigationSection === 'tv') tvBtn.classList.add('active');
    navLinks.appendChild(tvBtn);

    // People discovery
    const peopleBtn = document.createElement('div');
    peopleBtn.className = 'nav-item';
    peopleBtn.textContent = 'People';
    peopleBtn.id = 'nav-people';
    peopleBtn.onclick = openPeople;
    if(activeNavigationSection === 'people') peopleBtn.classList.add('active');
    navLinks.appendChild(peopleBtn);

    // Search Button
    const searchBtn = document.createElement('div');
    searchBtn.className = 'nav-item nav-search-btn';
    searchBtn.innerHTML = '<span class="material-icons">search</span>';
    searchBtn.onclick = openSearchModal;
    navLinks.appendChild(searchBtn);

    // Menu Button
    const menuBtn = document.createElement('div');
    menuBtn.className = 'nav-item nav-menu-btn';
    menuBtn.innerHTML = '<span class="material-icons">menu</span>';
    menuBtn.onclick = (e) => {
        e.stopPropagation();
        const dropdown = document.getElementById('nav-dropdown');
        dropdown.classList.toggle('active');
    };
    navLinks.appendChild(menuBtn);

    // Dropdown (Inject into body)
    const dropdown = document.createElement('div');
    dropdown.id = 'nav-dropdown';
    dropdown.className = 'nav-dropdown';
    dropdown.innerHTML = `
        <div class="dropdown-item" onclick="openProfilePicker(); document.getElementById('nav-dropdown').classList.remove('active');"><span class="material-icons">people</span> Switch Profile</div>
        <div class="dropdown-item" onclick="openCategories(); document.getElementById('nav-dropdown').classList.remove('active');"><span class="material-icons">category</span> Categories</div>
            <div class="dropdown-item" onclick="openPeople(); document.getElementById('nav-dropdown').classList.remove('active');"><span class="material-icons">person_search</span> People</div>
        <div class="dropdown-item" onclick="openCommunityDirectory(); document.getElementById('nav-dropdown').classList.remove('active');"><span class="material-icons">groups</span> Community</div>
        <div class="dropdown-item" onclick="randomPick();"><span class="material-icons">shuffle</span> Random Pick</div>
        <div class="dropdown-item" onclick="openWatchlist();"><span class="material-icons">list</span> My Watchlist</div>
        <div class="dropdown-item" onclick="openHiddenContent();"><span class="material-icons">visibility_off</span> Hidden Content</div>
        <div class="dropdown-item" onclick="openSettingsView(); document.getElementById('nav-dropdown').classList.remove('active');"><span class="material-icons">settings</span> Settings</div>
        <div class="dropdown-item" onclick="openChangelogView(); document.getElementById('nav-dropdown').classList.remove('active');"><span class="material-icons">history</span> Changelog</div>
        ${cloudProfileMode
            ? '<div class="dropdown-item" onclick="signOutAccount(); document.getElementById(\'nav-dropdown\').classList.remove(\'active\');"><span class="material-icons">logout</span> Sign Out</div>'
            : '<div class="dropdown-item" onclick="openAccountSignIn()"><span class="material-icons">login</span> Sign In</div>'}
    `;
    document.body.appendChild(dropdown);

    // Search Modal (Inject into body)
    const searchModal = document.createElement('div');
    searchModal.id = 'search-modal-overlay';
    searchModal.className = 'search-modal-overlay';
    searchModal.innerHTML = `
        <div class="search-modal">
            <div class="search-header">
                <span class="material-icons search-icon">search</span>
                <input type="text" id="modal-search-input" placeholder="What's on your mind?" autofocus>
                <button class="close-search-btn" onclick="closeSearchModal()"><span class="material-icons">close</span></button>
            </div>
            <div id="modal-search-results" class="search-results"></div>
        </div>
    `;
    document.body.appendChild(searchModal);
    
    // Setup Search Listener
    const input = document.getElementById('modal-search-input');
    const peopleInput = document.getElementById('people-search-input');
    if (peopleInput) {
        peopleInput.addEventListener('input', () => {
            clearTimeout(peopleSearchTimer);
            const value = peopleInput.value;
            peopleSearchTimer = setTimeout(() => searchPeople(value), 350);
        });
        document.getElementById('people-search-clear').addEventListener('click', () => {
            peopleInput.value = '';
            searchPeople('');
            peopleInput.focus();
        });
    }
    input.addEventListener('input', (e) => {
        if (e.target.value.trim().length === 0) renderSearchHistory();
        else handleSearchInput(e);
    });
    input.addEventListener('focus', () => {
        if (input.value.trim().length === 0) renderSearchHistory();
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            saveSearchQuery(input.value);
            handleSearchInput(e);
            input.blur();
        }
    });
    
    // Close on click outside
    window.addEventListener('click', (e) => {
        if (!e.target.closest('.nav-menu-btn') && !e.target.closest('.nav-dropdown')) {
            const dd = document.getElementById('nav-dropdown');
            if(dd) dd.classList.remove('active');
        }
        if (e.target.id === 'search-modal-overlay') {
            closeSearchModal();
        }
    });
}

window.openSearchModal = () => {
    document.getElementById('nav-dropdown').classList.remove('active');
    const modal = document.getElementById('search-modal-overlay');
    modal.classList.add('active');
    modal.setAttribute('aria-hidden', 'false');
    modal.inert = false;
    const input = document.getElementById('modal-search-input');
    input.value = '';
    renderSearchHistory();
    setTimeout(() => input.focus(), 100);
};

window.closeSearchModal = (preserveState = false) => {
    const modal = document.getElementById('search-modal-overlay');
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
    modal.inert = true;
    if (!preserveState) {
        document.getElementById('modal-search-input').value = '';
        document.getElementById('modal-search-results').innerHTML = '';
    }
};

window.handleSearchResultClick = (query, id, type) => {
    saveSearchQuery(query);

    // Preserve the complete search overlay before navigating to a result.
    captureAndPushState();
    closeSearchModal();
    skipNextNavigationCapture = true;

    if (type === 'person') {
        activeNavigationSection = 'people';
        setupNewNavigation();
        setPeopleView('person');
        openPersonProfile(id);
        return;
    }
    if (type !== currentTab && (type === 'movie' || type === 'tv')) {
        currentTab = type;
        activeNavigationSection = type;
        setupNewNavigation();
    }
    openDetails(id, type);
};

let searchRequestId = 0;

async function handleSearchInput(e) {
    const query = e.target.value.trim();
    const resultsContainer = document.getElementById('modal-search-results');

    clearTimeout(searchDebounceTimer);
    const requestId = ++searchRequestId;
    currentSearchQuery = query;
    currentSearchPage = 1;

    if (query.length === 0) {
        renderSearchHistory();
        return;
    }

    if (query.length < 2) {
        resultsContainer.innerHTML = '<div class="search-state"><span class="material-icons">keyboard</span><strong>Keep typing</strong><span>Enter at least 2 characters to search.</span></div>';
        return;
    }

    resultsContainer.innerHTML = '<div class="search-state"><span class="search-spinner"></span><strong>Searching</strong><span>Looking across movies, TV shows and people…</span></div>';

    searchDebounceTimer = setTimeout(async () => {
        try {
            const res = await fetch(`${TMDB_BASE}/search/multi?api_key=${TMDB_KEY}&query=${encodeURIComponent(query)}&page=1`);
            if (!res.ok) throw new Error(`Search request failed: ${res.status}`);
            const data = await res.json();

            if (requestId !== searchRequestId || query !== document.getElementById('modal-search-input').value.trim()) return;

            const itemsHtml = generateSearchItemsHtml(data.results);
            if (!itemsHtml) {
                resultsContainer.innerHTML = '<div class="search-state"><span class="material-icons">search_off</span><strong>No results found</strong><span>Try a different title, actor or keyword.</span></div>';
                return;
            }

            resultsContainer.innerHTML = itemsHtml;
            if (data.total_pages > 1) {
                const btnHtml = `
                    <div id="search-load-more-btn" style="text-align:center; padding:15px;">
                        <button class="more-info-btn" onclick="loadMoreSearch()" style="display:inline-flex; margin:0 auto; font-size:0.8rem; padding:8px 20px;">Load More</button>
                    </div>`;
                resultsContainer.insertAdjacentHTML('beforeend', btnHtml);
            }
        } catch (error) {
            if (requestId !== searchRequestId) return;
            console.error('Search failed:', error);
            resultsContainer.innerHTML = '<div class="search-state"><span class="material-icons">cloud_off</span><strong>Search unavailable</strong><span>Check your connection and try again.</span></div>';
        }
    }, 350);
}

function generateSearchItemsHtml(results) {
    return (results || []).filter(item => {
        if (item.media_type === 'person') return true;
        return !excludedContent.includes(String(item.id)) && item.poster_path;
    }).map(item => {
        const type = item.media_type || 'movie';
        const title = item.title || item.name || 'Untitled';
        const imagePath = type === 'person' ? item.profile_path : item.poster_path;
        const year = (item.release_date || item.first_air_date || '').split('-')[0] || '';
        const imageClass = type === 'person' ? 'search-result-person' : 'search-result-poster';
        const imgContent = imagePath
            ? '<img class="' + imageClass + '" src="' + IMG_BASE + imagePath + '" alt="' + escapeHtml(title) + '" onerror="this.onerror=null; this.src=\'./icon.png\';">'
            : '<div class="search-result-person-placeholder"><span class="material-icons">' + (type === 'person' ? 'person' : 'movie') + '</span></div>';
        const safeQuery = escapeInlineJsString(currentSearchQuery);
        const meta = type === 'person' ? (item.known_for_department || 'Person') : type.toUpperCase() + (year ? ' • ' + year : '');
        return '<div class="search-result-item" onclick="handleSearchResultClick(\'' + safeQuery + '\', \'' + item.id + '\', \'' + type + '\')" style="cursor:pointer;">' +
            imgContent + '<div class="search-result-info"><h4>' + escapeHtml(title) + '</h4><p>' + escapeHtml(meta) + '</p></div></div>';
    }).join('');
}

window.loadMoreSearch = async () => {
    const btnContainer = document.getElementById('search-load-more-btn');
    if (!btnContainer) return;
    const btn = btnContainer.querySelector('button');
    if (!btn || btn.disabled) return;

    const query = currentSearchQuery;
    const requestId = searchRequestId;
    const nextPage = currentSearchPage + 1;
    btn.disabled = true;
    btn.innerHTML = '<span class="search-spinner search-spinner-small"></span> Loading';

    try {
        const res = await fetch(`${TMDB_BASE}/search/multi?api_key=${TMDB_KEY}&query=${encodeURIComponent(query)}&page=${nextPage}`);
        if (!res.ok) throw new Error(`Search request failed: ${res.status}`);
        const data = await res.json();

        if (requestId !== searchRequestId || query !== currentSearchQuery) return;

        const newItems = generateSearchItemsHtml(data.results);
        if (newItems) btnContainer.insertAdjacentHTML('beforebegin', newItems);
        currentSearchPage = nextPage;

        if (currentSearchPage >= data.total_pages) {
            btnContainer.remove();
        } else {
            btn.disabled = false;
            btn.textContent = 'Load More';
        }
    } catch (error) {
        console.error('Could not load more search results:', error);
        if (requestId === searchRequestId) {
            btn.disabled = false;
            btn.textContent = 'Try Again';
        }
    }
};

// --- Profile System Logic ---

let isManagingProfiles = false;

window.openProfilePicker = () => {
    captureAndPushState();
    renderProfileScreen();
};

window.renderProfileScreen = () => {
    const profileView = document.getElementById('profile-view');
    const dashboard = document.getElementById('dashboard');
    const nav = document.querySelector('.top-nav');
    
    // Hide everything else
    setElementVisible(dashboard, false);
    setElementVisible(document.getElementById('details-view'), false);
    setElementVisible(document.getElementById('category-view'), false);
    setElementVisible(document.getElementById('player-container'), false);
    if(nav) nav.style.display = 'none';
    document.body.classList.add('no-scroll');
    
    setElementVisible(profileView, true, 'flex');
    
    const list = document.getElementById('profile-list');
    list.innerHTML = '';
    
    // Fix: Update Title based on mode
    const title = document.getElementById('profile-title');
    if (title) {
        title.innerText = isManagingProfiles ? 'Manage Profiles' : 'Who is watching?';
    }
    
    // Render existing profiles
    let visibleCount = 0;
    profiles.forEach(p => {
        // Fix: Hide Default profile when managing
        if (isManagingProfiles && p.name === 'Default') return;
        visibleCount++;

        const card = document.createElement('div');
        card.className = 'profile-card';
        card.onclick = () => {
            if (isManagingProfiles) return; // Don't select if managing
            selectProfile(p.id);
        };
        
        // Avatar Color/Icon
        const colors = ['#3498db', '#e74c3c', '#f1c40f', '#9b59b6', '#2ecc71', '#e67e22'];
        const color = p.color || colors[p.id % colors.length];
        
        let deleteBtn = '';
        if (isManagingProfiles) {
            card.classList.add('managing');
            deleteBtn = `<button class="profile-delete-btn" type="button"><span class="material-icons" style="font-size:16px;">close</span></button>`;
        }

        // Fix: Show Initial instead of Icon
        const initial = escapeHtml(p.name.charAt(0).toUpperCase());

        card.innerHTML = `
            <div class="profile-wrapper">
                <div class="profile-avatar" style="background:${escapeHtml(color)};">
                    <span class="profile-initial">${initial}</span>
                </div>
                ${deleteBtn}
            </div>
            <div class="profile-name">${escapeHtml(p.name)}</div>
        `;
        const deleteButton = card.querySelector('.profile-delete-btn');
        if (deleteButton) {
            deleteButton.addEventListener('click', (event) => window.deleteProfile(p.id, event));
        }

        list.appendChild(card);
    });

    // Fix: Placeholder text if no profiles to manage
    if (isManagingProfiles && visibleCount === 0) {
        list.innerHTML = '<div style="color:#666; font-size:1.1rem; width:100%; text-align:center; padding:20px;">No custom profiles to manage.</div>';
    }

    // Add Profile Button (if less than 5 profiles)
    if (profiles.length < 5 && !isManagingProfiles) {
        const addCard = document.createElement('div');
        addCard.className = 'profile-card';
        addCard.onclick = () => promptCreateProfile();
        addCard.innerHTML = `
            <div class="profile-wrapper">
                <div class="profile-avatar" style="background:transparent; border:2px solid #333;">
                    <span class="material-icons add-profile-icon">add</span>
                </div>
            </div>
            <div class="profile-name">Add Profile</div>
        `;
        list.appendChild(addCard);
    }

    // Update Manage Button Text
    const manageBtn = document.getElementById('manage-profiles-btn');
    manageBtn.innerText = isManagingProfiles ? 'Done' : 'Manage Profiles';
    manageBtn.style.display = profiles.length === 0 ? 'none' : 'block';

    let accountBtn = document.getElementById('profile-account-btn');
    if (!accountBtn) {
        accountBtn = document.createElement('button');
        accountBtn.id = 'profile-account-btn';
        accountBtn.className = 'play-btn profile-account-btn';
        accountBtn.style.marginTop = '12px';
        manageBtn.insertAdjacentElement('afterend', accountBtn);
    }
    accountBtn.textContent = cloudProfileMode ? 'Sign Out' : 'Sign In';
    accountBtn.onclick = cloudProfileMode ? signOutAccount : openAccountSignIn;
    accountBtn.style.display = isManagingProfiles ? 'none' : 'block';
    dismissStartupScreen();
};

window.toggleManageProfiles = () => {
    isManagingProfiles = !isManagingProfiles;
    renderProfileScreen();
};

window.promptCreateProfile = () => {
    showModal('Create Profile', 
        `<input type="text" id="new-profile-name" placeholder="Name" style="background:#222; border:1px solid #444; color:#fff; padding:10px; border-radius:4px; width:100%; font-size:1rem; outline:none;" autocomplete="off">`,
        [
            { text: 'Cancel', secondary: true },
            { text: 'Create', className: 'play-btn', action: () => { // Fix: Blue button
                const name = document.getElementById('new-profile-name').value.trim();
                
                // Fix: Name Validation
                if (!name) return false;
                
                const forbidden = ['my profile', 'my user', 'me', 'default', 'admin', 'root', 'system'];
                if (forbidden.includes(name.toLowerCase())) {
                    showToast("Please use a real name.");
                    return false;
                }
                if (/[<>{}"'`;()&]/.test(name)) {
                     showToast("Invalid characters in name.");
                     return false;
                }
                
                createProfile(name);
            }}
        ]
    );
    setTimeout(() => document.getElementById('new-profile-name').focus(), 100);
};

window.createProfile = async (name) => {
    if (cloudProfileMode) {
        if (profiles.length >= 5) return showToast('You can have up to five profiles.');
        const colors = ['#3498db', '#e74c3c', '#f1c40f', '#9b59b6', '#2ecc71', '#e67e22'];
        const { data, error } = await supabaseClient.from('profiles')
            .insert({ user_id: authUser.id, name: name, color: colors[profiles.length % colors.length], position: profiles.length })
            .select('id,name,color,position').single();
        if (error) return showToast(error.message);
        const { error: dataError } = await supabaseClient.from('profile_data').insert({ profile_id: data.id });
        if (dataError) {
            await supabaseClient.from('profiles').delete().eq('id', data.id);
            return showToast(dataError.message);
        }
        profiles.push(data);
        renderProfileScreen();
        return;
    }
    const newId = Date.now();
    const colors = ['#3498db', '#e74c3c', '#f1c40f', '#9b59b6', '#2ecc71', '#e67e22'];
    const color = colors[profiles.length % colors.length];
    
    const newProfile = { id: newId, name: name, color: color };
    profiles.push(newProfile);
    localStorage.setItem('gtv_profiles', JSON.stringify(profiles));
    
    // Migration: If this is the first profile, migrate legacy data
    if (profiles.length === 1) {
        const legacyWatchlist = localStorage.getItem('gtv_watchlist');
        if (legacyWatchlist) {
            localStorage.setItem(`gtv_watchlist_${newId}`, legacyWatchlist);
            // Optional: localStorage.removeItem('gtv_watchlist');
        }
    }
    
    renderProfileScreen();
};

window.deleteProfile = (id, event) => {
    event.stopPropagation();
    showModal('Delete Profile?', 'This will permanently delete this profile and all its data (watchlist, history, etc). This cannot be undone.', [
        { text: 'Cancel', secondary: true },
        { text: 'Delete', className: 'play-btn remove-confirm-btn', action: async () => {
            if (cloudProfileMode) {
                const { error } = await supabaseClient.from('profiles').delete().eq('id', id);
                if (error) { showToast(error.message); return; }
            }
            profiles = profiles.filter(p => p.id !== id);
            if (!cloudProfileMode) localStorage.setItem('gtv_profiles', JSON.stringify(profiles));
            // Cleanup data
            localStorage.removeItem(`gtv_watchlist_${id}`);
            localStorage.removeItem(`gtv_liked_content_${id}`);
            localStorage.removeItem(`gtv_excluded_content_${id}`);
            localStorage.removeItem(`gtv_watch_history_${id}`);
            renderProfileScreen();
        }}
    ]);
};

window.selectProfile = async (id) => {
    if (document.getElementById('profile-view').style.display !== 'none') captureAndPushState();
    currentProfile = profiles.find(p => p.id === id);
    if (!currentProfile) return;

    // Load cloud data first, then mirror it locally for existing app features.
    if (cloudProfileMode) {
        cloudDataLoading = true;
        try {
            const { data, error } = await supabaseClient.from('profile_data')
                .select('watchlist,liked_content,excluded_content,watch_history,settings')
                .eq('profile_id', id).maybeSingle();
            if (error) throw error;
            const cloudData = data || {};
            profileSettings = cloudData.settings && typeof cloudData.settings === 'object' ? cloudData.settings : {};
            const syncedSettingKeys = {
                default_tab: 'gtv_default_tab',
                reduced_motion: 'gtv_reduced_motion',
                active_source: 'gtv_active_source',
                region: 'gtv_region'
            };
            Object.entries(syncedSettingKeys).forEach(([setting, storageKey]) => {
                if (Object.prototype.hasOwnProperty.call(profileSettings, setting)) {
                    localStorage.setItem(storageKey, profileSettings[setting]);
                }
            });
            currentTab = localStorage.getItem('gtv_default_tab') || 'movie';
            activeNavigationSection = currentTab;
            document.body.classList.toggle('reduced-motion', localStorage.getItem('gtv_reduced_motion') === 'true');
            localStorage.setItem(`gtv_watchlist_${id}`, JSON.stringify(cloudData.watchlist || []));
            localStorage.setItem(`gtv_liked_content_${id}`, JSON.stringify(cloudData.liked_content || []));
            localStorage.setItem(`gtv_excluded_content_${id}`, JSON.stringify(cloudData.excluded_content || []));
            localStorage.setItem(`gtv_watch_history_${id}`, JSON.stringify(cloudData.watch_history || []));
        } catch (error) {
            cloudDataLoading = false;
            showToast('Could not load this profile: ' + error.message);
            return;
        }
        cloudDataLoading = false;
    }

    // 1. Load Profile Data
    watchlist = safeJsonParse(`gtv_watchlist_${id}`, []);
    likedContent = safeJsonParse(`gtv_liked_content_${id}`, []);
    excludedContent = safeJsonParse(`gtv_excluded_content_${id}`, []);
    
    // Clear hero cache on profile switch
    heroCache = { movie: null, tv: null };
    if (heroInterval) clearInterval(heroInterval);
    sessionRecItems = { movie: { like: null }, tv: { like: null } };
    
    // 2. Update Dropdown UI
    const dropdown = document.getElementById('nav-dropdown');
    if (dropdown) {
        const initial = escapeHtml(currentProfile.name.charAt(0).toUpperCase());
        const color = currentProfile.color || '#3498db';
        
        dropdown.innerHTML = `
            <div class="dropdown-profile-header">
                <div class="dropdown-profile-avatar" style="background:${escapeHtml(color)};">${initial}</div>
                <div class="dropdown-profile-name">${escapeHtml(currentProfile.name)}</div>
            </div>
            <div class="dropdown-item" onclick="openProfilePicker(); document.getElementById('nav-dropdown').classList.remove('active');"><span class="material-icons">people</span> Switch Profile</div>
            <div class="dropdown-item" onclick="openCategories(); document.getElementById('nav-dropdown').classList.remove('active');"><span class="material-icons">category</span> Categories</div>
            <div class="dropdown-item" onclick="openPeople(); document.getElementById('nav-dropdown').classList.remove('active');"><span class="material-icons">person_search</span> People</div>
            <div class="dropdown-item" onclick="openCommunityDirectory(); document.getElementById('nav-dropdown').classList.remove('active');"><span class="material-icons">groups</span> Community</div>
            <div class="dropdown-item" onclick="randomPick();"><span class="material-icons">shuffle</span> Random Pick</div>
            <div class="dropdown-item" onclick="openWatchlist();"><span class="material-icons">list</span> My Watchlist</div>
            <div class="dropdown-item" onclick="openHiddenContent();"><span class="material-icons">visibility_off</span> Hidden Content</div>
            <div class="dropdown-item" onclick="openSettingsView(); document.getElementById('nav-dropdown').classList.remove('active');"><span class="material-icons">settings</span> Settings</div>
            <div class="dropdown-item" onclick="openChangelogView(); document.getElementById('nav-dropdown').classList.remove('active');"><span class="material-icons">history</span> Changelog</div>
            ${cloudProfileMode
                ? '<div class="dropdown-item" onclick="signOutAccount(); document.getElementById(\'nav-dropdown\').classList.remove(\'active\');"><span class="material-icons">logout</span> Sign Out</div>'
                : '<div class="dropdown-item" onclick="openAccountSignIn()"><span class="material-icons">login</span> Sign In</div>'}
        `;
    }
    
    // 3. UI Transition
    setElementVisible(document.getElementById('profile-view'), false);
    const nav = document.querySelector('.top-nav');
    if(nav) nav.style.display = 'flex';
    document.body.classList.remove('no-scroll');
    
    // 4. Capture Deep Link Info BEFORE resetting URL
    let movieId = pendingDeepLink ? pendingDeepLink.movieId : null;
    let tvId = pendingDeepLink ? pendingDeepLink.tvId : null;
    
    // Fallback to URL params if pendingDeepLink wasn't set
    if (!movieId && !tvId) {
        const urlParams = new URLSearchParams(window.location.search);
        movieId = urlParams.get('movie');
        tvId = urlParams.get('tv');
    }

    // 5. Always load the Dashboard background first
    // This populates the navigation stack so 'Back' works correctly
    loadDashboard();

    // Restore a shared community link only after the viewer picker is complete.
    const communityRoute = pendingCommunityRoute;
    pendingCommunityRoute = null;
    if (communityRoute === '#community') {
        window.openCommunityDirectory(true, true);
    } else if (communityRoute && communityRoute.indexOf('#profile/') === 0) {
        let routeUsername = '';
        try { routeUsername = decodeURIComponent(communityRoute.slice('#profile/'.length)); } catch (error) {}
        if (routeUsername) window.openCommunityProfile(routeUsername, true, true);
    }

    // 6. If it's a deep link, open the details on top
    if (movieId || tvId) {
        pendingDeepLink = null; // Clear after use
        
        // Use a slight timeout to ensure loadDashboard has initialized the UI
        setTimeout(() => {
            if (movieId) openDetails(movieId, 'movie');
            else if (tvId) openDetails(tvId, 'tv');
        }, 50);
    }
};

async function loadDashboard() {
    const requestId = ++dashboardRequestId;
    resetUrl();
    rowsContainer.innerHTML = getSkeletonHtml('dashboard');
    document.getElementById('hero-section').innerHTML = getSkeletonHtml('hero');
    setElementVisible(dashboard, true, 'block');
    rowsContainer.style.paddingTop = '0'; // Reset padding
    setElementVisible(detailsView, false);
    setElementVisible(categoryView, false);
    setElementVisible(playerContainer, false);
    document.getElementById('hero-section').style.display = 'flex'; // Ensure hero is visible

    const mode = currentTab;
    const region = localStorage.getItem('gtv_region') || 'US';
    const regionParam = region === 'INTL' ? '' : `&region=${region}`;

    try {
        const trendingRes = await fetch(`${TMDB_BASE}/trending/${mode}/week?api_key=${TMDB_KEY}`);
        if (!trendingRes.ok) throw new Error('Could not load trending titles.');
        const trendingData = await trendingRes.json();
        if (requestId !== dashboardRequestId) return;
        
        // Check if cached hero array is valid (none excluded)
        if (heroCache[mode] && heroCache[mode].some(i => excludedContent.includes(i.id.toString()))) {
            heroCache[mode] = null;
        }

        if (!heroCache[mode]) {
            // --- DYNAMIC SPOTLIGHT LOGIC ---
            let heroItems = [];
            let heroHistory = safeJsonParse('gtv_hero_history', []);

            // 1. Slot 1: The Blockbuster (Trending) - Filtered by History
            const validCandidates = trendingData.results.filter(i => !excludedContent.includes(i.id.toString()) && i.backdrop_path);
            
            // Find first item NOT in history
            let slot1 = validCandidates.find(i => !heroHistory.includes(i.id));
            if (!slot1) slot1 = validCandidates[0]; // Fallback to top trending if history is full
            if (slot1) heroItems.push(slot1);

            // 2. Slot 2: The Critic's Choice (Top Rated / High Quality)
            try {
                // Randomize page 1-3 to get variety
                const topPage = Math.floor(Math.random() * 3) + 1;
                const topRes = await fetch(`${TMDB_BASE}/${currentTab}/top_rated?api_key=${TMDB_KEY}${regionParam}&page=${topPage}`);
                const topData = await topRes.json();
                if (requestId !== dashboardRequestId) return;
                const topCandidates = topData.results.filter(i => !excludedContent.includes(i.id.toString()) && i.backdrop_path && i.vote_average >= 7.5 && (!slot1 || i.id !== slot1.id));
                
                if (topCandidates.length > 0) {
                    const slot2 = topCandidates[Math.floor(Math.random() * topCandidates.length)];
                    heroItems.push(slot2);
                }
            } catch(e) {}

            // 3. Slot 3: The Discovery (Random Genre)
            try {
                const genres = currentTab === 'movie' ? [28, 12, 35, 878, 53] : [10759, 35, 18, 9648];
                const rndGenre = genres[Math.floor(Math.random() * genres.length)];
                const discRes = await fetch(`${TMDB_BASE}/discover/${currentTab}?api_key=${TMDB_KEY}&with_genres=${rndGenre}&sort_by=popularity.desc${regionParam}`);
                const discData = await discRes.json();
                if (requestId !== dashboardRequestId) return;
                const discCandidates = discData.results.filter(i => !excludedContent.includes(i.id.toString()) && i.backdrop_path && !heroItems.some(h => h.id === i.id));
                
                if (discCandidates.length > 0) {
                    const slot3 = discCandidates[0];
                    heroItems.push(slot3);
                }
            } catch(e) {}

            // 4. Slot 4: The Crowd Pleaser (Popular)
            try {
                // Use page 2 to avoid duplicates with trending/top rated which are often on page 1
                const popRes = await fetch(`${TMDB_BASE}/${currentTab}/popular?api_key=${TMDB_KEY}${regionParam}&page=2`);
                const popData = await popRes.json();
                if (requestId !== dashboardRequestId) return;
                const popCandidates = popData.results.filter(i => !excludedContent.includes(i.id.toString()) && i.backdrop_path && !heroItems.some(h => h.id === i.id));
                
                if (popCandidates.length > 0) {
                    // Pick random from top 5
                    const slot4 = popCandidates[Math.floor(Math.random() * Math.min(popCandidates.length, 5))];
                    heroItems.push(slot4);
                }
            } catch(e) {}

            // 5. Slot 5: The Hype (Upcoming / On The Air)
            try {
                const hypeEndpoint = currentTab === 'movie' ? 'upcoming' : 'on_the_air';
                const hypeRes = await fetch(`${TMDB_BASE}/${currentTab}/${hypeEndpoint}?api_key=${TMDB_KEY}${regionParam}&page=1`);
                const hypeData = await hypeRes.json();
                if (requestId !== dashboardRequestId) return;
                const hypeCandidates = hypeData.results.filter(i => !excludedContent.includes(i.id.toString()) && i.backdrop_path && !heroItems.some(h => h.id === i.id));
                
                if (hypeCandidates.length > 0) {
                    const slot5 = hypeCandidates[0];
                    heroItems.push(slot5);
                }
            } catch(e) {}

            // Fallback if API fails
            if (heroItems.length === 0 && validCandidates.length > 0) heroItems.push(validCandidates[0]);

            // Update History (Add new items, keep max 20)
            heroItems.forEach(i => {
                if (!heroHistory.includes(i.id)) heroHistory.push(i.id);
            });
            if (heroHistory.length > 50) heroHistory = heroHistory.slice(-20);
            localStorage.setItem('gtv_hero_history', JSON.stringify(heroHistory));

            // Fetch extra details (Certification) for all selected items
            heroCache[mode] = await Promise.all(heroItems.map(async (item) => {
                try {
                    return await (await fetch(`${TMDB_BASE}/${mode}/${item.id}?api_key=${TMDB_KEY}&append_to_response=release_dates,content_ratings,images&include_image_language=en,null`)).json();
                } catch (e) { return item; }
            }));
            if (requestId !== dashboardRequestId) return;
        }

        if (heroCache[mode]) {
            setupHeroCarousel(heroCache[mode], mode);
        } else {
            // Fallback to single item setup if something went wrong
            if (trendingData.results[0]) setupHeroCarousel([trendingData.results[0]], mode);
        }

        rowsContainer.innerHTML = '';

        // Watchlist Row
        if (watchlist.length > 0) {
            createWatchlistRow(watchlist);
        }

        // Continue Watching Row
        const historyKey = currentProfile ? `gtv_watch_history_${currentProfile.id}` : 'gtv_watch_history';
        const watchHistory = safeJsonParse(historyKey, []);
        if (watchHistory.length > 0) {
            createContinueWatchingRow(watchHistory);
        }

        // Recommendations based on Likes
        if (likedContent.length > 0) {
            // Use cached recommendation if available to save API calls
            let recCache = sessionRecItems[currentTab].like;
            
            if (!recCache) {
                const relevantItems = likedContent.filter(item => (item.media_type || 'movie') === currentTab);
                if (relevantItems.length > 0) {
                    const sourceItem = relevantItems[Math.floor(Math.random() * relevantItems.length)];
                    recCache = { item: sourceItem, data: null };
                    sessionRecItems[currentTab].like = recCache;
                }
            }

            if (recCache && recCache.item) {
                const sourceItem = recCache.item;
                const recUrl = `${TMDB_BASE}/${currentTab}/${sourceItem.id}/recommendations?api_key=${TMDB_KEY}`;
                
                if (recCache.data) {
                    createRow(`Because you liked <span class="row-item-name">"${escapeHtml(sourceItem.title)}"</span>`, recCache.data, recUrl);
                } else {
                    try {
                        const recRes = await fetch(recUrl);
                        const recData = await recRes.json();
                        if (requestId !== dashboardRequestId) return;
                        if (recData.results && recData.results.length > 0) {
                            recCache.data = recData.results; // Cache results
                            createRow(`Because you liked <span class="row-item-name">"${escapeHtml(sourceItem.title)}"</span>`, recData.results, recUrl);
                        }
                    } catch (e) { console.error(e); }
                }
            }
        } else {
            sessionRecItems[currentTab].like = null;
        }
        
        // Top 10 Row (Best Rated)
        try {
            const top10Res = await fetch(`${TMDB_BASE}/${currentTab}/top_rated?api_key=${TMDB_KEY}${regionParam}&page=1`);
            const top10Data = await top10Res.json();
            if (requestId !== dashboardRequestId) return;
            createTop10Row(top10Data.results);
        } catch(e) { console.error("Top 10 Error", e); }

        // Populate Rows with 20 items each
        createRow('Trending Now', trendingData.results, `${TMDB_BASE}/trending/${mode}/week?api_key=${TMDB_KEY}`);
        const topRes = await fetch(`${TMDB_BASE}/${currentTab}/top_rated?api_key=${TMDB_KEY}${regionParam}`);
        if (!topRes.ok) throw new Error('Could not load top rated titles.');
        const top = await topRes.json();
        if (requestId !== dashboardRequestId) return;
        createRow('Top Rated', top.results, `${TMDB_BASE}/${currentTab}/top_rated?api_key=${TMDB_KEY}${regionParam}`);

        // Add more content rows
        const popularRes = await fetch(`${TMDB_BASE}/${currentTab}/popular?api_key=${TMDB_KEY}${regionParam}`);
        if (!popularRes.ok) throw new Error('Could not load popular titles.');
        const popular = await popularRes.json();
        if (requestId !== dashboardRequestId) return;
        createRow('Popular on GTV', popular.results, `${TMDB_BASE}/${currentTab}/popular?api_key=${TMDB_KEY}${regionParam}`);

        // Coming Soon / On The Air
        const upcomingEndpoint = currentTab === 'movie' ? 'upcoming' : 'on_the_air';
        const upcomingTitle = currentTab === 'movie' ? 'In Theaters' : 'On TV Now';
        try {
            const upcomingRes = await fetch(`${TMDB_BASE}/${currentTab}/${upcomingEndpoint}?api_key=${TMDB_KEY}${regionParam}`);
            const upcoming = await upcomingRes.json();
            if (requestId !== dashboardRequestId) return;
            if(upcoming.results && upcoming.results.length > 0) createRow(upcomingTitle, upcoming.results, `${TMDB_BASE}/${currentTab}/${upcomingEndpoint}?api_key=${TMDB_KEY}${regionParam}`);
        } catch(e) {}

        // Genre specific rows
        const genre1Id = currentTab === 'movie' ? 28 : 10759; // Action / Action & Adventure
        const genre1Name = currentTab === 'movie' ? 'Action Movies' : 'Action & Adventure';
        const genre1Res = await fetch(`${TMDB_BASE}/discover/${currentTab}?api_key=${TMDB_KEY}&with_genres=${genre1Id}`);
        const genre1 = await genre1Res.json();
        if (requestId !== dashboardRequestId) return;
        createRow(genre1Name, genre1.results, `${TMDB_BASE}/discover/${currentTab}?api_key=${TMDB_KEY}&with_genres=${genre1Id}`);

        const genre2Id = 35; // Comedy
        const genre2Res = await fetch(`${TMDB_BASE}/discover/${currentTab}?api_key=${TMDB_KEY}&with_genres=${genre2Id}`);
        const genre2 = await genre2Res.json();
        if (requestId !== dashboardRequestId) return;
        createRow('Comedy Hits', genre2.results, `${TMDB_BASE}/discover/${currentTab}?api_key=${TMDB_KEY}&with_genres=${genre2Id}`);

        createFooter();
    } catch (e) {
        if (requestId !== dashboardRequestId) return;
        console.error('Dashboard loading failed:', e);
        rowsContainer.innerHTML = `
            <div class="dashboard-error-state" role="alert">
                <span class="material-icons">wifi_off</span>
                <h2>We couldn't load the dashboard</h2>
                <p>Check your connection and try again. Your watchlist and profile data are safe.</p>
                <button class="play-btn" onclick="loadDashboard()"><span class="material-icons">refresh</span> Try Again</button>
            </div>`;
    }
}

function createFooter() {
    const footer = document.createElement('footer');
    footer.className = 'site-footer';
    footer.innerHTML = `
        <div class="footer-content">
            <div class="footer-logo">GTV <span>hub</span></div>
            <div class="footer-links">
                <span onclick="openHelpView()">Help</span>
                <span onclick="openAboutView()">About</span>
                <span onclick="openChangelogView()">Changelog</span>
                <span onclick="openTermsView()">Terms of Use</span>
                <span onclick="openPrivacyView()">Privacy Policy</span>
                <span onclick="openLegalView()">Legal & DMCA</span>
            </div>
            <div class="footer-disclaimer">
                GTV hub does not host any files on its servers. All content is provided by non-affiliated third parties.
            </div>
            <div class="footer-copyright">
                &copy; ${new Date().getFullYear()} GTV hub. All rights reserved.
            </div>
        </div>
    `;
    rowsContainer.appendChild(footer);
}

function setupHeroCarousel(items, mode) {
    const hero = document.getElementById('hero-section');
    if (heroInterval) clearInterval(heroInterval);
    
    let slidesHtml = '';
    let dotsHtml = '';

    items.forEach((item, index) => {
        const title = item.title || item.name || 'Untitled';
        const year = (item.release_date || item.first_air_date || '').split('-')[0];
        const ratingColor = getRatingColor(item.vote_average || 0);
        const ratingVal = (item.vote_average || 0).toFixed(1);
        const ratingHtml = parseFloat(ratingVal) > 0 ? `<span class="rating-badge" style="color:${ratingColor}"><span class="material-icons" style="font-size:16px;">star</span> ${ratingVal}</span>` : '';
        const cert = getCertification(item, mode);
        const certHtml = cert ? `<span style="border:1px solid rgba(255,255,255,0.4); padding:0 6px; font-size:0.75rem; border-radius: 4px; color:#eee;">${cert}</span>` : '';
        const bgStyle = item.backdrop_path ? `background-image: url('${IMG_HERO + item.backdrop_path}');` : 'background: linear-gradient(to bottom, #1a1a1a, #000);';
        const activeClass = index === 0 ? 'active' : '';

        let titleHtml = `<h1 class="hero-title">${escapeHtml(title)}</h1>`;
        if (item.images && item.images.logos && item.images.logos.length > 0) {
            const logo = item.images.logos.find(l => l.iso_639_1 === 'en') || item.images.logos[0];
            if (logo) {
                titleHtml = `<img src="${IMG_BASE + logo.file_path}" alt="${escapeHtml(title)}" class="hero-logo">`;
            }
        }

        slidesHtml += `
            <div class="hero-slide ${activeClass}" style="${bgStyle}" id="hero-slide-${index}">
                <div class="hero-content">
                    <div style="background: linear-gradient(135deg, #3498db 0%, #9b59b6 100%); color: white; padding: 6px 16px; border-radius: 30px; font-size: 0.75rem; font-weight: 800; margin-bottom: 15px; text-transform: uppercase; letter-spacing: 1px; display: inline-flex; align-items: center; gap: 6px; box-shadow: 0 4px 15px rgba(155, 89, 182, 0.3);">
                        <span class="material-icons" style="font-size: 14px;">auto_awesome</span> Featured Today
                    </div>
                    ${titleHtml}
                    <div class="hero-meta">
                        ${ratingHtml}
                        ${certHtml}
                        <span>${escapeHtml(year)}</span>
                    </div>
                    <p class="hero-desc">${escapeHtml(item.overview || '')}</p>
                    <div class="hero-btns">
                        <button class="play-btn" onclick="playItem('${item.id}', '${mode}')">
                            <span class="material-icons">play_arrow</span> Play
                        </button>
                        <button class="more-info-btn" onclick="openDetails('${item.id}', '${mode}')">
                            <span class="material-icons">info_outline</span> More Info
                        </button>
                    </div>
                </div>
            </div>
        `;
        dotsHtml += `<div class="hero-dot ${activeClass}" onclick="changeHeroSlide(${index})" id="hero-dot-${index}"></div>`;
    });

    hero.innerHTML = slidesHtml + `<div class="hero-dots">${dotsHtml}</div>`;
    document.querySelectorAll('.hero-slide').forEach((el, i) => {
        el.setAttribute('aria-hidden', i === 0 ? 'false' : 'true');
        el.inert = i !== 0;
    });

    // Auto Rotation
    if (items.length > 1) {
        let currentSlide = 0;
        heroInterval = setInterval(() => {
            currentSlide = (currentSlide + 1) % items.length;
            changeHeroSlide(currentSlide);
        }, 8000); // 8 seconds
    }

    // Swipe Support for Mobile
    let touchStartX = 0;
    let touchEndX = 0;
    
    hero.addEventListener('touchstart', e => {
        touchStartX = e.changedTouches[0].screenX;
    }, {passive: true});

    hero.addEventListener('touchend', e => {
        touchEndX = e.changedTouches[0].screenX;
        handleHeroSwipe();
    }, {passive: true});

    function handleHeroSwipe() {
        const current = parseInt(document.querySelector('.hero-slide.active').id.split('-')[2]);
        if (touchEndX < touchStartX - 50) changeHeroSlide((current + 1) % items.length); // Swipe Left (Next)
        if (touchEndX > touchStartX + 50) changeHeroSlide((current - 1 + items.length) % items.length); // Swipe Right (Prev)
    }
}

window.changeHeroSlide = (index) => {
    // Reset timer on manual interaction
    if (heroInterval) {
        clearInterval(heroInterval);
        // Restart timer
        heroInterval = setInterval(() => {
            const next = (index + 1) % document.querySelectorAll('.hero-slide').length;
            changeHeroSlide(next);
        }, 8000);
    }

    document.querySelectorAll('.hero-slide').forEach((el, i) => {
        const isActive = i === index;
        if (isActive) el.classList.add('active');
        else el.classList.remove('active');
        el.setAttribute('aria-hidden', isActive ? 'false' : 'true');
        el.inert = !isActive;
    });
    document.querySelectorAll('.hero-dot').forEach((el, i) => {
        if (i === index) el.classList.add('active');
        else el.classList.remove('active');
    });
}

function createTop10Row(items) {
    const rowDiv = document.createElement('div');
    rowDiv.className = 'category-row top10-row';
    
    const validItems = items.filter(i => !excludedContent.includes(i.id.toString()) && i.poster_path).slice(0, 10);
    if (validItems.length === 0) return;

    const cardsHtml = validItems.map((item, index) => {
        const type = item.media_type || (item.first_air_date ? 'tv' : 'movie');
        const rank = index + 1;
        const titleText = item.title || item.name || 'Untitled';
        return `
            <div class="top10-card" onclick="openDetails('${item.id}', '${type}')">
                <span class="top10-rank" data-rank="${rank}">${rank}</span>
                <img class="top10-poster-img" src="${IMG_BASE + item.poster_path}" alt="${escapeHtml(titleText)}" loading="lazy">
            </div>
        `;
    }).join('');

    rowDiv.innerHTML = `
        <div class="row-header">
            <h2 class="row-title">Top 10 ${currentTab === 'movie' ? 'Movies' : 'TV Shows'} Today</h2>
        </div>
        <div class="top10-wrapper">
            <button class="scroll-btn left" onclick="scrollTop10('left')"><span class="material-icons">chevron_left</span></button>
            <div class="top10-scroll-container" id="top10-scroll">
                ${cardsHtml}
            </div>
            <button class="scroll-btn right" onclick="scrollTop10('right')"><span class="material-icons">chevron_right</span></button>
        </div>
    `;
    
    rowsContainer.appendChild(rowDiv);
}

window.scrollTop10 = (direction) => {
    const container = document.getElementById('top10-scroll');
    if(container) {
        const scrollAmount = container.clientWidth * 0.7;
        container.scrollBy({ left: direction === 'left' ? -scrollAmount : scrollAmount, behavior: 'smooth' });
    }
};

function createContinueWatchingRow(items) {
    const rowDiv = document.createElement('div');
    rowDiv.className = 'category-row continue-watching-row';
    
    // Limit to 6 items as requested
    const validItems = items.slice(0, 6);
    if (validItems.length === 0) return;

    const cardsHtml = validItems.map(item => {
        const type = item.media_type || 'movie';
        const titleText = item.title || item.name || 'Untitled';
        const img = item.backdrop_path ? IMG_BASE + item.backdrop_path : (item.poster_path ? IMG_BASE + item.poster_path : './icon.png');
        
        let tagText = type === 'tv' ? 'TV SHOW' : 'MOVIE';
        if (type === 'tv' && item.season && item.episode) {
            tagText = `S${item.season} E${item.episode}`;
        }
        
        return `
            <div class="continue-watching-card" onclick="playItem('${item.id}', '${type}', ${Number(item.season) || 1}, ${Number(item.episode) || 1})">
                <div class="cw-tag">${escapeHtml(tagText)}</div>
                <img class="cw-img" src="${img}" alt="${escapeHtml(titleText)}" loading="lazy">
                <div class="cw-play-icon"><span class="material-icons">play_arrow</span></div>
                <div class="cw-info">
                    <div class="cw-title">${escapeHtml(titleText)}</div>
                </div>
            </div>
        `;
    }).join('');

    rowDiv.innerHTML = `
        <div class="row-header">
            <h2 class="row-title">Continue Watching</h2>
        </div>
        <div class="continue-watching-wrapper">
            <button class="scroll-btn left" onclick="scrollContinueWatching('left')"><span class="material-icons">chevron_left</span></button>
            <div class="continue-watching-scroll-container" id="cw-scroll">
                ${cardsHtml}
            </div>
            <button class="scroll-btn right" onclick="scrollContinueWatching('right')"><span class="material-icons">chevron_right</span></button>
        </div>
    `;
    
    const watchlistRow = document.querySelector('.watchlist-row-container');
    if (watchlistRow) {
        watchlistRow.after(rowDiv);
    } else {
        if (rowsContainer.firstChild) rowsContainer.insertBefore(rowDiv, rowsContainer.firstChild);
        else rowsContainer.appendChild(rowDiv);
    }
}

window.scrollContinueWatching = (direction) => {
    const container = document.getElementById('cw-scroll');
    if(container) {
        const scrollAmount = container.clientWidth * 0.7;
        container.scrollBy({ left: direction === 'left' ? -scrollAmount : scrollAmount, behavior: 'smooth' });
    }
};

function updateContinueWatchingRow() {
    const historyKey = currentProfile ? `gtv_watch_history_${currentProfile.id}` : 'gtv_watch_history';
    const watchHistory = safeJsonParse(historyKey, []);
    
    const existingRow = document.querySelector('.continue-watching-row');
    if (existingRow) existingRow.remove();
    
    if (watchHistory.length > 0) {
        createContinueWatchingRow(watchHistory);
    }
}

function createRow(title, items, apiUrl, returnElement = false) {
    const rowDiv = document.createElement('div');
    rowDiv.className = 'category-row';
    const safeRowTitle = String(title).includes('row-item-name')
        ? String(title).replace(/<span class="row-item-name">([\s\S]*?)<\/span>/g, '<span class="row-item-name">$1</span>')
        : escapeHtml(title);
    
    // Only take first 4 items for the dashboard
    let cardsHtml = '';
    items.filter(i => !excludedContent.includes(i.id.toString())).slice(0, 6).forEach(item => {
        if(!item.poster_path) return;
        const type = item.media_type || (item.first_air_date ? 'tv' : 'movie');
        const titleText = item.title || item.name || 'Untitled';
        const rating = item.vote_average ? item.vote_average.toFixed(1) : null;
        const ratingColor = getRatingColor(item.vote_average || 0);
        const ratingHtml = rating && parseFloat(rating) > 0 ? `<div class="poster-rating" style="color:${ratingColor}"><span class="material-icons">star</span> ${rating}</div>` : '';
        cardsHtml += `
            <div class="poster-card" onclick="openDetails('${item.id}', '${type}')">
                <img class="poster-img" src="${IMG_BASE + item.poster_path}" loading="lazy" alt="${escapeHtml(titleText)}" onerror="this.onerror=null; this.src='./icon.png';">
                <div class="poster-info">
                    <div class="poster-title">${escapeHtml(titleText)}</div>
                    ${ratingHtml}
                </div>
            </div>
        `;
    });

    // Store items in a global map or pass them directly? 
    // For simplicity, we attach the data to the button's onclick event using a temporary global reference or JSON stringify (careful with size)
    // Better: Attach data to the DOM element
    
    rowDiv.innerHTML = `
        <div class="row-header">
            <h2 class="row-title">${safeRowTitle}</h2>
            <button class="see-all-btn">See All</button>
        </div>
        <div class="row-posters">${cardsHtml}</div>
    `;

    // Attach event listener to See All button
    rowDiv.querySelector('.see-all-btn').onclick = () => openCategoryView(title, items, apiUrl);

    if (returnElement) return rowDiv;
    rowsContainer.appendChild(rowDiv);
}

function createWatchlistRow(items, returnElement = false) {
    const rowDiv = document.createElement('div');
    rowDiv.className = 'category-row watchlist-row-container';
    
    const cardsHtml = items.filter(i => i.poster_path).slice(0, 20).map(item => {
        const type = item.media_type || 'movie';
        const img = IMG_BASE + item.poster_path;
        const titleText = item.title || item.name || 'Untitled';
        const ratingVal = item.vote_average ? item.vote_average.toFixed(1) : null;
        const ratingColor = getRatingColor(item.vote_average || 0);
        const ratingHtml = ratingVal && parseFloat(ratingVal) > 0 ? `<div class="poster-rating" style="color:${ratingColor}"><span class="material-icons">star</span> ${ratingVal}</div>` : '';
        return `
            <div class="poster-card" onclick="openDetails('${item.id}', '${type}')">
                <div class="poster-type">${type === 'tv' ? 'TV SHOW' : 'MOVIE'}</div>
                <img class="poster-img" src="${img}" alt="${escapeHtml(titleText)}" onerror="this.onerror=null; this.src='./icon.png';">
                <div class="poster-info">
                    <div class="poster-title">${escapeHtml(titleText)}</div>
                    ${ratingHtml}
                </div>
                <button class="watchlist-remove-btn" onclick="removeFromWatchlist('${item.id}', event)" title="Remove">
                    <span class="material-icons" style="font-size: 16px;">close</span>
                </button>
            </div>
        `;
    }).join('');

    rowDiv.innerHTML = `
        <div class="row-header">
            <h2 class="row-title">My Watchlist</h2>
            <button class="see-all-btn" onclick="openWatchlist()">See All</button>
        </div>
        <div class="row-posters watchlist-row-posters">${cardsHtml}</div>
    `;
    
    if (returnElement) return rowDiv;
    rowsContainer.appendChild(rowDiv);
}

function updateDashboardWatchlist() {
    const existingRow = document.querySelector('.watchlist-row-container');
    if (existingRow) existingRow.remove();
    
    if (watchlist.length > 0) {
        const row = createWatchlistRow(watchlist, true);
        if (rowsContainer.firstChild) {
            rowsContainer.insertBefore(row, rowsContainer.firstChild);
        } else {
            rowsContainer.appendChild(row);
        }
    }
}

async function injectRecommendationRow(item) {
    const recUrl = `${TMDB_BASE}/${item.media_type}/${item.id}/recommendations?api_key=${TMDB_KEY}`;
    try {
        const recRes = await fetch(recUrl);
        const recData = await recRes.json();
        if (recData.results && recData.results.length > 0) {
            const row = createRow(`Because you liked <span class="row-item-name">"${escapeHtml(item.title || item.name)}"</span>`, recData.results, recUrl, true);
            const watchlistRow = document.querySelector('.watchlist-row-container');
            if (watchlistRow) {
                watchlistRow.after(row);
            } else {
                if (rowsContainer.firstChild) rowsContainer.insertBefore(row, rowsContainer.firstChild);
                else rowsContainer.appendChild(row);
            }
        }
    } catch (e) { console.error(e); }
}

window.openCategoryView = (title, items, apiUrl = '') => {
    prepareCategoryView();
    document.getElementById('category-title').textContent = stripHtml(title);
    
    currentCategoryApiUrl = apiUrl || '';
    currentCategoryPage = 1;
    categoryList.innerHTML = '';
    allLoadedCategoryItems = items; // Store initial items
    
    // Remove existing load more button if any
    const existingBtn = document.getElementById('cat-load-more-container');
    if(existingBtn) existingBtn.remove();

    // Inject Filter Bar
    const filterHtml = `
        <div class="filter-bar">
            <select id="filter-sort" onchange="applyCategoryFilters()">
                <option value="default">Sort By: Default</option>
                <option value="rating_desc">Rating (High to Low)</option>
                <option value="date_desc">Newest First</option>
                <option value="date_asc">Oldest First</option>
                <option value="title_asc">Title (A-Z)</option>
            </select>
            <select id="filter-year" onchange="applyCategoryFilters()">
                <option value="all">Year: All</option>
                <option value="2025">2025</option>
                <option value="2024">2024</option>
                <option value="2023">2023</option>
                <option value="old">Classics (Pre-2023)</option>
            </select>
            <select id="filter-rating" onchange="applyCategoryFilters()">
                <option value="all">Rating: All</option>
                <option value="8">8+ Stars</option>
                <option value="7">7+ Stars</option>
                <option value="6">6+ Stars</option>
            </select>
        </div>
    `;
    categoryList.insertAdjacentHTML('beforeend', filterHtml);

    renderCategoryItems(items);

    if (apiUrl) {
        const btnContainer = document.createElement('div');
        btnContainer.id = 'cat-load-more-container';
        btnContainer.style.textAlign = 'center';
        btnContainer.style.padding = '30px';
        btnContainer.innerHTML = `<button class="more-info-btn" onclick="loadMoreCategory()" style="display:inline-flex; margin:0 auto;">Load More</button>`;
        categoryView.appendChild(btnContainer);
    }
};

window.applyCategoryFilters = () => {
    const sort = document.getElementById('filter-sort').value;
    const yearFilter = document.getElementById('filter-year').value;
    const ratingFilter = document.getElementById('filter-rating').value;

    let filtered = [...allLoadedCategoryItems];

    // Filter by Year
    if (yearFilter !== 'all') {
        filtered = filtered.filter(item => {
            const date = item.release_date || item.first_air_date || '';
            const year = date.split('-')[0];
            if (yearFilter === 'old') return parseInt(year) < 2023;
            return year === yearFilter;
        });
    }

    // Filter by Rating
    if (ratingFilter !== 'all') {
        filtered = filtered.filter(item => item.vote_average >= parseInt(ratingFilter));
    }

    // Sort
    if (sort === 'rating_desc') {
        filtered.sort((a, b) => b.vote_average - a.vote_average);
    } else if (sort === 'date_desc') {
        filtered.sort((a, b) => new Date(b.release_date || b.first_air_date) - new Date(a.release_date || a.first_air_date));
    } else if (sort === 'date_asc') {
        filtered.sort((a, b) => new Date(a.release_date || a.first_air_date) - new Date(b.release_date || b.first_air_date));
    } else if (sort === 'title_asc') {
        filtered.sort((a, b) => (a.title || a.name).localeCompare(b.title || b.name));
    }

    // Re-render
    // Keep filter bar
    const filterBar = categoryList.querySelector('.filter-bar');
    categoryList.innerHTML = '';
    if(filterBar) categoryList.appendChild(filterBar);
    
    renderCategoryItems(filtered);
};

window.renderCategoryItems = (items) => {
    let grid = categoryList.querySelector('.category-results-grid');
    if (!grid) {
        grid = document.createElement('div');
        grid.className = 'category-results-grid';
        categoryList.appendChild(grid);
    }

    const html = items.filter(i => !excludedContent.includes(i.id.toString()) && (i.poster_path || i.backdrop_path)).map(item => {
        const type = item.media_type || (item.first_air_date ? 'tv' : 'movie');
        const titleText = item.title || item.name || 'Untitled';
        const img = item.poster_path ? IMG_BASE + item.poster_path : (item.backdrop_path ? IMG_BASE + item.backdrop_path : './icon.png');
        const year = (item.release_date || item.first_air_date || '').split('-')[0] || 'N/A';
        const rating = item.vote_average ? item.vote_average.toFixed(1) : null;
        const ratingColor = getRatingColor(item.vote_average || 0);
        const ratingHtml = rating && parseFloat(rating) > 0 ? `<div class="result-rating" style="background:${ratingColor}">${rating}</div>` : '';

        return `
            <div class="result-card" onclick="openDetails('${item.id}', '${type}')">
                <div class="result-poster-container">
                    <img src="${img}" alt="${escapeHtml(titleText)}" loading="lazy" onerror="this.onerror=null; this.src='./icon.png';">
                    ${ratingHtml}
                </div>
                <div class="result-info">
                    <h4>${escapeHtml(titleText)}</h4>
                    <div class="result-meta">
                        <span>${escapeHtml(year)}</span>
                        <span class="result-type">${type === 'tv' ? 'TV SHOW' : 'MOVIE'}</span>
                    </div>
                </div>
            </div>
        `;
    }).join('');
    
    grid.insertAdjacentHTML('beforeend', html);
};

window.loadMoreCategory = async () => {
    const categoryTitle = document.getElementById('category-title')?.textContent?.trim();
    const isResultsList = categoryView.style.display === 'block' &&
        !!currentCategoryApiUrl && categoryTitle !== 'Browse Categories';
    if (!isResultsList) return;
    
    const btn = document.querySelector('#cat-load-more-container button');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    btn.innerText = 'Loading...';

    currentCategoryPage++;
    const separator = currentCategoryApiUrl.includes('?') ? '&' : '?';
    const url = `${currentCategoryApiUrl}${separator}page=${currentCategoryPage}`;

    try {
        const res = await fetch(url);
        const data = await res.json();
        
        if (data.results && data.results.length > 0) {
            renderCategoryItems(data.results);
            if(btn) {
                btn.innerText = 'Load More';
                btn.disabled = false;
            }
        } else {
            if(btn) {
                btn.innerText = 'No More Content';
                btn.disabled = true;
            }
        }
    } catch (e) {
        if(btn) {
            btn.innerText = 'Error Loading';
            btn.disabled = false;
        }
    }
};

window.closeCategoryView = () => {
    handleBack();
};

window.openCategories = async () => {
    prepareCategoryView();

    // The Categories directory is a navigation menu, not a paginated results list.
    currentCategoryApiUrl = '';
    currentCategoryPage = 1;
    allLoadedCategoryItems = [];

    const container = document.getElementById('category-list');
    document.getElementById('category-title').innerText = 'Browse Categories';
    
    // Remove existing load more button if any
    const existingBtn = document.getElementById('cat-load-more-container');
    if(existingBtn) existingBtn.remove();

    container.innerHTML = getSkeletonHtml('genres');

    try {
        const res = await fetch(`${TMDB_BASE}/genre/${currentTab}/list?api_key=${TMDB_KEY}`);
        const data = await res.json();
        
        const customCats = [
            { id: 'trending', name: 'Trending Now' },
            { id: 'top_rated', name: 'Top Rated' },
            { id: 'popular', name: 'Popular' },
            { id: 'now_playing', name: currentTab === 'movie' ? 'In Theaters' : 'Airing Today' }
        ];

        const moods = [
            { name: 'Adrenaline Rush', icon: 'local_fire_department', color: '#e74c3c', 
              ids: currentTab === 'movie' ? '28,53' : '10759' }, // Action, Thriller
            { name: 'Laugh Out Loud', icon: 'sentiment_very_satisfied', color: '#f1c40f', 
              ids: '35' }, // Comedy
            { name: 'Dark & Gritty', icon: 'nights_stay', color: '#34495e', 
              ids: '80,18' }, // Crime, Drama
            { name: 'Mind Benders', icon: 'psychology', color: '#9b59b6', 
              ids: currentTab === 'movie' ? '878,9648' : '10765,9648' }, // SciFi, Mystery
            { name: 'Feel Good', icon: 'favorite', color: '#e91e63', 
              ids: currentTab === 'movie' ? '10751,10749' : '10751,35' }, // Family, Romance/Comedy
            { name: 'Epic Journeys', icon: 'explore', color: '#2ecc71', 
              ids: currentTab === 'movie' ? '12,14' : '10759,10765' }, // Adventure, Fantasy
            { name: 'Scare Me', icon: 'flash_on', color: '#c0392b', 
              ids: currentTab === 'movie' ? '27' : '9648,10765' }, // Horror
            { name: 'True Stories', icon: 'history', color: '#e67e22', 
              ids: currentTab === 'movie' ? '36,99' : '99,10768' }, // History, Documentary
            { name: 'Survival', icon: 'forest', color: '#795548', 
              ids: currentTab === 'movie' ? '12,53' : '10759,18' } // Adventure, Thriller
        ];

        let html = `
            <div style="padding: 0 4%;">
                <h3 style="color:#fff; margin-bottom:15px; font-size:1.2rem;">Pick a Mood</h3>
                <div class="genre-grid">
                    ${moods.map(m => `
                        <div class="genre-card mood-card" onclick="openMood('${m.ids}', '${m.name}')" style="border-color:${m.color};">
                            <span class="material-icons" style="color:${m.color}; font-size:24px; margin-bottom:8px;">${m.icon}</span>
                            <div>${m.name}</div>
                        </div>
                    `).join('')}
                </div>

                <h3 style="color:#fff; margin:30px 0 15px; font-size:1.2rem;">Categories</h3>
                <div class="genre-grid">
                    ${customCats.map(c => `
                        <div class="genre-card" onclick="openCustomCategory('${c.id}', '${c.name}')" style="background: linear-gradient(135deg, var(--accent), #9b59b6); border:none; color:#fff;">
                            ${c.name}
                        </div>
                    `).join('')}
                    ${data.genres.map(g => `
                        <div class="genre-card" onclick="openGenre('${g.id}', '${g.name}')">
                            ${g.name}
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
        container.innerHTML = html;
    } catch (e) {
        container.innerHTML = '<p>Error loading categories.</p>';
    }
};

window.openCustomCategory = async (type, name) => {
    let url = '';
    const region = localStorage.getItem('gtv_region') || 'US';
    const regionParam = region === 'INTL' ? '' : `&region=${region}`;
    if (type === 'trending') {
        url = `${TMDB_BASE}/trending/${currentTab}/week?api_key=${TMDB_KEY}`;
    } else if (type === 'now_playing') {
        const endpoint = currentTab === 'movie' ? 'now_playing' : 'airing_today';
        url = `${TMDB_BASE}/${currentTab}/${endpoint}?api_key=${TMDB_KEY}${regionParam}`;
    } else {
        url = `${TMDB_BASE}/${currentTab}/${type}?api_key=${TMDB_KEY}${regionParam}`;
    }
    
    const res = await fetch(url);
    const data = await res.json();
    openCategoryView(name, data.results, url);
};

window.openMood = async (ids, name) => {
    const region = localStorage.getItem('gtv_region') || 'US';
    const regionParam = region === 'INTL' ? '' : `&region=${region}`;
    const url = `${TMDB_BASE}/discover/${currentTab}?api_key=${TMDB_KEY}&with_genres=${ids}&sort_by=popularity.desc${regionParam}`;
    const res = await fetch(url);
    const data = await res.json();
    openCategoryView(name, data.results, url);
};

window.openGenre = async (id, name) => {
    const region = localStorage.getItem('gtv_region') || 'US';
    const regionParam = region === 'INTL' ? '' : `&region=${region}`;
    const url = `${TMDB_BASE}/discover/${currentTab}?api_key=${TMDB_KEY}&with_genres=${id}${regionParam}`;
    const res = await fetch(url);
    const data = await res.json();
    openCategoryView(name, data.results, url);
};

window.renderWatchlistContent = () => {
    const query = (document.getElementById('watchlist-search')?.value || '').trim().toLocaleLowerCase();
    const typeFilter = document.getElementById('watchlist-type')?.value || 'all';
    const sort = document.getElementById('watchlist-sort')?.value || 'added';

    let items = watchlist.filter(item => {
        const type = item.media_type || 'movie';
        const title = item.title || item.name || 'Untitled';
        return (typeFilter === 'all' || type === typeFilter) &&
            title.toLocaleLowerCase().includes(query);
    });

    items.sort((a, b) => {
        const titleA = a.title || a.name || '';
        const titleB = b.title || b.name || '';
        const dateA = a.release_date || a.first_air_date || '';
        const dateB = b.release_date || b.first_air_date || '';
        if (sort === 'title') return titleA.localeCompare(titleB);
        if (sort === 'rating') return (b.vote_average || 0) - (a.vote_average || 0);
        if (sort === 'newest') return dateB.localeCompare(dateA);
        if (sort === 'oldest') return dateA.localeCompare(dateB);
        return 0; // Keep the saved order (newest additions first).
    });

    const count = document.getElementById('watchlist-count');
    if (count) count.textContent = `${items.length} of ${watchlist.length} titles`;

    const gridHtml = items.length ? '<div class="watchlist-grid">' + items.map(item => {
        const type = item.media_type || 'movie';
        const img = item.poster_path ? IMG_BASE + item.poster_path : './icon.png';
        const titleText = item.title || item.name || 'Untitled';
        const yearVal = (item.release_date || item.first_air_date || '').split('-')[0];
        const ratingVal = item.vote_average ? Number(item.vote_average).toFixed(1) : null;
        const ratingColor = getRatingColor(item.vote_average || 0);
        const ratingHtml = ratingVal && parseFloat(ratingVal) > 0 ? `<div class="poster-rating" style="color:${ratingColor}"><span class="material-icons">star</span> ${ratingVal}</div>` : '';
        return `
            <div class="poster-card" onclick="openDetails('${item.id}', '${type}')">
                <div class="poster-type">${type === 'tv' ? 'TV SHOW' : 'MOVIE'}</div>
                <img class="poster-img" src="${img}" alt="${escapeHtml(titleText)}" loading="lazy" onerror="this.onerror=null; this.src='./icon.png';">
                <div class="poster-info">
                    <div class="poster-title">${escapeHtml(titleText)}</div>
                    <div class="watchlist-card-meta">${escapeHtml(yearVal || 'Year unknown')}</div>
                    ${ratingHtml}
                </div>
                <button class="watchlist-remove-btn" onclick="removeFromWatchlist('${item.id}', event)" title="Remove from Watchlist" aria-label="Remove ${escapeHtml(titleText)} from Watchlist">
                    <span class="material-icons" style="font-size: 16px;">close</span>
                </button>
            </div>
        `;
    }).join('') + '</div>' : `
        <div class="watchlist-empty-state">
            <span class="material-icons">${watchlist.length ? 'search_off' : 'bookmark_border'}</span>
            <strong>${watchlist.length ? 'No matching titles' : 'Your watchlist is empty'}</strong>
            <span>${watchlist.length ? 'Try a different search or filter.' : 'Add movies and TV shows to keep track of what you want to watch.'}</span>
        </div>
    `;

    const grid = document.getElementById('watchlist-results');
    if (grid) grid.innerHTML = gridHtml;
    else categoryList.insertAdjacentHTML('beforeend', gridHtml);
};
window.openWatchlist = () => {
    document.getElementById('nav-dropdown').classList.remove('active');
    prepareCategoryView();
    document.getElementById('category-title').innerText = 'My Watchlist';

    const existingBtn = document.getElementById('cat-load-more-container');
    if (existingBtn) existingBtn.remove();

    categoryList.innerHTML = `
        <div class="watchlist-toolbar">
            <label class="watchlist-search">
                <span class="material-icons">search</span>
                <input id="watchlist-search" type="search" placeholder="Search your watchlist..." autocomplete="off" oninput="renderWatchlistContent()">
            </label>
            <select id="watchlist-type" aria-label="Filter by type" onchange="renderWatchlistContent()">
                <option value="all">All titles</option>
                <option value="movie">Movies</option>
                <option value="tv">TV shows</option>
            </select>
            <select id="watchlist-sort" aria-label="Sort watchlist" onchange="renderWatchlistContent()">
                <option value="added">Recently added</option>
                <option value="title">Title (A–Z)</option>
                <option value="rating">Highest rated</option>
                <option value="newest">Release date (newest)</option>
                <option value="oldest">Release date (oldest)</option>
            </select>
        </div>
        <div class="watchlist-results-heading"><span id="watchlist-count"></span></div>
        <div id="watchlist-results"></div>
    `;
    renderWatchlistContent();
};

window.openHiddenContent = () => {
    document.getElementById('nav-dropdown').classList.remove('active');
    
    prepareCategoryView();
    
    document.getElementById('category-title').innerText = 'Hidden Content';
    
    // Remove existing load more button if any
    const existingBtn = document.getElementById('cat-load-more-container');
    if(existingBtn) existingBtn.remove();

    if (excludedContent.length === 0) {
        categoryList.innerHTML = '<div style="padding:50px; text-align:center; color:#888;">You haven\'t hidden any content yet.</div>';
        return;
    }

    categoryList.innerHTML = getSkeletonHtml('grid');
    
    // Fetch details for excluded IDs to display them
    Promise.all(excludedContent.map(id => 
        fetch(`${TMDB_BASE}/movie/${id}?api_key=${TMDB_KEY}`)
        .then(r => r.ok ? r.json() : fetch(`${TMDB_BASE}/tv/${id}?api_key=${TMDB_KEY}`).then(r2 => r2.json()))
        .catch(() => null)
    )).then(data => {
        const validData = data.filter(d => d && (d.title || d.name));
        
        if (validData.length === 0) {
            categoryList.innerHTML = '<div style="padding:50px; text-align:center; color:#888;">No content details found.</div>';
            return;
        }

        categoryList.innerHTML = '<div class="watchlist-grid">' + validData.map(item => {
            const type = item.title ? 'movie' : 'tv';
            const titleText = item.title || item.name || 'Untitled';
            const img = item.poster_path ? IMG_BASE + item.poster_path : './icon.png';
            return `
                <div class="poster-card" style="opacity:0.7;">
                    <div class="poster-type" style="background:#555;">HIDDEN</div>
                    <img class="poster-img" src="${img}" alt="${escapeHtml(titleText)}" style="filter:grayscale(100%);" onerror="this.onerror=null; this.src='./icon.png';">
                    <div class="poster-info">
                        <div class="poster-title">${escapeHtml(titleText)}</div>
                    </div>
                    <button class="watchlist-remove-btn" onclick="unhideContent('${item.id}')" title="Unhide" style="background:#46d369; color:white; opacity:1;">
                        <span class="material-icons" style="font-size: 16px;">visibility</span>
                    </button>
                </div>
            `;
        }).join('') + '</div>';
    });
};

window.removeFromWatchlist = (id, event) => {
    event.stopPropagation();
    itemToRemoveId = id;
    showModal('Remove from Watchlist?', 'Are you sure you want to remove this item?', [
        { text: 'Cancel', secondary: true, action: () => itemToRemoveId = null },
        { text: 'Remove', action: () => confirmRemove() }
    ]);
};

window.confirmRemove = () => {
    const index = watchlist.findIndex(i => i.id == itemToRemoveId);
    if (index > -1) {
        watchlist.splice(index, 1);
        if(currentProfile) localStorage.setItem(`gtv_watchlist_${currentProfile.id}`, JSON.stringify(watchlist));
        persistCurrentProfileData();
        
        // Always update dashboard in background
        updateDashboardWatchlist();

        if (categoryView.style.display === 'block' && document.getElementById('category-title').innerText === 'My Watchlist') {
            renderWatchlistContent();
        }
    }
    closeConfirmModal();
};

async function ensureGuestSession() {
    if (guestSessionId) return guestSessionId;
    
    try {
        const res = await fetch(`${TMDB_BASE}/authentication/guest_session/new?api_key=${TMDB_KEY}`);
        const data = await res.json();
        if (data.success) {
            guestSessionId = data.guest_session_id;
            localStorage.setItem('gtv_guest_session_id', guestSessionId);
            return guestSessionId;
        }
    } catch (e) {
        console.error("Failed to create guest session", e);
    }
    return null;
}

window.rateContent = async (id, type, title) => {
    if (!await ensureGuestSession()) {
        alert("Could not connect to rating service. Please check your internet connection.");
        return;
    }

    const overlay = document.getElementById('rating-modal-overlay');
    setModalActive(overlay, true);
    
    document.getElementById('rating-modal-title').innerText = `Rate "${title}"`;
    document.getElementById('rating-value-display').innerText = '5.0';
    document.getElementById('rating-value-display').style.color = getRatingColor(5.0);
    document.getElementById('rating-value-display').style.textShadow = '0 0 20px ' + getRatingColor(5.0) + '40';
    document.getElementById('rating-slider').value = 5;
    
    // Set background
    const bgDiv = document.getElementById('rating-modal-bg');
    if (currentDetailsData && currentDetailsData.id == id && currentDetailsData.backdrop_path) {
        bgDiv.style.backgroundImage = `url('${IMG_BASE + currentDetailsData.backdrop_path}')`;
    } else {
        bgDiv.style.backgroundImage = 'none';
    }
    
    const submitBtn = document.getElementById('submit-rating-btn');
    submitBtn.onclick = () => submitRating(id, type);
};

window.closeRatingModal = (e) => {
    if (!e || e.target.id === 'rating-modal-overlay' || e.target.closest('.close-modal-btn')) {
        setModalActive('rating-modal-overlay', false);
    }
};

async function submitRating(id, type) {
    const value = document.getElementById('rating-slider').value;
    const btn = document.getElementById('submit-rating-btn');
    const originalText = btn.innerText;
    
    btn.innerText = "Submitting...";
    btn.disabled = true;

    try {
        const url = `${TMDB_BASE}/${type}/${id}/rating?api_key=${TMDB_KEY}&guest_session_id=${guestSessionId}`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json;charset=utf-8' },
            body: JSON.stringify({ value: parseFloat(value) })
        });
        const data = await res.json();
        
        if (data.success) {
            setModalActive('rating-modal-overlay', false);
            
            // Show success toast
            const toast = document.createElement('div');
            toast.style.cssText = "position:fixed; bottom:30px; left:50%; transform:translateX(-50%); background:#46d369; color:white; padding:12px 24px; border-radius:30px; z-index:10000; font-weight:bold; box-shadow: 0 10px 30px rgba(0,0,0,0.5); display:flex; align-items:center; gap:10px;";
            toast.innerHTML = '<span class="material-icons">check_circle</span> Rating Submitted!';
            document.body.appendChild(toast);
            setTimeout(() => toast.remove(), 3000);
        } else {
            alert("Error: " + (data.status_message || "Unknown error"));
        }
    } catch (e) {
        alert("Failed to submit rating.");
    }
    
    btn.innerText = originalText;
    btn.disabled = false;
}

window.reportStreamIssue = (id, title) => {
    const showTheModal = () => {
        showModal('Stream Not Working?',
            `<p>If the video is broken or unavailable, please <b>try all available servers</b> in the player first.</p>
             <p>If it still doesn't work, you can hide this title so it doesn't appear in your lists anymore.</p>
             <p style="margin-top:10px; font-weight:bold; color:#fff;">Hide "${title}"?</p>`,
            [
                { text: 'Cancel', secondary: true },
                { text: 'Hide Content', action: () => excludeContent(id) }
            ]
        );
    };

    if (document.fullscreenElement || document.webkitFullscreenElement) {
        const onFullscreenExit = () => {
            document.removeEventListener('fullscreenchange', onFullscreenExit);
            document.removeEventListener('webkitfullscreenchange', onFullscreenExit);
            setTimeout(showTheModal, 50); // Short delay for browser to settle
        };
        document.addEventListener('fullscreenchange', onFullscreenExit);
        document.addEventListener('webkitfullscreenchange', onFullscreenExit);

        if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    } else {
        showTheModal();
    }
};

window.excludeContent = (id) => {
    if (!excludedContent.includes(id.toString())) {
        excludedContent.push(id.toString());
        if(currentProfile) localStorage.setItem(`gtv_excluded_content_${currentProfile.id}`, JSON.stringify(excludedContent));
        persistCurrentProfileData();
    }
    closePlayer();
    closeDetails();
    loadDashboard(); // Refresh to remove it from view
};

window.unhideContent = (id) => {
    showModal('Unhide Content?', 'Are you sure you want to unhide this title? It will appear in lists again.', [
        { text: 'Cancel', secondary: true },
        { text: 'Unhide', action: () => {
            excludedContent = excludedContent.filter(i => i !== id.toString());
            if(currentProfile) localStorage.setItem(`gtv_excluded_content_${currentProfile.id}`, JSON.stringify(excludedContent));
            persistCurrentProfileData();
            openHiddenContent(); // Refresh view
        }}
    ]);
};

window.openMoreOptions = (id, type, title) => {
    const escapedTitle = title.replace(/'/g, "\\'");
    const html = `
        <div class="options-list">
            <button onclick="closeConfirmModal(); rateContent('${id}', '${type}', '${escapedTitle}');" class="option-row">
                <div class="option-icon"><span class="material-icons" style="color:#f1c40f;">star</span></div>
                <div class="option-text">
                    <span class="option-title">Rate Title</span>
                    <span class="option-desc">Give your rating</span>
                </div>
            </button>
            <button onclick="closeConfirmModal(); shareContent('${escapedTitle}');" class="option-row">
                <div class="option-icon"><span class="material-icons" style="color:#3498db;">share</span></div>
                <div class="option-text">
                    <span class="option-title">Share</span>
                    <span class="option-desc">Share with friends</span>
                </div>
            </button>
            <button onclick="closeConfirmModal(); reportStreamIssue('${id}', '${escapedTitle}');" class="option-row destructive">
                <div class="option-icon"><span class="material-icons">visibility_off</span></div>
                <div class="option-text">
                    <span class="option-title">Hide Content</span>
                    <span class="option-desc">Remove from lists</span>
                </div>
            </button>
        </div>
        <style>
            .options-list { display: flex; flex-direction: column; gap: 5px; padding: 10px 0; }
            .option-row {
                display: flex; align-items: center; gap: 15px;
                background: transparent; border: none;
                padding: 12px 15px; border-radius: 12px;
                cursor: pointer; text-align: left; width: 100%;
                transition: background 0.2s;
            }
            .option-row:hover { background: rgba(255,255,255,0.05); }
            .option-icon {
                width: 40px; height: 40px; border-radius: 50%;
                background: rgba(255,255,255,0.05);
                display: flex; align-items: center; justify-content: center;
            }
            .option-row:hover .option-icon { background: rgba(255,255,255,0.1); }
            .option-text { display: flex; flex-direction: column; }
            .option-title { color: #fff; font-size: 1rem; font-weight: 500; }
            .option-desc { color: #888; font-size: 0.8rem; margin-top: 2px; }
            .option-row.destructive .option-icon { background: rgba(231, 76, 60, 0.1); }
            .option-row.destructive .option-icon span { color: #e74c3c; }
            .option-row.destructive:hover { background: rgba(231, 76, 60, 0.05); }
        </style>
    `;
    
    showModal('More Options', html, [{ text: 'Cancel', secondary: true }]);
};

// Helper for custom modal with actions (reusing info modal structure but adding buttons)
// We'll reuse the confirm modal structure for this actually

window.closeConfirmModal = () => {
    setModalActive('confirm-modal-overlay', false);
    itemToRemoveId = null;
};


let peopleDepartment = 'Popular';
let peopleSearchTimer = null;
let peopleCurrentQuery = '';
let peopleCurrentProfileId = null;

function setPeopleView(view) {
    setElementVisible(dashboard, view === 'dashboard', 'block');
    setElementVisible(detailsView, view === 'details', 'block');
    setElementVisible(categoryView, view === 'category', 'block');
    setElementVisible(document.getElementById('people-view'), view === 'people', 'block');
    setElementVisible(document.getElementById('person-profile-view'), view === 'person', 'block');
    setElementVisible(document.getElementById('community-view'), false);
    setElementVisible(document.getElementById('community-profile-view'), false);
    setElementVisible(playerContainer, false);
}

window.openPeople = (isHistory = false) => {
    if (!isHistory) {
        captureAndPushState();
    }
    setPeopleView('people');
    activeNavigationSection = 'people';
    setupNewNavigation();
    window.scrollTo(0, 0);
    if (!document.getElementById('people-popular-grid').dataset.loaded) loadPopularPeople();
};

async function loadPopularPeople() {
    const grid = document.getElementById('people-popular-grid');
    if (!grid) return;
    grid.innerHTML = '<div class="people-loading"><div class="spinner"></div></div>';
    try {
        const response = await fetch(TMDB_BASE + '/person/popular?api_key=' + TMDB_KEY + '&language=en-US&page=1');
        if (!response.ok) throw new Error('Could not load people');
        const data = await response.json();
        const actors = (data.results || []).filter(person => person.known_for_department === 'Acting');
        grid.innerHTML = actors.length ? actors.map(renderPersonCard).join('') : '<div class="people-empty">No popular actors found right now.</div>';
        grid.dataset.loaded = 'true';
    } catch (error) {
        grid.innerHTML = '<div class="people-empty">We could not load actors right now. Please try again.</div>';
    }
}

function renderPersonCard(person) {
    const name = escapeHtml(person.name || 'Unknown');
    const knownFor = escapeHtml(person.known_for_department || 'Film & TV');
    const knownTitles = (person.known_for || []).slice(0, 2).map(item => item.title || item.name).filter(Boolean).join(' · ');
    const image = person.profile_path ? IMG_BASE + person.profile_path : '';
    return `<button class="person-card" type="button" onclick="openPersonProfile(${Number(person.id)})">
        <span class="person-card-image">${image ? `<img src="${image}" alt="" loading="lazy">` : '<span class="material-icons">person</span>'}</span>
        <span class="person-card-name">${name}</span><span class="person-card-role">${knownFor}</span>
        ${knownTitles ? `<span class="person-card-known">${escapeHtml(knownTitles)}</span>` : ''}
    </button>`;
}

async function searchPeople(query) {
    const resultsPanel = document.getElementById('people-search-content');
    const discoverPanel = document.getElementById('people-discover-content');
    const grid = document.getElementById('people-results-grid');
    peopleCurrentQuery = query.trim();
    if (!peopleCurrentQuery) {
        resultsPanel.style.display = 'none';
        discoverPanel.style.display = 'block';
        return;
    }
    discoverPanel.style.display = 'none';
    resultsPanel.style.display = 'block';
    document.getElementById('people-results-title').textContent = 'Searching...';
    document.getElementById('people-results-count').textContent = '';
    grid.innerHTML = '<div class="people-loading"><div class="spinner"></div></div>';
    try {
        const response = await fetch(`${TMDB_BASE}/search/person?api_key=${TMDB_KEY}&language=en-US&query=${encodeURIComponent(peopleCurrentQuery)}&include_adult=false&page=1`);
        if (!response.ok) throw new Error('Search failed');
        const data = await response.json();
        document.getElementById('people-results-title').textContent = 'People matching “' + peopleCurrentQuery.replace(/[<>]/g, '') + '”';
        document.getElementById('people-results-count').textContent = (data.total_results || 0) + ' results';
        grid.innerHTML = data.results && data.results.length ? data.results.map(renderPersonCard).join('') : '<div class="people-empty">No people found. Try another name.</div>';
    } catch (error) {
        grid.innerHTML = '<div class="people-empty">Search is temporarily unavailable. Please try again.</div>';
    }
}


window.openPersonPhoto = (src, alt) => {
    let viewer = document.getElementById('person-photo-viewer');
    if (!viewer) {
        viewer = document.createElement('div');
        viewer.id = 'person-photo-viewer';
        viewer.className = 'person-photo-viewer';
        viewer.innerHTML = '<button class="person-photo-close" type="button" aria-label="Close photo"><span class="material-icons">close</span></button><img class="person-photo-full" alt=""><div class="person-photo-caption"></div>';
        viewer.addEventListener('click', event => {
            if (event.target === viewer || event.target.closest('.person-photo-close')) closePersonPhoto();
        });
        document.body.appendChild(viewer);
    }
    const photo = viewer.querySelector('.person-photo-full');
    photo.classList.remove('loaded');
    photo.removeAttribute('src');
    photo.dataset.photoSrc = src;
    photo.alt = alt || 'Person photo';
    photo.onload = () => {
        if (photo.dataset.photoSrc === src) photo.classList.add('loaded');
    };
    photo.onerror = () => {
        if (photo.dataset.photoSrc === src) photo.classList.remove('loaded');
    };
    viewer.querySelector('.person-photo-caption').textContent = alt || '';
    viewer.classList.add('active');
    photo.src = src;
    document.body.classList.add('no-scroll');
};

window.closePersonPhoto = () => {
    const viewer = document.getElementById('person-photo-viewer');
    if (!viewer) return;
    viewer.classList.remove('active');
    const photo = viewer.querySelector('.person-photo-full');
    photo.dataset.photoSrc = '';
    photo.onload = null;
    photo.onerror = null;
    photo.classList.remove('loaded');
    photo.removeAttribute('src');
    document.body.classList.remove('no-scroll');
};

document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
        closePersonPhoto();
        closePersonCredits();
    }
});

window.openPersonProfile = async (id, isHistory = false) => {
    if (!isHistory) {
        captureAndPushState();
    }
    peopleCurrentProfileId = id;
    setPeopleView('person');
    window.scrollTo(0, 0);
    const root = document.getElementById('person-profile-content');
    root.innerHTML = '<div class="people-profile-loading"><div class="spinner"></div><span>Loading profile...</span></div>';
    try {
        const response = await fetch(`${TMDB_BASE}/person/${id}?api_key=${TMDB_KEY}&language=en-US&append_to_response=movie_credits,tv_credits,images,external_ids`);
        if (!response.ok) throw new Error('Profile unavailable');
        const person = await response.json();
        const safeName = escapeHtml(person.name || 'Unknown');
        const biography = person.biography ? escapeHtml(person.biography) : 'No biography is available for this person yet.';
        const knownFor = escapeHtml(person.known_for_department || 'Film & Television');
        const born = person.birthday ? new Date(person.birthday + 'T00:00:00').toLocaleDateString(undefined, { year:'numeric', month:'long', day:'numeric' }) : '';
        const died = person.deathday ? new Date(person.deathday + 'T00:00:00').toLocaleDateString(undefined, { year:'numeric', month:'long', day:'numeric' }) : '';
        const years = born ? (died ? born + ' – ' + died : born) : '';
        const ageText = person.birthday && !person.deathday ? ' · ' + Math.max(0, Math.floor((Date.now() - new Date(person.birthday).getTime()) / 31557600000)) + ' years old' : '';
        const portrait = person.profile_path ? IMG_HERO + person.profile_path : '';
        const allCredits = [
            ...(person.movie_credits?.cast || []).map(item => ({...item, media_type:'movie', credit_role: item.character ? 'As ' + item.character : 'Cast'})),
            ...(person.tv_credits?.cast || []).map(item => ({...item, media_type:'tv', credit_role: item.character ? 'As ' + item.character : 'Cast'})),
            ...(person.movie_credits?.crew || []).map(item => ({...item, media_type:'movie', credit_role: item.job || item.department || 'Crew'})),
            ...(person.tv_credits?.crew || []).map(item => ({...item, media_type:'tv', credit_role: item.job || item.department || 'Crew'}))
        ];
        const unique = new Map();
        allCredits.forEach(item => { if (item.id && !unique.has(item.media_type + '-' + item.id)) unique.set(item.media_type + '-' + item.id, item); });
        const credits = [...unique.values()].sort((a,b) => (b.release_date || b.first_air_date || '').localeCompare(a.release_date || a.first_air_date || ''));
        const popular = [...credits].sort((a,b) => (b.popularity || 0) - (a.popularity || 0)).slice(0, 8);
        // Keep the complete collections available to the See All explorers.
        currentPersonCredits = {
            knownFor: [...credits].sort((a,b) => (b.popularity || 0) - (a.popularity || 0)),
            filmography: credits
        };
        const creditCard = item => {
            const title = escapeHtml(item.title || item.name || 'Untitled');
            const poster = item.poster_path ? IMG_BASE + item.poster_path : '';
            const year = (item.release_date || item.first_air_date || '').slice(0,4);
            return `<button class="person-work-card" onclick="openDetails(${Number(item.id)}, '${item.media_type}')">
                <span class="person-work-poster">${poster ? `<img src="${poster}" alt="" loading="lazy">` : '<span class="material-icons">movie</span>'}</span>
                <span class="person-work-title">${title}</span><span class="person-work-meta">${year || 'Release date unknown'} · ${item.media_type === 'tv' ? 'TV' : 'Movie'}</span>
            </button>`;
        };
        const gallery = person.images?.profiles || [];
        const wikipediaUrl = 'https://en.wikipedia.org/w/index.php?search=' + encodeURIComponent(person.name || '');
        const imdbId = person.external_ids?.imdb_id;
        const imdbUrl = imdbId && /^nm\d+$/.test(imdbId) ? 'https://www.imdb.com/name/' + encodeURIComponent(imdbId) + '/' : '';
        const externalLinksHtml = `
            <div class="person-external-links">
                <a class="person-external-link wikipedia-link" href="${wikipediaUrl}" target="_blank" rel="noopener noreferrer"><span class="material-icons">menu_book</span> Wikipedia <span class="material-icons external-arrow">open_in_new</span></a>
                ${imdbUrl ? `<a class="person-external-link imdb-link" href="${imdbUrl}" target="_blank" rel="noopener noreferrer"><span class="material-icons">movie</span> IMDb <span class="material-icons external-arrow">open_in_new</span></a>` : ''}
            </div>`;
        root.innerHTML = `
            <div class="person-profile-hero" ${portrait ? `style="--person-backdrop:url('${portrait}')"` : ''}>
                <button class="hero-icon-btn page-back-btn people-profile-back" onclick="handleBack()" aria-label="Back"><span class="material-icons">arrow_back</span></button>
                <div class="person-profile-main">
                    <div class="person-profile-portrait">${portrait ? `<img src="${portrait}" alt="${safeName}">` : '<span class="material-icons">person</span>'}</div>
                    <div class="person-profile-heading"><span class="people-kicker">${knownFor.toUpperCase()}</span><h1>${safeName}</h1><div class="person-profile-facts">${years ? `<span><span class="material-icons">cake</span>${escapeHtml(years)}${ageText}</span>` : ''}${person.place_of_birth ? `<span><span class="material-icons">place</span>${escapeHtml(person.place_of_birth)}</span>` : ''}</div></div>
                </div>
            </div>
            <div class="person-profile-body">
                <section class="person-bio-section"><div class="people-section-heading"><div><span class="people-kicker">THE STORY</span><h2>Biography</h2></div></div><p class="person-biography">${biography}</p><div class="person-resource-links">${externalLinksHtml}${person.homepage ? `<a class="person-homepage" href="${escapeHtml(person.homepage)}" target="_blank" rel="noopener noreferrer">Official website <span class="material-icons">open_in_new</span></a>` : ''}</div></section>
                ${gallery.length > 0 ? `<section class="person-gallery-section"><div class="people-section-heading"><div><span class="people-kicker">BEHIND THE LENS</span><h2>Photos</h2></div></div><div class="person-gallery">${gallery.slice(0,12).map((photo, index) => `<button class="person-photo-button" type="button" onclick="openPersonPhoto('${IMG_HERO + photo.file_path}', '${escapeInlineJsString(person.name || 'Person')} photo ${index + 1}')" aria-label="View photo ${index + 1}"><img src="${IMG_BASE + photo.file_path}" alt="${safeName}" loading="lazy"><span class="material-icons">zoom_in</span></button>`).join('')}</div></section>` : ''}
                <section class="person-works-section">
                    <div class="people-section-heading">
                        <div><span class="people-kicker">A CAREER IN FILM & TV</span><h2>Known for</h2></div>
                        <button class="see-all-btn" type="button" onclick="openPersonCredits('knownFor')">See All</button>
                    </div>
                    <div class="person-works-grid">${popular.length ? popular.map(creditCard).join('') : '<div class="people-empty">No credited works found.</div>'}</div>
                </section>
                <section class="person-works-section">
                    <div class="people-section-heading">
                        <div><span class="people-kicker">COMPLETE CREDITS</span><h2>Filmography</h2></div>
                        <button class="see-all-btn" type="button" onclick="openPersonCredits('filmography')">See All</button>
                    </div>
                    <div class="person-filmography">${credits.length ? credits.slice(0, 10).map(item => `<button class="person-credit-row" onclick="openDetails(${Number(item.id)}, '${item.media_type}')"><span class="person-credit-year">${(item.release_date || item.first_air_date || '').slice(0,4) || '—'}</span><span class="person-credit-title">${escapeHtml(item.title || item.name || 'Untitled')}</span><span class="person-credit-role">${escapeHtml(item.credit_role)}</span><span class="person-credit-type">${item.media_type === 'tv' ? 'TV' : 'Movie'}</span><span class="material-icons">chevron_right</span></button>`).join('') : '<div class="people-empty">No credits available.</div>'}</div>
                </section>
            </div>`;
    } catch (error) {
        root.innerHTML = '<div class="people-empty profile-error"><span class="material-icons">cloud_off</span><h2>Profile unavailable</h2><p>We could not retrieve this profile. Please try again.</p><button onclick="openPersonProfile(' + Number(id) + ', true)">Try again</button></div>';
    }
};


window.closePersonCredits = () => {
    const modal = document.getElementById('person-credits-modal');
    if (modal) {
        modal.classList.remove('active');
        document.body.classList.remove('no-scroll');
    }
};

window.openPersonCredits = (kind) => {
    const isKnownFor = kind === 'knownFor';
    const items = isKnownFor ? currentPersonCredits.knownFor : currentPersonCredits.filmography;
    if (!items || !items.length) return;

    let modal = document.getElementById('person-credits-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'person-credits-modal';
        modal.className = 'person-credits-modal';
        modal.innerHTML = '<div class="person-credits-dialog" role="dialog" aria-modal="true" aria-labelledby="person-credits-title"><div class="person-credits-header"><div><span class="people-kicker" id="person-credits-kicker"></span><h2 id="person-credits-title"></h2><p id="person-credits-description"></p></div><button class="person-credits-close" type="button" aria-label="Close"><span class="material-icons">close</span></button></div><div class="person-credits-tools"><label class="person-credits-search"><span class="material-icons">search</span><input id="person-credits-search" type="search" placeholder="Search titles or roles..." autocomplete="off"><kbd>Ctrl K</kbd></label><div class="person-credits-filters" role="group" aria-label="Filter credits"><button type="button" class="active" data-filter="all">All</button><button type="button" data-filter="movie">Movies</button><button type="button" data-filter="tv">TV Shows</button></div></div><div class="person-credits-results-bar"><span id="person-credits-count"></span><span>Sorted by <strong id="person-credits-sort"></strong></span></div><div id="person-credits-results" class="person-credits-results"></div></div>';
        document.body.appendChild(modal);
        modal.addEventListener('click', event => {
            if (event.target === modal || event.target.closest('.person-credits-close')) closePersonCredits();
        });
        modal.querySelector('#person-credits-search').addEventListener('input', renderPersonCreditsResults);
        modal.querySelector('.person-credits-filters').addEventListener('click', event => {
            const button = event.target.closest('[data-filter]');
            if (!button) return;
            modal.querySelectorAll('[data-filter]').forEach(item => item.classList.toggle('active', item === button));
            renderPersonCreditsResults();
        });
        modal.querySelector('#person-credits-results').addEventListener('click', event => {
            const item = event.target.closest('[data-credit-id]');
            if (!item) return;
            const id = Number(item.dataset.creditId);
            const type = item.dataset.mediaType;
            closePersonCredits();
            openDetails(id, type);
        });
        modal.querySelector('#person-credits-search').addEventListener('keydown', event => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
                event.preventDefault();
                event.currentTarget.focus();
            }
        });
    }

    modal.dataset.kind = kind;
    modal.querySelector('#person-credits-kicker').textContent = isKnownFor ? 'FEATURED WORKS' : 'COMPLETE CREDITS';
    modal.querySelector('#person-credits-title').textContent = isKnownFor ? 'Known for' : 'Filmography';
    modal.querySelector('#person-credits-description').textContent = isKnownFor ? 'Explore the productions that define this person’s career.' : 'Browse every credited movie and TV appearance.';
    modal.querySelector('#person-credits-sort').textContent = isKnownFor ? 'Popularity' : 'Release date';
    modal.querySelector('#person-credits-search').value = '';
    modal.querySelectorAll('[data-filter]').forEach(button => button.classList.toggle('active', button.dataset.filter === 'all'));
    modal.classList.add('active');
    document.body.classList.add('no-scroll');
    renderPersonCreditsResults();
    requestAnimationFrame(() => modal.querySelector('#person-credits-search').focus());
};

function renderPersonCreditsResults() {
    const modal = document.getElementById('person-credits-modal');
    if (!modal || !modal.classList.contains('active')) return;
    const isKnownFor = modal.dataset.kind === 'knownFor';
    const source = isKnownFor ? currentPersonCredits.knownFor : currentPersonCredits.filmography;
    const query = modal.querySelector('#person-credits-search').value.trim().toLocaleLowerCase();
    const filter = modal.querySelector('[data-filter].active')?.dataset.filter || 'all';
    const filtered = source.filter(item => {
        if (filter !== 'all' && item.media_type !== filter) return false;
        const title = item.title || item.name || '';
        const year = (item.release_date || item.first_air_date || '').slice(0, 4);
        const role = item.credit_role || '';
        return !query || (title + ' ' + year + ' ' + role).toLocaleLowerCase().includes(query);
    });
    modal.querySelector('#person-credits-count').textContent = filtered.length + (filtered.length === 1 ? ' result' : ' results');
    const results = modal.querySelector('#person-credits-results');
    if (!filtered.length) {
        results.innerHTML = '<div class="person-credits-empty"><span class="material-icons">search_off</span><strong>No matching titles</strong><span>Try another search or change the filters.</span></div>';
        return;
    }
    if (isKnownFor) {
        results.innerHTML = '<div class="person-credits-grid">' + filtered.map(item => {
            const title = escapeHtml(item.title || item.name || 'Untitled');
            const poster = item.poster_path ? IMG_BASE + item.poster_path : '';
            const year = (item.release_date || item.first_air_date || '').slice(0, 4);
            return '<button class="person-work-card" type="button" data-credit-id="' + Number(item.id) + '" data-media-type="' + item.media_type + '"><span class="person-work-poster">' + (poster ? '<img src="' + poster + '" alt="" loading="lazy">' : '<span class="material-icons">movie</span>') + '</span><span class="person-work-title">' + title + '</span><span class="person-work-meta">' + (year || 'Release date unknown') + ' · ' + (item.media_type === 'tv' ? 'TV' : 'Movie') + '</span></button>';
        }).join('') + '</div>';
    } else {
        results.innerHTML = '<div class="person-filmography person-credits-list">' + filtered.map(item => {
            const title = escapeHtml(item.title || item.name || 'Untitled');
            const year = (item.release_date || item.first_air_date || '').slice(0, 4) || '—';
            return '<button class="person-credit-row" type="button" data-credit-id="' + Number(item.id) + '" data-media-type="' + item.media_type + '"><span class="person-credit-year">' + year + '</span><span class="person-credit-title">' + title + '</span><span class="person-credit-role">' + escapeHtml(item.credit_role || '') + '</span><span class="person-credit-type">' + (item.media_type === 'tv' ? 'TV' : 'Movie') + '</span><span class="material-icons">chevron_right</span></button>';
        }).join('') + '</div>';
    }
}

window.switchTab = (tab) => {
    const onDashboard = dashboard.style.display === 'block';
    if (!onDashboard || currentTab !== tab) captureAndPushState();
    setElementVisible(document.getElementById('people-view'), false);
    setElementVisible(document.getElementById('person-profile-view'), false);
    setElementVisible(detailsView, false);
    setElementVisible(categoryView, false);
    setElementVisible(document.getElementById('community-view'), false);
    setElementVisible(document.getElementById('community-profile-view'), false);
    setElementVisible(dashboard, true, 'block');
    currentTab = tab;
    activeNavigationSection = tab;
    // Rebuild navigation with the correct section highlighted.
    setupNewNavigation();
    loadDashboard();
    window.scrollTo(0, 0);
};

window.openDetails = async (id, type, isHistory = false) => {
    if (!isHistory) captureAndPushState();

    setElementVisible(dashboard, false);
    setElementVisible(detailsView, true, 'block');
    setElementVisible(categoryView, false);
    setElementVisible(document.getElementById('people-view'), false);
    setElementVisible(document.getElementById('person-profile-view'), false);
    window.scrollTo(0,0);
    detailsContent.innerHTML = getSkeletonHtml('hero');

    try {
        const res = await fetch(`${TMDB_BASE}/${type}/${id}?api_key=${TMDB_KEY}&append_to_response=credits,videos,similar,release_dates,content_ratings,images&include_image_language=en,null`);
        const data = await res.json();
        currentDetailsData = { ...data, media_type: type }; // Store for watchlist logic
        
        const title = data.title || data.name;
        const safeTitle = escapeHtml(title);
        const titleForJs = escapeInlineJsString(title);
        // Use backdrop, fallback to poster if missing (fixes "different image" confusion if backdrop is null)
        const bgImage = data.backdrop_path ? data.backdrop_path : data.poster_path;
        const backdropStyle = bgImage ? `url('${IMG_HERO + bgImage}')` : 'linear-gradient(to bottom, #1a1a1a, #000)';
        
        let titleHtml = `<h1 class="hero-title" style="margin-bottom: 10px;">${safeTitle}</h1>`;
        if (data.images && data.images.logos && data.images.logos.length > 0) {
            const logo = data.images.logos.find(l => l.iso_639_1 === 'en') || data.images.logos[0];
            if (logo) {
                titleHtml = `<img src="${IMG_BASE + logo.file_path}" alt="${safeTitle}" class="hero-logo">`;
            }
        }
        
        // Date & Runtime
        const rawDate = data.release_date || data.first_air_date;
        const formattedDate = rawDate ? new Date(rawDate).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'N/A';
        
        let runtime = '';
        if (data.runtime) {
            runtime = `${Math.floor(data.runtime/60)}h ${data.runtime%60}m`;
        } else if (data.episode_run_time && data.episode_run_time.length > 0) {
            runtime = `${Math.floor(data.episode_run_time[0]/60)}h ${data.episode_run_time[0]%60}m`;
        }
        const runtimeHtml = runtime ? `<span style="color:#ccc;">${runtime}</span>` : '';

        // Certification
        const cert = getCertification(data, type);
        const certHtml = cert ? `<span style="border:1px solid rgba(255,255,255,0.4); padding:0 6px; font-size:0.75rem; border-radius: 4px; color:#eee;">${cert}</span>` : '';

        // Genres
        const genres = data.genres ? data.genres.map(g => g.name).join(', ') : '';
        const genresHtml = genres ? `<div style="color:#aaa; font-size:0.9rem; margin-bottom: 20px; font-weight: 500;">${escapeHtml(genres)}</div>` : '';

        const rating = data.vote_average ? data.vote_average.toFixed(1) : null;
        const ratingColor = getRatingColor(data.vote_average || 0);
        const ratingHtml = rating && parseFloat(rating) > 0 ? `<span style="color:${ratingColor}; font-weight:700; display:flex; align-items:center; gap:5px;"><span class="material-icons" style="font-size:16px;">star</span> ${rating}</span>` : '';
        
        let seasonHtml = '';
        if (type === 'tv' && data.seasons) {
            const seasons = data.seasons.filter(s => s.season_number > 0);
            seasonHtml = `
                <div class="seasons-section">
                    <div class="season-header">
                        <h2>Episodes</h2>
                        <div class="custom-select-wrapper">
                            <select class="season-select-dropdown" onchange="renderEpisodes('${id}', this.value, this.options[this.selectedIndex].dataset.count)">
                                ${seasons.map(s => `<option value="${s.season_number}" data-count="${s.episode_count}" ${s.season_number === 1 ? 'selected' : ''}>Season ${s.season_number}</option>`).join('')}
                            </select>
                        </div>
                    </div>
                    <div id="episodes-container" class="episodes-list"></div>
                </div>
            `;
        }

        // Cast HTML
        let castHtml = '';
        if (data.credits && data.credits.cast.length > 0) {
            castHtml = `
                <h3 class="details-section-title">Top Cast</h3>
                <div class="horizontal-list">
                    ${data.credits.cast.slice(0, 10).map(c => {
                        const imgContent = c.profile_path 
                            ? `<img class="cast-img" src="${IMG_BASE + c.profile_path}" alt="${escapeHtml(c.name)}" onerror="this.onerror=null; this.src='./icon.png';">`
                            : `<div class="cast-img cast-placeholder"><span class="material-icons">person</span></div>`;
                        return `
                        <div class="cast-card" onclick="openCastModal('${c.id}')" style="cursor:pointer;">
                            ${imgContent}
                            <div class="cast-name">${escapeHtml(c.name)}</div>
                            <div class="cast-char">${escapeHtml(c.character)}</div>
                        </div>
                    `}).join('')}
                </div>
            `;
        }

        // Similar Content HTML
        let similarHtml = '';
        if (data.similar && data.similar.results.length > 0) {
            const validSimilar = data.similar.results.filter(s => !excludedContent.includes(s.id.toString()) && s.poster_path);
            if (validSimilar.length > 0) {
                similarHtml = `
                <h3 class="details-section-title">You May Also Like</h3>
                <div class="horizontal-list">
                    ${validSimilar.map(s => `
                        <div class="poster-card" onclick="openDetails('${s.id}', '${type}')">
                            <img class="poster-img" src="${IMG_BASE + s.poster_path}" loading="lazy" alt="${escapeHtml(s.title || s.name)}" onerror="this.onerror=null; this.src='./icon.png';">
                            <div class="poster-info">
                                <div class="poster-title">${escapeHtml(s.title || s.name)}</div>
                            </div>
                        </div>
                    `).join('')}
                </div>
            `;
            }
        }

        // Watchlist Button State
        const inWatchlist = watchlist.some(i => i.id == id);
        const watchlistBtnIcon = inWatchlist ? 'check' : 'add';
        const watchlistBtnText = inWatchlist ? 'In Watchlist' : 'Add to Watchlist';

        // Like Button State
        const isLiked = likedContent.some(i => i.id == id);

        // Trailer Button
        const trailer = data.videos && data.videos.results ? data.videos.results.find(v => v.type === 'Trailer' && v.site === 'YouTube') : null;
        const trailerBtn = trailer ? `<button class="more-info-btn" onclick="openTrailer('${trailer.key}')"><span class="material-icons">movie</span> Trailer</button>` : '';
        
        detailsContent.innerHTML = `
            <div class="hero-section details-hero" style="--details-backdrop: ${backdropStyle};">
                <div class="hero-overlay details-hero-overlay"></div>
                <button onclick="closeDetails()" class="hero-icon-btn page-back-btn details-back-btn" aria-label="Back"><span class="material-icons">arrow_back</span></button>
                <div class="details-hero-content">
                    ${titleHtml}
                    <div class="hero-meta" style="margin-bottom: 10px; align-items: center; flex-wrap: wrap; gap: 12px;">
                        ${ratingHtml}
                        ${certHtml}
                        <span>${formattedDate}</span>
                        ${runtimeHtml}
                    </div>
                    ${genresHtml}
                    <div class="hero-btns" style="margin-bottom: 20px;">
                        <button class="play-btn" onclick="playItem('${id}', '${type}')"><span class="material-icons">play_arrow</span> Watch Now</button>
                        ${trailerBtn}
                        <button class="more-info-btn" id="watchlist-btn" onclick="toggleWatchlist('${id}')">
                            <span class="material-icons">${watchlistBtnIcon}</span> ${watchlistBtnText}
                        </button>
                    </div>
                    <div class="hero-actions" style="margin-bottom: 20px;">
                        <button id="like-btn" onclick="toggleLike('${id}')" class="hero-icon-btn ${isLiked ? 'liked' : ''}" title="${isLiked ? 'Unlike' : 'Like'}">
                            <span class="material-icons">${isLiked ? 'thumb_up' : 'thumb_up_off_alt'}</span>
                            <div class="action-tooltip">We'll recommend more like this</div>
                        </button>
                        <button onclick="rateContent('${id}', '${type}', '${titleForJs}')" class="hero-icon-btn" title="Rate">
                            <span class="material-icons">star_border</span>
                        </button>
                        <button onclick="shareContent('${titleForJs}')" class="hero-icon-btn" title="Share">
                            <span class="material-icons">share</span>
                        </button>
                        <button onclick="openDownload('${id}', '${type}')" class="hero-icon-btn" title="Download">
                            <span class="material-icons">download</span>
                        </button>
                        <button onclick="reportStreamIssue('${id}', '${titleForJs}')" class="hero-icon-btn destructive" title="Hide Content">
                            <span class="material-icons">visibility_off</span>
                        </button>
                    </div>
                    <p class="hero-desc" style="margin-bottom: 20px;">${escapeHtml(data.overview || '')}</p>
                </div>
            </div>
            ${seasonHtml}
            ${castHtml}
            ${similarHtml}
        `;

        if (type === 'tv') {
            const s1 = data.seasons.find(s => s.season_number === 1);
            if(s1) renderEpisodes(id, 1, s1.episode_count);
        }
    } catch (e) {
        detailsContent.innerHTML = '<p>Error loading details.</p>';
    }

    // Update URL
    if (!isHistory) updateUrl(id, type);
};

function closeDetails() {
    handleBack();
}

window.toggleWatchlist = (id) => {
    const index = watchlist.findIndex(i => i.id == id);
    const btn = document.getElementById('watchlist-btn');
    
    if (index > -1) {
        // Remove
        watchlist.splice(index, 1);
        if(btn) {
            btn.innerHTML = '<span class="material-icons">add</span> Add to Watchlist';
        }
    } else {
        // Add
        if (currentDetailsData) {
            const item = {
                id: currentDetailsData.id,
                media_type: currentDetailsData.media_type,
                title: currentDetailsData.title || currentDetailsData.name,
                poster_path: currentDetailsData.poster_path,
                // Optimized: Removed backdrop_path and overview to save storage space
                // We fetch these fresh from API when opening details anyway
                release_date: currentDetailsData.release_date || currentDetailsData.first_air_date,
                vote_average: currentDetailsData.vote_average
            };
            watchlist.unshift(item);
            if(btn) {
                btn.innerHTML = '<span class="material-icons">check</span> In Watchlist';
            }
        }
    }
    updateDashboardWatchlist();
    if(currentProfile) localStorage.setItem(`gtv_watchlist_${currentProfile.id}`, JSON.stringify(watchlist));
    persistCurrentProfileData();
};

window.toggleLike = (id) => {
    const index = likedContent.findIndex(i => i.id == id);
    const btn = document.getElementById('like-btn');
    const icon = btn.querySelector('.material-icons');
    const tooltip = btn.querySelector('.action-tooltip');

    if (index > -1) {
        // Unlike
        likedContent.splice(index, 1);
        btn.classList.remove('liked');
        icon.innerText = 'thumb_up_off_alt';
        btn.title = 'Like';
    } else {
        // Like
        if (currentDetailsData) {
             const item = {
                id: currentDetailsData.id,
                media_type: currentDetailsData.media_type,
                title: currentDetailsData.title || currentDetailsData.name,
            };
            likedContent.unshift(item);
        }
        btn.classList.add('liked', 'like-animation');
        icon.innerText = 'thumb_up';
        btn.title = 'Unlike';
        
        // Tooltip Bounds Logic
        const btnRect = btn.getBoundingClientRect();
        if (btnRect.left < 150) {
            tooltip.classList.add('left-aligned');
        } else {
            tooltip.classList.remove('left-aligned');
        }
        
        tooltip.classList.add('visible');
        setTimeout(() => tooltip.classList.remove('visible'), 2500);
        setTimeout(() => btn.classList.remove('like-animation'), 600);
        if (currentDetailsData) injectRecommendationRow(currentDetailsData);
    }
    if(currentProfile) localStorage.setItem(`gtv_liked_content_${currentProfile.id}`, JSON.stringify(likedContent));
    persistCurrentProfileData();
};

window.renderEpisodes = async (tmdbId, seasonNum, count, btnElement) => {
    if(btnElement) {
        document.querySelectorAll('.season-tag').forEach(b => b.classList.remove('active'));
        btnElement.classList.add('active');
    }
    const container = document.getElementById('episodes-container');
    container.innerHTML = getSkeletonHtml('episodes');
    
    try {
        const res = await fetch(`${TMDB_BASE}/tv/${tmdbId}/season/${seasonNum}?api_key=${TMDB_KEY}`);
        const data = await res.json();
        if (!data.episodes || data.episodes.length === 0) {
            container.innerHTML = '<p>No episodes found.</p>';
            return;
        }

        container.innerHTML = data.episodes.map(ep => {
            const still = ep.still_path ? IMG_BASE + ep.still_path : null;
            const imgContent = still 
                ? `<img src="${still}" loading="lazy" alt="${escapeHtml(ep.name)}" onerror="this.onerror=null; this.src='./icon.png';">`
                : `<div class="episode-placeholder"><span class="material-icons">smart_display</span></div>`;
            return `
                <div class="episode-card" onclick="playItem('${tmdbId}', 'tv', ${seasonNum}, ${ep.episode_number})">
                    <div class="episode-img-container">
                        ${imgContent}
                        <div class="play-overlay"><span class="material-icons">play_arrow</span></div>
                    </div>
                    <div class="episode-info">
                        <h4>${ep.episode_number}. ${escapeHtml(ep.name || 'Episode')}</h4>
                        <p>${escapeHtml(ep.overview || 'No description available.')}</p>
                    </div>
                </div>
            `;
        }).join('');
    } catch (e) {
        container.innerHTML = '<p>Error loading episodes.</p>';
    }
};

window.playItem = async (id, type, season = 1, episode = 1) => {
    // Store current play info for source switching
    window.currentPlayInfo = { id, type, season, episode };
    const episodesBtn = document.getElementById('player-episodes-btn');
    const episodesPanel = document.getElementById('player-episodes-panel');
    if (episodesBtn) episodesBtn.style.display = type === 'tv' ? 'flex' : 'none';
    if (episodesPanel) { episodesPanel.classList.remove('active'); episodesPanel.dataset.loadedFor = ''; }
    
    setElementVisible(playerContainer, true, 'flex');
    playerContainer.classList.remove('controls-hidden');
    if (window.showGtvPlayerControls) window.showGtvPlayerControls();
    document.body.style.overflow = 'hidden';
    const itemData = await addToHistory(id, type, season, episode);
    
    const hideBtn = document.getElementById('player-hide-btn');
    if (hideBtn && itemData) {
        const title = escapeInlineJsString(itemData.title || '');
        hideBtn.onclick = () => reportStreamIssue(id, title);
    }
    
    loadPlayerSource();
};

async function addToHistory(id, type, season = null, episode = null) {
    const historyKey = currentProfile ? `gtv_watch_history_${currentProfile.id}` : 'gtv_watch_history';
    let history = safeJsonParse(historyKey, []);

    // Use the exact episode selected for this playback instead of relying on
    // the global player state, which can be stale during rapid episode changes.
    if (type === 'tv') {
        season = Number(season) || 1;
        episode = Number(episode) || 1;
    } else {
        season = null;
        episode = null;
    }

    let itemData = null;
    if (currentDetailsData && currentDetailsData.id == id) {
        itemData = {
            id: currentDetailsData.id,
            media_type: type,
            title: currentDetailsData.title || currentDetailsData.name,
            backdrop_path: currentDetailsData.backdrop_path,
            poster_path: currentDetailsData.poster_path,
            season: season,
            episode: episode
        };
    } else {
        const existing = history.find(i => i.id == id);
        if (existing) {
            itemData = existing;
            // Update season/episode for existing item
            itemData.season = season;
            itemData.episode = episode;
        } else {
            try {
                const res = await fetch(`${TMDB_BASE}/${type}/${id}?api_key=${TMDB_KEY}`);
                const data = await res.json();
                itemData = {
                    id: data.id,
                    media_type: type,
                    title: data.title || data.name,
                    backdrop_path: data.backdrop_path,
                    poster_path: data.poster_path,
                    season: season,
                    episode: episode
                };
            } catch(e) { console.error("Failed to fetch history item", e); return null; }
        }
    }

    history = history.filter(i => i.id != id);
    history.unshift(itemData);
    if (history.length > 20) history.pop();
    
    localStorage.setItem(historyKey, JSON.stringify(history));
    await persistCurrentProfileData();
    updateContinueWatchingRow();
    return itemData;
}

window.loadPlayerSource = (playbackOptions = {}) => {
    const { id, type, season, episode } = window.currentPlayInfo;
    const baseUrl = playerSources[currentSourceIdx];
    if (iframe) iframe.style.pointerEvents = '';

    let embedUrl = type === 'movie' 
        ? `${baseUrl}/movie/${id}`
        : `${baseUrl}/tv/${id}/${season}/${episode}`;
        
    if (baseUrl.includes('vidking.net')) {
        const query = new URLSearchParams();
        if (playbackOptions.autoplay !== false) query.set('autoPlay', 'true');
        if (Number.isFinite(Number(playbackOptions.progress)) && playbackOptions.progress > 0) query.set('progress', String(playbackOptions.progress));
        if (type === 'tv') {
            query.set('nextEpisode', 'true');
            query.set('episodeSelector', 'true');
        }
        embedUrl += query.toString() ? '?' + query.toString() : '';
    } else if (baseUrl.includes('vidfast')) {
        embedUrl += '?autoPlay=true&theme=12B1D1';
    } else if (baseUrl.includes('player.videasy.net')) {
        embedUrl += '?overlay=true&color=12B1D1';
        if (type === 'tv') {
            embedUrl += '&nextEpisode=true&episodeSelector=true&autoplayNextEpisode=true';
        }
    } else {
        embedUrl += '?autoplay=1';
    }
        
    // Set attributes that can help with embed compatibility
    iframe.setAttribute('referrerpolicy', 'origin');
    iframe.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture; encrypted-media; clipboard-write');
    iframe.setAttribute('allowfullscreen', ''); // For older browsers
    iframe.setAttribute('frameborder', '0');
    iframe.setAttribute('scrolling', 'no');

    iframe.src = embedUrl;
    if (window.bindGtvPlayerFrameEvents) window.bindGtvPlayerFrameEvents();

    // Update Dropdown Active State (Sync UI)
    const options = document.querySelectorAll('.server-option');
    options.forEach((opt, idx) => {
        if (idx === currentSourceIdx) opt.classList.add('active');
        else opt.classList.remove('active');
    });
    
    // Show toast to indicate source
    const domain = new URL(baseUrl).hostname;
    showToast(`Playing from: ${domain}`);
};

window.selectPlayerSource = (index) => {
    currentSourceIdx = index;
    loadPlayerSource();
    document.getElementById('server-dropdown-menu').classList.remove('active');
};


window.openCastModal = async (personId) => {
    const overlay = document.getElementById('cast-modal-overlay');
    setModalActive(overlay, true);
    document.body.style.overflow = 'hidden';
    
    document.getElementById('cast-modal-name').innerText = 'Loading...';
    document.getElementById('cast-modal-bio').innerText = '';
    document.getElementById('cast-modal-actions').innerHTML = '';
    
    const imgContainer = document.getElementById('cast-modal-img-container');
    imgContainer.innerHTML = '<div class="cast-modal-img cast-placeholder"><span class="material-icons" style="font-size:80px;">person</span></div>';
    
    try {
        const res = await fetch(`${TMDB_BASE}/person/${personId}?api_key=${TMDB_KEY}`);
        const data = await res.json();
        
        document.getElementById('cast-modal-name').innerText = data.name;
        document.getElementById('cast-modal-bio').innerText = data.biography || 'No biography available.';
        
        const wikiUrl = `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(data.name)}`;
        document.getElementById('cast-modal-actions').innerHTML = `
            <a href="${wikiUrl}" target="_blank" class="more-info-btn" style="display:inline-flex; width:auto; padding:8px 20px; font-size:0.8rem; text-decoration:none;">
                <span class="material-icons" style="font-size:18px;">public</span> Wikipedia
            </a>
        `;
        
        if (data.profile_path) {
            imgContainer.innerHTML = `<img class="cast-modal-img" src="${IMG_BASE + data.profile_path}" alt="${escapeHtml(data.name)}" onerror="this.onerror=null; this.src='./icon.png';">`;
        } else {
            imgContainer.innerHTML = '<div class="cast-modal-img cast-placeholder"><span class="material-icons" style="font-size:80px;">person</span></div>';
        }
        
        document.getElementById('cast-modal-meta').innerText = `Born: ${data.birthday || 'Unknown'} ${data.place_of_birth ? 'in ' + data.place_of_birth : ''}`;
    } catch(e) {
        document.getElementById('cast-modal-name').innerText = 'Error loading info';
    }
};

window.closeCastModal = (e, force = false) => {
    if (force || e.target.id === 'cast-modal-overlay') {
        setModalActive('cast-modal-overlay', false);
        document.body.style.overflow = '';
    }
};

function closePlayer() {
    // To completely kill the player and any running scripts/videos,
    // we remove the iframe from the DOM and then recreate it.
    const newIframe = document.createElement('iframe');
    newIframe.id = 'stream-frame';
    // Copy attributes from the original HTML to ensure it works the same
    newIframe.setAttribute('frameborder', '0');
    newIframe.setAttribute('allowfullscreen', '');
    newIframe.setAttribute('allow', 'autoplay; encrypted-media');
    
    iframe.parentNode.replaceChild(newIframe, iframe);
    iframe = newIframe; // Update the global reference to the new iframe

    setElementVisible(playerContainer, false);
    playerContainer.classList.remove('controls-hidden');
    document.body.style.overflow = '';
}

window.openTrailer = (key) => {
    setModalActive('trailer-modal-overlay', true);
    const container = document.querySelector('#trailer-modal-overlay .trailer-container');
    container.innerHTML = `<iframe id="trailer-frame" src="https://www.youtube.com/embed/${key}?autoplay=1" frameborder="0" allowfullscreen allow="autoplay"></iframe>`;
};

window.closeTrailerModal = (e, force) => {
    if (force || e.target.id === 'trailer-modal-overlay') {
        setModalActive('trailer-modal-overlay', false);
        const container = document.querySelector('#trailer-modal-overlay .trailer-container');
        if (container) container.innerHTML = ''; // Completely remove iframe to kill audio
    }
};

window.openDownload = (id, type) => {
    window.open(`https://dl.vidsrc.vip/${type}/${id}`, '_blank');
};

window.openInfoView = (title, content) => {
    prepareCategoryView();
    
    document.getElementById('category-title').innerText = title;
    categoryList.innerHTML = content;
    
    const existingBtn = document.getElementById('cat-load-more-container');
    if(existingBtn) existingBtn.remove();
    
    const dd = document.getElementById('nav-dropdown');
    if(dd) dd.classList.remove('active');
};

window.openHelpView = () => {
    openInfoView('Help Center', `
        <div style="max-width: 860px; margin: 0 auto; padding: 28px 22px 50px; line-height: 1.85; color: #d0d0d0; font-size: 1.08rem;">
            <h3 style="color:#fff; font-size:1.55rem; line-height:1.3; margin:0 0 14px;">Getting Started</h3>
            <p style="margin:0 0 18px;">Welcome to GTV hub, a place to discover movies and TV shows, explore actors and filmmakers, build your own watchlist, and find something to watch. The home screen brings together featured picks, popular titles, trending selections, highly rated movies and shows, genre collections, and recommendations based on titles you like. You can browse without creating an account, or sign in to keep supported profile information synchronized across devices.</p>

            <h4 style="color:#fff; font-size:1.22rem; margin:32px 0 10px;">1. Guest Mode, Accounts, and Signing In</h4>
            <p style="margin:0 0 14px;">GTV hub supports two ways to use the app. <strong>Continue as Guest</strong> lets you start browsing without registering. Guest profiles and supported activity are saved in the browser on the device you are using. This is convenient if you use one device, but guest information does not automatically follow you to another browser or device.</p>
            <p style="margin:0 0 14px;">You can also choose to <strong>create an account</strong> with your email address and a password. Follow the email confirmation step if one is sent, then sign in. Your account lets GTV hub store supported profile information in its cloud database so you can sign in on another device and continue with the same account and profile. Use the Sign In option in the account/profile area when you want to access your account.</p>
            <p style="margin:0 0 14px;">Signing out ends the current signed-in session; it is not the same as deleting your account. If you return as a guest, you will see the guest data stored in that browser rather than automatically seeing the account's cloud profiles. To access cloud-saved profiles again, sign back into the same account.</p>

            <h4 style="color:#fff; font-size:1.22rem; margin:32px 0 10px;">2. Profiles and Profile Management</h4>
            <p style="margin:0 0 14px;">Profiles help keep each viewer's experience separate. Each profile can have its own watchlist, liked titles, hidden titles, viewing activity, and supported settings. When the profile screen appears, select the profile you want to use. Open <strong>Switch Profile</strong> from the menu whenever you want to change viewers.</p>
            <p style="margin:0 0 14px;">Choose <strong>Manage Profiles</strong> to create a profile, change its name or appearance where available, or remove a profile you no longer need. If you are signed in, profiles belonging to your account are saved with that account. Guest profiles remain in the browser's local storage. Deleting a profile also deletes the data associated with that profile, so make sure you have selected the right one before confirming.</p>
            <p style="margin:0 0 14px;">If you previously used GTV hub as a guest and are now creating an account, the app may offer to import eligible profiles from the current device. Review the profiles before confirming the import. Importing is intended to move supported profile information into your account so it can be synchronized.</p>

            <h4 style="color:#fff; font-size:1.22rem; margin:32px 0 10px;">3. Exploring the Home Screen</h4>
            <p style="margin:0 0 14px;">The home screen is organized into rows and featured areas that make it easier to find something to watch. Depending on the selected Movies or TV Shows section and the information available from the catalogue, you may see featured titles, Trending Now, Top Rated, Popular on GTV, upcoming titles, genre collections, and other discovery rows.</p>
            <p style="margin:0 0 14px;">The featured area highlights selected titles. Scroll through the page to browse more rows, and select a poster to open its details. Some rows include a See All option so you can open a larger collection of titles. Catalogue selections can change as the service refreshes its data.</p>

            <h4 style="color:#fff; font-size:1.22rem; margin:32px 0 10px;">4. Search for Movies, Shows, and People</h4>
            <p style="margin:0 0 14px;">Select the search icon in the top navigation and enter at least a couple of characters. Search can find movies, TV shows, and people using the catalogue's search service. Choose a result to open its details or profile. Search results can be expanded with <strong>Load More</strong> when more pages are available.</p>
            <p style="margin:0 0 14px;">Recent searches may appear when the search field is empty. You can remove an individual search or clear the search history. Search history is stored in the browser, so it is specific to that browser rather than a shared account-wide search list.</p>

            <h4 style="color:#fff; font-size:1.22rem; margin:32px 0 10px;">5. Categories, Genres, and Moods</h4>
            <p style="margin:0 0 14px;">Open <strong>Categories</strong> from the main menu to explore curated ways of browsing. You can jump into collections such as Trending Now, Top Rated, and other catalogue categories, or choose a mood/genre collection to discover titles with a particular feel. Select a category to see its available movies or shows, then select any poster for more information.</p>

            <h4 style="color:#fff; font-size:1.22rem; margin:32px 0 10px;">6. Movie and TV Show Details</h4>
            <p style="margin:0 0 14px;">A title's details page brings together the information available for that movie or series, such as its overview, release information, genres, ratings, artwork, cast, and related titles. For TV shows, browse the available seasons and episodes and choose the episode you want to play.</p>
            <p style="margin:0 0 14px;">The <strong>You May Also Like</strong> area can help you find related titles. Select cast members to explore their profiles and other work. Not every title has complete metadata, artwork, trailers, or episode information, because those details depend on the external catalogue.</p>

            <h4 style="color:#fff; font-size:1.22rem; margin:32px 0 10px;">7. Playing Movies and Episodes</h4>
            <p style="margin:0 0 14px;">Select <strong>Play Now</strong> on a movie or choose an episode on a TV show's details page. GTV hub provides the catalogue interface and opens a player supplied by an external playback provider. The title appearing in GTV hub does not guarantee that every provider has a working stream for it.</p>
            <p style="margin:0 0 14px;">The player may offer a server/source selector. If playback fails, try another available source. Providers can differ in availability, video quality, subtitles, loading speed, and player behavior. Some may be temporarily unavailable or may not carry a particular movie or episode.</p>
            <p style="margin:0 0 14px;">Playback is handled by third-party services. Their players may have separate controls, privacy policies, advertisements, or popups. GTV hub cannot guarantee the availability or behavior of those external players.</p>

            <h4 style="color:#fff; font-size:1.22rem; margin:32px 0 10px;">8. Watchlist, Likes, and Recommendations</h4>
            <p style="margin:0 0 14px;">Select <strong>Add to Watchlist</strong> on a title to save it for later. Open <strong>My Watchlist</strong> from the menu to see your saved titles. The watchlist page lets you search your saved items, filter by Movies or TV Shows, and sort the list using the available sorting options. Remove titles when you no longer want to keep them.</p>
            <p style="margin:0 0 14px;">Use the Like control on a title to tell GTV hub what you enjoy. Liked titles can be used to build recommendation rows such as <strong>Because you liked…</strong> on the home screen. You can also rate a title where the rating option is available. Likes and ratings are separate actions: liking a title helps guide discovery, while rating lets you record your own score in the app's available rating feature.</p>

            <h4 style="color:#fff; font-size:1.22rem; margin:32px 0 10px;">9. Continue Watching and Viewing History</h4>
            <p style="margin:0 0 14px;">The <strong>Continue Watching</strong> row helps you return to shows or movies you have already started when viewing activity is available. For series, it can help you get back to the relevant episode rather than searching for the title again. The information is associated with the active profile, so switching profiles changes the viewing activity you see.</p>
            <p style="margin:0 0 14px;">Guest viewing information is kept locally on the device. Supported viewing information for signed-in profiles is synchronized through your account. If an item does not appear, check that you are using the expected profile and account.</p>

            <h4 style="color:#fff; font-size:1.22rem; margin:32px 0 10px;">10. Hidden Content</h4>
            <p style="margin:0 0 14px;">If you do not want a title included in your browsing experience, use the hide option when available. Open <strong>Hidden Content</strong> from the main menu to review titles you have hidden. You can unhide an item to allow it to appear in your lists again. Hiding a title only affects your GTV hub experience; it does not remove the title or video from an external catalogue or provider.</p>

            <h4 style="color:#fff; font-size:1.22rem; margin:32px 0 10px;">11. People and Cast Discovery</h4>
            <p style="margin:0 0 14px;">Choose <strong>People</strong> in the top navigation to discover popular actors and search for a person by name. Open a person's profile to see the available biography, photos, notable work, and filmography. You can browse their credits and open a movie or show directly from the person's profile. The amount of information varies by person and by the catalogue data available.</p>

            <h4 style="color:#fff; font-size:1.22rem; margin:32px 0 10px;">12. Random Pick and Trailers</h4>
            <p style="margin:0 0 14px;">Not sure what to watch? Choose <strong>Random Pick</strong> from the menu to let GTV hub select a movie or show for you. When a trailer is available for a title, its details page may show a <strong>Trailer</strong> button that opens the trailer player. Trailer availability depends on the catalogue and the external video service hosting it.</p>

            <h4 style="color:#fff; font-size:1.22rem; margin:32px 0 10px;">13. Settings and TMDB API Keys</h4>
            <p style="margin:0 0 14px;">Open <strong>Settings</strong> from the main menu to adjust the preferences currently offered by the app. These include options such as your region, the default Movies or TV Shows tab, reduced motion, and managing catalogue API keys. The exact options shown may change between releases.</p>
            <p style="margin:0 0 14px;">GTV hub uses The Movie Database (TMDB) for catalogue information, including movie and TV details, posters, and cast information. If you have your own TMDB API key, you can add and manage it in Settings. Keep personal API keys private, especially on shared devices. Changing the API key affects catalogue requests; it does not change which playback providers are available.</p>

            <h4 style="color:#fff; font-size:1.22rem; margin:32px 0 10px;">14. Account Data, Local Data, and Devices</h4>
            <p style="margin:0 0 14px;">GTV hub uses browser storage for local preferences, session information, and locally cached data. In guest mode, profile information stays in that browser unless you clear it or use an available import process. When signed in, supported profile information is also saved to the account's cloud data so it can be loaded on another device after you sign in with the same account.</p>
            <p style="margin:0 0 14px;">For the best cross-device experience, sign in on each device and select the same profile. Clearing browser data can remove guest information and local cached information. It does not necessarily delete cloud data already associated with your account.</p>

            <h4 style="color:#fff; font-size:1.22rem; margin:32px 0 10px;">15. Troubleshooting</h4>
            <p style="margin:0 0 12px;"><strong>The home screen or images do not load:</strong> Check your internet connection and refresh the page. Catalogue information comes from an external service, so temporary service interruptions can affect results.</p>
            <p style="margin:0 0 12px;"><strong>A movie or episode will not play:</strong> Try another playback provider, reload the player, and check whether another source has the title. A missing image can mean catalogue information is incomplete, but it does not always mean playback is impossible.</p>
            <p style="margin:0 0 12px;"><strong>My watchlist or profiles are missing:</strong> Check which profile is selected. If you expect cloud data, make sure you are signed in to the correct account. Guest data is tied to the browser and device where it was created.</p>
            <p style="margin:0 0 12px;"><strong>My data is not appearing on another device:</strong> Guest data does not sync between devices. Sign in with the same account on both devices and select the same profile.</p>
            <p style="margin:0 0 12px;"><strong>Search returns no results:</strong> Try a shorter title or a different spelling. Some people, movies, and shows may not be present in the catalogue.</p>
            <p style="margin:0 0 12px;"><strong>The app looks out of date after an update:</strong> Refresh the page. If an older version continues to appear, close and reopen the site or clear the site's cached files in your browser.</p>

            <h4 style="color:#fff; font-size:1.22rem; margin:32px 0 10px;">16. Ads, Popups, and External Services</h4>
            <p style="margin:0 0 14px;">GTV hub uses external services for catalogue data and playback. Third-party video players may display advertisements, open new tabs, or use their own cookies and tracking technologies. Those experiences are controlled by the provider, not by GTV hub. Be cautious with unfamiliar popups and never enter sensitive information into a page unless you trust the service.</p>
            <p style="margin:0 0 14px;">If you prefer not to see advertisements, you can use an ad blocker in your browser or on your device. <strong>Our recommendation is <a href="https://adguard.com/" target="_blank" rel="noopener noreferrer" style="color:var(--accent);">AdGuard</a></strong>, which offers ad-blocking options for supported browsers and devices. Ad blockers are third-party tools and are not part of GTV hub. Their effectiveness varies, and some video providers may not work correctly when an ad blocker is enabled. If playback stops working, try allowing the provider's site or temporarily disabling the blocker for that page.</p>

            <p style="margin-top:30px; padding-top:18px; border-top:1px solid rgba(255,255,255,0.1); color:#aaa; font-size:0.98rem;">Need more help or found a problem? Use the feedback link in the About section to contact the GTV hub team.</p>
        </div>
    `);
};

window.openAboutView = () => {
    openInfoView('About', `
        <div style="max-width: 900px; margin: 0 auto; padding: 40px 20px; color: #e0e0e0; font-family: 'Outfit', sans-serif;">
            
            <!-- Hero Header -->
            <div style="text-align: center; margin-bottom: 60px; position: relative;">
                <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 200px; height: 200px; background: var(--accent); filter: blur(100px); opacity: 0.2; z-index: -1;"></div>
                <img src="../icon.png" alt="GTV hub" style="width: 100px; height: 100px; border-radius: 24px; margin-bottom: 25px; box-shadow: 0 20px 40px rgba(0,0,0,0.3);">
                <h1 style="font-size: 3.5rem; font-weight: 800; margin: 0 0 10px 0; letter-spacing: -1px; background: linear-gradient(135deg, #3498db 0%, #9b59b6 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">GTV <span style="font-weight: 300;">hub</span></h1>
                <div style="display: flex; align-items: center; justify-content: center; gap: 15px; margin-bottom: 30px;">
                    <span style="background: rgba(255,255,255,0.1); padding: 6px 16px; border-radius: 20px; font-size: 0.85rem; font-weight: 600; letter-spacing: 0.5px; border: 1px solid rgba(255,255,255,0.1);">v3.0.0</span>
                    <span style="background: rgba(52, 152, 219, 0.15); color: #3498db; padding: 6px 16px; border-radius: 20px; font-size: 0.85rem; font-weight: 600; letter-spacing: 0.5px; border: 1px solid rgba(52, 152, 219, 0.2);">Stable</span>
                </div>
                <p style="font-size: 1.2rem; line-height: 1.6; color: #aaa; max-width: 500px; margin: 0 auto 35px auto;">
                    The ultimate destination for streaming movies and TV shows. Fast, simple, and designed for you.
                </p>
                <a href="https://ko-fi.com/exeinn" target="_blank" style="text-decoration:none;">
                    <button style="background: linear-gradient(135deg, var(--accent) 0%, #9b59b6 100%); border: none; color: white; padding: 14px 35px; border-radius: 50px; font-weight: 700; font-size: 1rem; cursor: pointer; transition: all 0.2s; box-shadow: 0 10px 30px rgba(52, 152, 219, 0.3); display: inline-flex; align-items: center; gap: 10px;">
                        <span class="material-icons">local_cafe</span> Support Development
                    </button>
                </a>
            </div>

            <!-- Features Grid -->
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 25px; margin-bottom: 70px;">
                <div style="background: rgba(255,255,255,0.03); padding: 30px; border-radius: 24px; border: 1px solid rgba(255,255,255,0.05); transition: transform 0.3s; position: relative; overflow: hidden;">
                    <div style="width: 50px; height: 50px; background: rgba(52, 152, 219, 0.1); border-radius: 16px; display: flex; align-items: center; justify-content: center; margin-bottom: 20px;">
                        <span class="material-icons" style="color: #3498db; font-size: 26px;">bolt</span>
                    </div>
                    <h3 style="color: #fff; margin: 0 0 10px 0; font-size: 1.3rem;">Lightning Fast</h3>
                    <p style="color: #888; font-size: 0.95rem; line-height: 1.6; margin: 0;">Optimized for performance with minimal buffering and instant load times.</p>
                </div>
                <div style="background: rgba(255,255,255,0.03); padding: 30px; border-radius: 24px; border: 1px solid rgba(255,255,255,0.05);">
                    <div style="width: 50px; height: 50px; background: rgba(155, 89, 182, 0.1); border-radius: 16px; display: flex; align-items: center; justify-content: center; margin-bottom: 20px;">
                        <span class="material-icons" style="color: #9b59b6; font-size: 26px;">devices</span>
                    </div>
                    <h3 style="color: #fff; margin: 0 0 10px 0; font-size: 1.3rem;">Responsive</h3>
                    <p style="color: #888; font-size: 0.95rem; line-height: 1.6; margin: 0;">A seamless experience across mobile, tablet, and desktop devices.</p>
                </div>
                <div style="background: rgba(255,255,255,0.03); padding: 30px; border-radius: 24px; border: 1px solid rgba(255,255,255,0.05);">
                    <div style="width: 50px; height: 50px; background: rgba(231, 76, 60, 0.1); border-radius: 16px; display: flex; align-items: center; justify-content: center; margin-bottom: 20px;">
                        <span class="material-icons" style="color: #e74c3c; font-size: 26px;">security</span>
                    </div>
                    <h3 style="color: #fff; margin: 0 0 10px 0; font-size: 1.3rem;">Privacy First</h3>
                    <p style="color: #888; font-size: 0.95rem; line-height: 1.6; margin: 0;">Use GTV hub as a guest or sign in to sync your profiles and supported data across devices.</p>
                </div>
            </div>

            <!-- Sources Section -->
            <div style="margin-bottom: 70px;">
                <h3 style="color: #fff; font-size: 1.5rem; margin-bottom: 25px; display: flex; align-items: center; gap: 10px;">
                    <span style="width: 4px; height: 24px; background: var(--accent); border-radius: 2px; display: block;"></span>
                    Powered By
                </h3>
                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px;">
                    <div style="display: flex; align-items: center; gap: 20px; background: rgba(255,255,255,0.02); padding: 25px; border-radius: 20px; border: 1px solid rgba(255,255,255,0.05);">
                        <div style="width: 50px; height: 50px; background: rgba(1, 180, 228, 0.1); border-radius: 12px; display: flex; align-items: center; justify-content: center;">
                            <span class="material-icons" style="color: #01b4e4;">movie</span>
                        </div>
                        <div>
                            <div style="color: #fff; font-weight: 700; font-size: 1.1rem;">TMDB API</div>
                            <div style="font-size: 0.85rem; color: #888; margin-top: 5px;">Metadata, posters, and cast info.</div>
                        </div>
                    </div>
                    <div style="display: flex; align-items: center; gap: 20px; background: rgba(255,255,255,0.02); padding: 25px; border-radius: 20px; border: 1px solid rgba(255,255,255,0.05);">
                        <div style="width: 50px; height: 50px; background: rgba(231, 76, 60, 0.1); border-radius: 12px; display: flex; align-items: center; justify-content: center;">
                            <span class="material-icons" style="color: #e74c3c;">smart_display</span>
                        </div>
                        <div>
                            <div style="color: #fff; font-weight: 700; font-size: 1.1rem;">Playback Providers</div>
                            <div style="font-size: 0.85rem; color: #888; margin-top: 5px;">Multiple third-party video sources.</div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Feedback Section -->
            <div style="background: linear-gradient(to right, rgba(52, 152, 219, 0.05), rgba(155, 89, 182, 0.05)); padding: 50px; border-radius: 30px; text-align: center; border: 1px solid rgba(255,255,255,0.05);">
                <h3 style="color: #fff; font-size: 2rem; margin: 0 0 15px 0;">Have Feedback?</h3>
                <p style="color: #aaa; margin: 0 0 30px 0; max-width: 500px; margin-left: auto; margin-right: auto; font-size: 1.1rem;">
                    We are constantly working to improve GTV hub. Let us know if you have suggestions or spot any bugs.
                </p>
                <a href="mailto:exeinn.info@gmail.com?subject=GTV hub Feedback" style="text-decoration:none;">
                    <button class="feedback-btn" style="background: #fff; color: #000; border: none; padding: 15px 35px; font-size: 1rem;">
                        <span class="material-icons" style="color: #000;">mail</span> Send Feedback
                    </button>
                </a>
            </div>
        </div>
    `);
};

window.openChangelogView = () => {
    openInfoView('Changelog', `
        <div style="max-width: 800px; margin: 0 auto; padding: 25px 20px 45px; line-height: 1.7; color: #ccc;">
            <div style="margin-bottom:30px;">
                <div style="display:inline-block; padding:6px 13px; border-radius:20px; background:rgba(52,152,219,0.14); color:#7fc4ff; font-size:0.85rem; font-weight:700;">LATEST RELEASE</div>
                <h2 style="color:#fff; font-size:2rem; margin:14px 0 4px;">GTV hub 3.0.0</h2>
                <p style="color:#888; margin:0;">November 20, 2026</p>
                <p style="margin-top:16px;">A major update focused on accounts, profiles, and keeping your GTV hub experience available across devices.</p>
            </div>

            <h4 style="color:#fff; margin-top:25px; margin-bottom:10px;">Added</h4>
            <ul style="list-style-type:disc; padding-left:22px;">
                <li>Optional account registration and sign-in with email confirmation.</li>
                <li>Password recovery and password update support.</li>
                <li>Cloud-backed profiles and synchronization of supported profile data across devices.</li>
                <li>Guest mode remains available for people who prefer to use the app without an account.</li>
                <li>A dedicated Help Center with guidance for accounts, profiles, playback, and troubleshooting.</li>
                <li>A dedicated Changelog page.</li>
            </ul>

            <h4 style="color:#fff; margin-top:25px; margin-bottom:10px;">Improved</h4>
            <ul style="list-style-type:disc; padding-left:22px;">
                <li>Profile management for both guest and signed-in users.</li>
                <li>Account and privacy explanations to distinguish local guest data from cloud-synchronized account data.</li>
                <li>About page credits now describe playback providers generally rather than naming a single video source.</li>
            </ul>

            <h4 style="color:#fff; margin-top:25px; margin-bottom:10px;">Fixed</h4>
            <ul style="list-style-type:disc; padding-left:22px;">
                <li>Profile deletion for signed-in users.</li>
            </ul>

            <p style="margin-top:30px; color:#888; font-size:0.9rem;">GTV hub is continuously evolving. This page will list notable changes as new versions are released.</p>
        </div>
    `);
};

window.openTermsView = () => {
    openInfoView('Terms of Use', `
        <div style="max-width: 800px; margin: 0 auto; padding: 24px 22px 40px; line-height: 1.75; color: #ccc; font-size:1.02rem;">
            <p>Last updated: ${new Date().toLocaleDateString()}</p>

            <h3 style="color:#fff; font-size:1.35rem; margin:20px 0 12px;">1. Using GTV hub</h3>
            <p>GTV hub is an interface for discovering movies and television shows. It provides catalogue information, browsing tools, profile features, watchlists, and links or embedded players supplied by independent third parties. By accessing or using the website, you agree to these Terms of Use. If you do not agree, please stop using the website.</p>

            <h4 style="color:#fff; font-size:1.18rem; margin-top:28px; margin-bottom:10px;">2. Accounts and Guest Access</h4>
            <p>You may use GTV hub as a guest or create an account. Guest information is stored in the browser on the device where it is created and may not be available on other devices. Registered accounts allow supported profile information to be associated with your account and synchronized through the services used by GTV hub.</p>
            <p>You are responsible for keeping your account credentials private and for activity carried out through your account. Provide accurate information when registering and contact us if you believe your account has been accessed without permission.</p>

            <h4 style="color:#fff; font-size:1.18rem; margin-top:28px; margin-bottom:10px;">3. Third-Party Content and Playback</h4>
            <p>GTV hub does not host or upload the video files played through external playback providers. Catalogue information and playback services are supplied by third parties that operate independently of GTV hub. Their availability, content, advertisements, privacy practices, and terms may change without notice.</p>
            <p>When you follow a link or use an embedded player, you may be interacting directly with a third-party service. You are responsible for reviewing and complying with that service's terms and applicable rules. GTV hub does not guarantee that a particular title or playback source will be available or work on your device.</p>

            <h4 style="color:#fff; font-size:1.18rem; margin-top:28px; margin-bottom:10px;">4. Acceptable Use</h4>
            <p>You agree not to misuse the website, attempt to disrupt its operation, interfere with its security, or use it in a way that violates applicable law or the rights of others. Do not attempt unauthorized access to accounts, systems, or data.</p>

            <h4 style="color:#fff; font-size:1.18rem; margin-top:28px; margin-bottom:10px;">5. Availability and Changes</h4>
            <p>Features, catalogue data, and third-party integrations may be modified, interrupted, or discontinued. We may update GTV hub and these Terms of Use from time to time. The latest version will be published on this page, with its update date shown above.</p>

            <h4 style="color:#fff; font-size:1.18rem; margin-top:28px; margin-bottom:10px;">6. Disclaimer</h4>
            <p>GTV hub is provided on an “as available” basis. To the extent permitted by applicable law, we make no guarantee that the website will always be uninterrupted, error-free, secure, or compatible with every device. We are not responsible for independent third-party websites, services, or content.</p>

            <h4 style="color:#fff; font-size:1.18rem; margin-top:28px; margin-bottom:10px;">7. Contact</h4>
            <p>For questions about these Terms of Use, contact <a href="mailto:exeinn.info@gmail.com?subject=GTV%20hub%20Terms%20of%20Use" style="color:var(--accent);">exeinn.info@gmail.com</a>.</p>
            <p style="margin-top:24px;">For information about account data, guest profiles, and third-party services, please also review the <span style="color:var(--accent); cursor:pointer; text-decoration:underline;" onclick="openPrivacyView()">Privacy Policy</span> and <span style="color:var(--accent); cursor:pointer; text-decoration:underline;" onclick="openLegalView()">Legal &amp; DMCA</span> pages.</p>
        </div>
    `);
};

window.openLegalView = () => {
    openInfoView('Legal & DMCA', `
        <div style="max-width: 800px; margin: 0 auto; padding: 24px 22px 40px; line-height: 1.75; color: #ccc; font-size:1.02rem;">
            <h3 style="color:#fff; font-size:1.35rem; margin:0 0 12px;">General Disclaimer</h3>
            <p>GTV hub is an interface for discovering movies and TV shows. It retrieves catalogue information, such as titles, descriptions, posters, ratings, and cast details, from third-party services including The Movie Database (TMDB). It may also provide access to video players or playback sources operated by independent third parties.</p>
            <p>GTV hub does not host or upload the movie or television video files played through those external providers. Playback is handled by the selected third-party service, and GTV hub does not control that provider's servers, content availability, advertisements, or policies. A title appearing in the catalogue does not mean that a working stream is available.</p>
            <p>GTV hub does not claim ownership of third-party metadata, artwork, trademarks, or video content. Such material remains the property of its respective owners and is subject to the terms and policies of the services that provide it.</p>

            <h4 style="color:#fff; font-size:1.18rem; margin-top:28px; margin-bottom:10px;">Third-Party Services and Links</h4>
            <p>When you search or browse, your browser may request information from external catalogue services. When you select a playback source, your browser may connect to an external video provider. Those services operate independently and may collect information, use cookies, display advertisements, or apply their own terms and privacy policies. Review the relevant provider's policies when using an external service.</p>
            <p>GTV hub is not responsible for the content, availability, accuracy, security, or practices of third-party websites and services. The presence of a link or embedded player does not mean that GTV hub owns, operates, or endorses that provider.</p>

            <h4 style="color:#fff; font-size:1.18rem; margin-top:28px; margin-bottom:10px;">Copyright and DMCA Notices</h4>
            <p>GTV hub respects intellectual property rights. If you believe that material displayed or linked through GTV hub infringes your copyright, you may contact us at <a href="mailto:exeinn.info@gmail.com?subject=Copyright%20or%20DMCA%20Notice" style="color:var(--accent);">exeinn.info@gmail.com</a> with the subject line <strong>Copyright or DMCA Notice</strong>.</p>
            <p>To help us review your notice, include a description of the copyrighted work, the specific GTV hub page or title involved, your contact information, and an explanation of why you believe the material infringes your rights. If you are acting on behalf of the rights holder, explain your authority to do so. Please provide enough detail for us to identify the relevant reference.</p>
            <p>Because GTV hub does not host the video files played by external providers, removing or changing a reference within GTV hub cannot remove the underlying file from the third-party service. For removal of a video itself, you should also contact the website or provider that hosts it. We can review the way a title is referenced or made accessible through GTV hub, but cannot control a third party's response.</p>

            <h4 style="color:#fff; font-size:1.18rem; margin-top:28px; margin-bottom:10px;">Account and User Data</h4>
            <p>GTV hub offers both guest access and optional registered accounts. Account authentication and cloud profile synchronization are handled through Supabase. Information about local guest storage, account data, and third-party services is described in the <span style="color:var(--accent); cursor:pointer; text-decoration:underline;" onclick="openPrivacyView()">Privacy Policy</span>.</p>
        </div>
    `);
};

window.openPrivacyView = () => {
    openInfoView('Privacy Policy', `
        <div style="max-width: 800px; margin: 0 auto; padding: 24px 22px 40px; line-height: 1.75; color: #ccc; font-size:1.02rem;">
            <p>Last updated: ${new Date().toLocaleDateString()}</p>

            <h3 style="color:#fff; font-size:1.35rem; margin:20px 0 12px;">1. Guest Access and Registered Accounts</h3>
            <p><strong>GTV hub supports registered user accounts as well as guest access.</strong> Creating an account is optional: you can browse as a guest, or register with an email address and password to use account-based profiles and cloud synchronization. An account is needed for the cross-device account experience; guest data does not automatically sync between devices.</p>
            <p>If you register, your email address is processed by Supabase for account authentication and related account functions, such as confirmation and password recovery. When you sign in, GTV hub uses your authenticated account to associate your profiles and supported profile data with you.</p>

            <h4 style="color:#fff; font-size:1.18rem; margin-top:28px; margin-bottom:10px;">2. Information and Profile Data</h4>
            <p>Depending on how you use GTV hub, information stored for a profile may include its name and appearance, watchlist, liked titles, hidden titles, viewing activity, and supported settings. Some information is kept in browser storage so the app can work on that device. For signed-in users, supported profile information is also stored in the cloud database and associated with the account so it can be synchronized when the user signs in elsewhere.</p>
            <p>Guest profile information is stored locally in the browser on the device where it is created. It is not automatically uploaded as a cloud profile unless you use an available account import or migration flow. If you sign out, locally stored guest information and cached information may remain in that browser.</p>

            <h4 style="color:#fff; font-size:1.18rem; margin-top:28px; margin-bottom:10px;">3. Local Storage and Cookies</h4>
            <p>GTV hub uses browser <strong>Local Storage</strong> to retain app preferences, session-related information, guest profiles, and locally cached profile data. For guest users, profile data is kept on the current device. For signed-in users, the browser may also keep a local copy or cache of information that is synchronized with the account database. It would therefore be incorrect to say that all GTV hub data stays only on your device.</p>
            <p>Clearing browser storage may remove guest profiles, preferences, and locally cached information. It does not necessarily delete data already stored in your signed-in account. Deleting an individual profile removes that profile and its associated profile data. Account-level actions are separate from clearing browser storage.</p>

            <h4 style="color:#fff; font-size:1.18rem; margin-top:28px; margin-bottom:10px;">4. Third-Party Services</h4>
            <p>GTV hub relies on third-party services to provide parts of the experience. These services process requests according to their own terms and privacy policies:</p>
            <ul style="list-style-type:disc; padding-left:22px; margin:8px 0 14px;">
                <li><strong>Supabase:</strong> Provides account authentication and cloud database services for signed-in profiles and supported profile data.</li>
                <li><strong>The Movie Database (TMDB):</strong> Provides catalogue information such as movie and TV metadata, artwork, and cast details. Requests to TMDB may include information needed to retrieve the requested catalogue data.</li>
                <li><strong>Third-party video providers:</strong> When you choose an external playback source, your browser connects to that provider. The provider may process connection information, use cookies, show advertisements, or apply other technologies under its own policies.</li>
            </ul>
            <p>GTV hub does not control the data practices of these independent services. Consult their privacy policies for details about how they handle information.</p>

            <h4 style="color:#fff; font-size:1.18rem; margin-top:28px; margin-bottom:10px;">5. Your Choices</h4>
            <p>You can choose whether to use GTV hub as a guest or create an account. You can manage profiles and remove individual profiles using the app's profile controls. You can also clear browser storage, bearing in mind that doing so may remove local guest data and cached information but does not necessarily delete cloud data associated with a signed-in account.</p>
            <p>Use care when accessing your account on a shared device, and sign out when you have finished. Do not share your password or private API keys with other people.</p>
        </div>
    `);
};

window.openSettingsView = () => {
    const region = localStorage.getItem('gtv_region') || 'US';
    const defaultTab = localStorage.getItem('gtv_default_tab') || 'movie';
    const reducedMotion = localStorage.getItem('gtv_reduced_motion') === 'true';
    const version = '3.0.0';

    const html = `
        <div style="max-width: 800px; margin: 0 auto; padding: 20px;">

            <div class="settings-section">
                <h3 class="settings-header">General</h3>
                
                <div class="setting-item mobile-stack">
                    <div class="setting-label">
                        <span>Default Start Page</span>
                        <span class="setting-desc">Choose what to show when you open the app</span>
                    </div>
                    <select onchange="saveSetting('gtv_default_tab', this.value)" class="setting-control">
                        <option value="movie" ${defaultTab === 'movie' ? 'selected' : ''}>Movies</option>
                        <option value="tv" ${defaultTab === 'tv' ? 'selected' : ''}>TV Shows</option>
                    </select>
                </div>

                <div class="setting-item mobile-stack">
                    <div class="setting-label">
                        <span>Default Server</span>
                        <span class="setting-desc">Choose your preferred video source</span>
                    </div>
                    <select onchange="changeServerSetting(this.value)" class="setting-control">
                        ${playerSources.map(s => `<option value="${s}" ${s === playerSources[0] ? 'selected' : ''}>${new URL(s).hostname}</option>`).join('')}
                    </select>
                </div>

                <div class="setting-item mobile-stack">
                    <div class="setting-label">
                        <span>TMDB API Key</span>
                        <span class="setting-desc" style="color:${useDefaultKey ? '#aaa' : '#46d369'}">
                            ${useDefaultKey ? 'Using Default (Shared)' : 'Using Custom Key'}
                        </span>
                    </div>
                    <div style="display:flex; flex-direction:column; align-items:flex-end; gap:10px;">
                        <div style="display:flex; align-items:center; gap:10px;">
                            <span style="font-size:0.8rem; color:#ccc;">Use Default</span>
                            <label class="switch">
                                <input type="checkbox" ${useDefaultKey ? 'checked' : ''} onchange="toggleDefaultKey(this.checked)">
                                <span class="slider round"></span>
                            </label>
                        </div>
                        <button onclick="openKeyManager()" class="more-info-btn" style="font-size:0.8rem; padding:8px 15px;">Manage Keys</button>
                    </div>
                </div>

                <div class="setting-item mobile-stack">
                    <div class="setting-label">
                        <span>Content Region</span>
                        <span class="setting-desc">Prioritize content release dates for this country</span>
                    </div>
                    <select onchange="saveSetting('gtv_region', this.value)" class="setting-control">
                        <option value="INTL" ${region === 'INTL' ? 'selected' : ''}>Global (International)</option>
                        <option value="US" ${region === 'US' ? 'selected' : ''}>United States</option>
                        <option value="GB" ${region === 'GB' ? 'selected' : ''}>United Kingdom</option>
                        <option value="CA" ${region === 'CA' ? 'selected' : ''}>Canada</option>
                        <option value="AU" ${region === 'AU' ? 'selected' : ''}>Australia</option>
                        <option value="FR" ${region === 'FR' ? 'selected' : ''}>France</option>
                        <option value="DE" ${region === 'DE' ? 'selected' : ''}>Germany</option>
                        <option value="IT" ${region === 'IT' ? 'selected' : ''}>Italy</option>
                        <option value="ES" ${region === 'ES' ? 'selected' : ''}>Spain</option>
                        <option value="JP" ${region === 'JP' ? 'selected' : ''}>Japan</option>
                        <option value="KR" ${region === 'KR' ? 'selected' : ''}>South Korea</option>
                        <option value="IN" ${region === 'IN' ? 'selected' : ''}>India</option>
                        <option value="BR" ${region === 'BR' ? 'selected' : ''}>Brazil</option>
                        <option value="MX" ${region === 'MX' ? 'selected' : ''}>Mexico</option>
                        <option value="RU" ${region === 'RU' ? 'selected' : ''}>Russia</option>
                        <option value="CN" ${region === 'CN' ? 'selected' : ''}>China</option>
                        <option value="TR" ${region === 'TR' ? 'selected' : ''}>Turkey</option>
                        <option value="NL" ${region === 'NL' ? 'selected' : ''}>Netherlands</option>
                        <option value="SE" ${region === 'SE' ? 'selected' : ''}>Sweden</option>
                        <option value="ID" ${region === 'ID' ? 'selected' : ''}>Indonesia</option>
                        <option value="TH" ${region === 'TH' ? 'selected' : ''}>Thailand</option>
                    </select>
                </div>

                <div class="setting-item">
                    <div class="setting-label">
                        <span>Reduced Motion</span>
                        <span class="setting-desc">Disable animations for better performance</span>
                    </div>
                    <label class="switch">
                        <input type="checkbox" onchange="saveSetting('gtv_reduced_motion', this.checked)" ${reducedMotion ? 'checked' : ''}>
                        <span class="slider round"></span>
                    </label>
                </div>
            </div>

            <div class="settings-section">
                <h3 class="settings-header">Data</h3>
                
                <div class="setting-item mobile-stack">
                    <div class="setting-label">
                        <span>Clear Watchlist</span>
                        <span class="setting-desc">Remove all items from your watchlist</span>
                    </div>
                    <button onclick="clearWatchlistAction()" class="more-info-btn" style="font-size:0.8rem;">Clear</button>
                </div>

                <div class="setting-item mobile-stack">
                    <div class="setting-label">
                        <span>Reset Hidden Content</span>
                        <span class="setting-desc">Unhide all titles you've marked as broken</span>
                    </div>
                    <button onclick="resetHiddenAction()" class="more-info-btn" style="font-size:0.8rem;">Reset</button>
                </div>

                <div class="setting-item mobile-stack">
                    <div class="setting-label">
                        <span>Factory Reset</span>
                        <span class="setting-desc">Clear all data and reset app to default</span>
                    </div>
                    <button onclick="factoryResetAction()" class="play-btn" style="background:#e74c3c; font-size:0.8rem; border:none;">Reset App</button>
                </div>
            </div>

            ${cloudProfileMode && authUser ? `
            <div class="settings-section">
                <h3 class="settings-header">Account</h3>
                <div class="setting-item mobile-stack">
                    <div class="setting-label">
                        <span>Delete Account</span>
                        <span class="setting-desc">Permanently erase your GTV hub account and all associated cloud data, including your profiles, community profile, posts, and follows.</span>
                    </div>
                    <button onclick="confirmDeleteAccount()" class="play-btn" style="background:#e74c3c; font-size:0.8rem; border:none;">Delete Account</button>
                </div>
            </div>
            ` : ''}
            <div class="settings-section">
                <h3 class="settings-header">Info</h3>
                
                <div class="setting-item">
                    <div class="setting-label">
                        <span>App Version</span>
                    </div>
                    <span style="color:#888; font-family:monospace;">v${version}</span>
                </div>

                <div class="setting-item mobile-stack">
                    <div class="setting-label">
                        <span>Guest Session ID</span>
                        <span class="setting-desc">Used for rating content on TMDB</span>
                    </div>
                    <span style="color:#888; font-family:monospace; font-size:0.8rem; word-break: break-all;">${guestSessionId || 'Not Active'}</span>
                </div>
            </div>
        </div>
        <style>
            .settings-section { margin-bottom: 40px; background: rgba(255,255,255,0.03); border-radius: 16px; padding: 20px; border: 1px solid rgba(255,255,255,0.05); }
            .settings-header { color: var(--accent); margin-bottom: 20px; font-size: 1rem; text-transform: uppercase; letter-spacing: 1px; }
            .setting-item { display: flex; justify-content: space-between; align-items: center; padding: 15px 0; border-bottom: 1px solid rgba(255,255,255,0.05); gap: 15px; }
            .setting-item:last-child { border-bottom: none; }
            .setting-label { display: flex; flex-direction: column; gap: 5px; flex: 1; }
            .setting-label span:first-child { color: #fff; font-weight: 500; }
            .setting-desc { color: #888; font-size: 0.8rem; }
            .setting-control { 
                background: #1f1f1f; 
                color: #fff; 
                border: 1px solid rgba(255,255,255,0.1); 
                padding: 10px 35px 10px 20px; 
                border-radius: 30px; 
                outline: none; 
                font-family: inherit; 
                font-size: 0.9rem;
                cursor: pointer;
                appearance: none;
                -webkit-appearance: none;
                background-image: url("data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22292.4%22%20height%3D%22292.4%22%3E%3Cpath%20fill%3D%22%23FFFFFF%22%20d%3D%22M287%2069.4a17.6%2017.6%200%200%200-13-5.4H18.4c-5%200-9.3%201.8-12.9%205.4A17.6%2017.6%200%200%200%200%2082.2c0%205%201.8%209.3%205.4%2012.9l128%20127.9c3.6%203.6%207.8%205.4%2012.8%205.4s9.2-1.8%2012.8-5.4L287%2095c3.5-3.5%205.4-7.8%205.4-12.8%200-5-1.9-9.2-5.5-12.8z%22%2F%3E%3C%2Fsvg%3E");
                background-repeat: no-repeat;
                background-position: right 15px center;
                background-size: 10px;
                box-shadow: 0 4px 15px rgba(0,0,0,0.2);
                transition: all 0.2s;
            }
            .setting-control:hover {
                background-color: #2a2a2a;
                border-color: var(--accent);
                transform: translateY(-2px);
                box-shadow: 0 6px 20px rgba(0,0,0,0.3);
            }
            
            /* Toggle Switch */
            .switch { position: relative; display: inline-block; width: 46px; height: 24px; }
            .switch input { opacity: 0; width: 0; height: 0; }
            .slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #333; transition: .4s; border-radius: 34px; }
            .slider:before { position: absolute; content: ""; height: 18px; width: 18px; left: 3px; bottom: 3px; background-color: white; transition: .4s; border-radius: 50%; }
            input:checked + .slider { background-color: var(--accent); }
            input:focus + .slider { box-shadow: 0 0 1px var(--accent); }
            input:checked + .slider:before { transform: translateX(22px); }

            @media (max-width: 600px) {
                .setting-item.mobile-stack { flex-direction: column; align-items: stretch; gap: 10px; }
                .setting-control, .setting-item.mobile-stack button { width: 100%; justify-content: center; }
                .settings-section { padding: 15px; }
            }
        </style>
    `;
    
    openInfoView('Settings', html);
};

window.confirmDeleteAccount = () => {
    if (!authUser || !authUser.email || !cloudProfileMode || !supabaseClient) return;

    showModal(
        'Confirm your password',
        '<div style="font-size:0.92rem; line-height:1.65; color:#ccc;">' +
            '<p>For your security, enter your account password to continue deleting your GTV hub account.</p>' +
            '<div style="position:relative; margin-top:16px;">' +
                '<input id="delete-account-password" type="password" autocomplete="new-password" autocapitalize="off" spellcheck="false" readonly onfocus="this.removeAttribute(\'readonly\')" data-1p-ignore="true" data-lpignore="true" data-bwignore="true" data-form-type="other" placeholder="Account password" ' +
                    'style="box-sizing:border-box; width:100%; padding:13px 48px 13px 14px; border-radius:10px; border:1px solid rgba(255,255,255,0.16); background:rgba(255,255,255,0.06); color:#fff; font:inherit; outline:none;">' +
                '<button type="button" onclick="toggleDeletePasswordVisibility()" aria-label="Show password" ' +
                    'style="position:absolute; right:8px; top:50%; transform:translateY(-50%); background:transparent; border:0; color:#aaa; cursor:pointer; padding:6px;">' +
                    '<span class="material-icons" id="delete-account-password-toggle-icon">visibility</span>' +
                '</button>' +
            '</div>' +
            '<p id="delete-account-password-error" role="alert" style="display:none; color:#ff7777; margin-bottom:0;"></p>' +
        '</div>',
        [
            { text: 'Cancel', secondary: true },
            { text: 'Continue', className: 'play-btn', action: () => { verifyDeleteAccountPassword(); return false; } }
        ]
    );

    setTimeout(() => {
        const input = document.getElementById('delete-account-password');
        if (input) input.focus();
    }, 0);
};

window.toggleDeletePasswordVisibility = () => {
    const input = document.getElementById('delete-account-password');
    const icon = document.getElementById('delete-account-password-toggle-icon');
    if (!input || !icon) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    icon.textContent = show ? 'visibility_off' : 'visibility';
};

window.verifyDeleteAccountPassword = async () => {
    const input = document.getElementById('delete-account-password');
    const errorElement = document.getElementById('delete-account-password-error');
    const password = input ? input.value : '';

    if (!password) {
        if (errorElement) {
            errorElement.textContent = 'Enter your password to continue.';
            errorElement.style.display = 'block';
        }
        return;
    }

    const buttons = document.querySelectorAll('#confirm-modal-overlay .confirmation-btns button');
    buttons.forEach(button => { button.disabled = true; });
    if (errorElement) errorElement.style.display = 'none';

    try {
        const { data, error } = await supabaseClient.auth.signInWithPassword({
            email: authUser.email,
            password
        });

        if (error) throw error;
        if (!data.user || data.user.id !== authUser.id) {
            throw new Error('The password could not be verified for this account.');
        }

        const overlay = document.getElementById('confirm-modal-overlay');
        setModalActive(overlay, false);
        showDeleteAccountConfirmation();
    } catch (error) {
        if (errorElement) {
            errorElement.textContent = error.message === 'Invalid login credentials'
                ? 'That password is incorrect. Please try again.'
                : (error.message || 'Could not verify your password. Please try again.');
            errorElement.style.display = 'block';
        }
        if (input) {
            input.value = '';
            input.focus();
        }
        buttons.forEach(button => { button.disabled = false; });
    }
};

window.showDeleteAccountConfirmation = () => {
    if (!authUser || !cloudProfileMode || !supabaseClient) return;
    showModal(
        'Delete your account?',
        '<div style="font-size:0.92rem; line-height:1.65; color:#ccc;">' +
            '<p>This will permanently delete your GTV hub account from our server.</p>' +
            '<p><strong style="color:#fff;">Everything associated with your account will be erased</strong>, including your saved viewing profiles and their data, your community profile, posts, and follow relationships.</p>' +
            '<p>You will be signed out, and this action cannot be undone. You will not be able to recover your account or its data.</p>' +
            '<p style="color:#ff7777; margin-bottom:0;">This does not clear guest data or browser settings stored locally on this device.</p>' +
        '</div>',
        [
            { text: 'Cancel', secondary: true },
            { text: 'Delete', className: 'play-btn remove-confirm-btn', action: () => { deleteCurrentAccount(); } }
        ]
    );
};
window.deleteCurrentAccount = async () => {
    if (!authUser || !cloudProfileMode || !supabaseClient) return;
    showToast('Deleting your account…');
    try {
        const { error } = await supabaseClient.functions.invoke('delete-account', { body: {} });
        if (error) throw error;

        // Remove locally cached copies of this account's cloud profile data.
        (profiles || []).forEach(profile => {
            if (!profile || !profile.id) return;
            localStorage.removeItem('gtv_watchlist_' + profile.id);
            localStorage.removeItem('gtv_liked_content_' + profile.id);
            localStorage.removeItem('gtv_excluded_content_' + profile.id);
            localStorage.removeItem('gtv_watch_history_' + profile.id);
        });

        await supabaseClient.auth.signOut({ scope: 'local' });
        authUser = null;
        cloudProfileMode = false;
        guestMode = true;
        currentProfile = null;
        profiles = safeJsonParse('gtv_profiles', []);
        watchlist = [];
        likedContent = [];
        excludedContent = [];
        profileSettings = {};
        cloudDataLoading = false;
        authDialogMode = false;
        authReturnToApp = false;
        setElementVisible(document.getElementById('auth-view'), false);
        document.getElementById('auth-view').classList.remove('auth-dialog');
        document.body.classList.remove('no-scroll');
        const nav = document.querySelector('.top-nav');
        if (nav) nav.style.display = 'none';
        if (profiles.length) renderProfileScreen();
        else initApp();
        showToast('Your account and cloud data have been deleted.');
    } catch (error) {
        console.error('Account deletion failed:', error);
        showToast(error.message || 'Could not delete your account. Please try again.');
    }
};

window.saveSetting = (key, value) => {
    localStorage.setItem(key, value);

    const cloudSettingKeys = {
        gtv_default_tab: 'default_tab',
        gtv_reduced_motion: 'reduced_motion',
        gtv_active_source: 'active_source',
        gtv_region: 'region'
    };
    const cloudSetting = cloudSettingKeys[key];
    if (cloudSetting && cloudProfileMode && currentProfile) {
        profileSettings[cloudSetting] = value;
        persistCurrentProfileData();
    }
    
    if (key === 'gtv_reduced_motion') {
        if (value) document.body.classList.add('reduced-motion');
        else document.body.classList.remove('reduced-motion');
    }
};

window.changeServerSetting = (value) => {
    saveSetting('gtv_active_source', value);
    showModal('Server Changed', 
        'Please refresh the page to apply changes.<br><br><small style="color:#aaa">If the source is not working, just come back and change to another one.</small>', 
        [
            { text: 'Later', secondary: true },
            { text: 'Refresh Now', className: 'play-btn', action: () => location.reload() }
        ]
    );
};

window.toggleDefaultKey = (checked) => {
    localStorage.setItem('gtv_use_default_key', checked);
    showModal('Settings Changed', 'Please refresh the page to apply the API key change.', [
        { text: 'Refresh Now', className: 'play-btn', action: () => location.reload() }
    ]);
};

window.openApiKeyHelp = () => {
    showModal('About API Keys', `
        <div style="font-size:0.9rem; line-height:1.6; color:#ccc;">
            <p style="margin-bottom:15px;"><strong style="color:#fff;">What is this?</strong><br>
            This site uses The Movie Database (TMDB) to fetch posters, descriptions, and cast info.</p>
            
            <p style="margin-bottom:15px;"><strong style="color:#fff;">Why change it?</strong><br>
            The default key is shared by everyone. If it hits usage limits, data might stop loading. Adding your own free key ensures the site always works for you.</p>
            
            <p><strong style="color:#fff;">How to get one?</strong><br>
            1. Sign up at <a href="https://www.themoviedb.org/" target="_blank" style="color:var(--accent); text-decoration:none;">themoviedb.org</a><br>
            2. Go to Settings > API<br>
            3. Copy the <b>API Key (v3 auth)</b> and paste it here.</p>
        </div>
    `, [{ text: 'Got it', secondary: true, action: () => { openKeyManager(); return false; } }]);
};

window.openKeyManager = () => {
    const keysList = savedKeys.map(k => {
        const isActive = k === activeCustomKey;
        const isUsed = !useDefaultKey && isActive;
        return `
            <div style="display:flex; align-items:center; justify-content:space-between; background:rgba(255,255,255,0.05); padding:12px; border-radius:8px; margin-bottom:8px; border:1px solid ${isUsed ? 'var(--accent)' : 'transparent'};">
                <div style="display:flex; flex-direction:column; overflow:hidden; margin-right:10px; flex:1;">
                    <span style="font-family:monospace; font-size:0.85rem; color:#fff; word-break:break-all; line-height:1.2;">${k}</span>
                    ${isUsed ? '<span style="font-size:0.7rem; color:var(--accent); margin-top:4px; font-weight:bold;">Active</span>' : ''}
                </div>
                <div style="display:flex; gap:8px; flex-shrink:0; align-items:center;">
                    ${!isUsed ? `<button onclick="activateKey('${k}')" class="more-info-btn" style="padding:6px 12px; font-size:0.75rem; min-width:auto;">Use</button>` : ''}
                    <button onclick="deleteKey('${k}')" class="more-info-btn" style="padding:6px; color:#e74c3c; border-color:rgba(231,76,60,0.3); min-width:auto; display:flex; align-items:center; justify-content:center;"><span class="material-icons" style="font-size:18px;">delete</span></button>
                </div>
            </div>
        `;
    }).join('');

    const html = `
        <div style="margin-bottom:20px;">
            <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;">
                <h4 style="color:#fff; font-size:0.9rem; text-transform:uppercase; letter-spacing:1px; margin:0;">Add New Key</h4>
                <button onclick="openApiKeyHelp()" style="background:transparent; border:none; color:var(--accent); cursor:pointer; display:flex; align-items:center; padding:5px;" title="What is this?"><span class="material-icons" style="font-size:18px;">help_outline</span></button>
            </div>
            <div style="display:flex; gap:10px; flex-wrap:wrap;">
                <input type="text" id="new-key-input" placeholder="Enter TMDB API Key" style="flex:1; min-width:200px; background:#111; border:1px solid #333; color:#fff; padding:12px; border-radius:8px; outline:none; font-family:monospace; font-size:0.9rem;">
                <button onclick="saveNewKey()" style="background:var(--accent); color:#fff; border:none; padding:0 20px; border-radius:8px; font-weight:bold; cursor:pointer; display:flex; align-items:center; gap:5px; transition:transform 0.2s;" onmouseover="this.style.transform='scale(1.05)'" onmouseout="this.style.transform='scale(1)'"><span class="material-icons">add</span> Add</button>
            </div>
        </div>
        
        <div style="border-top:1px solid rgba(255,255,255,0.1); padding-top:20px; display:flex; flex-direction:column; min-height:0;">
            <h4 style="color:#fff; margin-bottom:10px; font-size:0.9rem; text-transform:uppercase; letter-spacing:1px;">Saved Keys</h4>
            <div style="max-height:300px; overflow-y:auto; padding-right:5px;">
                ${keysList || '<div style="color:#888; font-style:italic; padding:15px; text-align:center; background:rgba(255,255,255,0.03); border-radius:8px;">No custom keys saved.</div>'}
            </div>
        </div>
    `;
    
    showModal('Manage API Keys', html, [{ text: 'Close', secondary: true }]);
};

window.saveNewKey = () => {
    const input = document.getElementById('new-key-input');
    const key = input.value.trim();
    if (key && !savedKeys.includes(key)) {
        savedKeys.push(key);
        localStorage.setItem('gtv_saved_keys', JSON.stringify(savedKeys));
        activateKey(key); // Auto activate new key
    } else if (savedKeys.includes(key)) {
        alert('Key already exists.');
    }
};

window.activateKey = (key) => {
    localStorage.setItem('gtv_active_custom_key', key);
    toggleDefaultKey(false); // Will trigger reload modal
};

window.deleteKey = (key) => {
    savedKeys = savedKeys.filter(k => k !== key);
    localStorage.setItem('gtv_saved_keys', JSON.stringify(savedKeys));
    openKeyManager(); // Refresh modal
};

window.clearWatchlistAction = () => {
    showModal('Clear Watchlist', 'Are you sure you want to remove all items from your watchlist?', [
        { text: 'Cancel', secondary: true },
        { text: 'Clear All', action: () => {
            watchlist = [];
            if(currentProfile) localStorage.setItem(`gtv_watchlist_${currentProfile.id}`, '[]');
            persistCurrentProfileData();
            showToast('Watchlist cleared');
        }}
    ]);
};

window.resetHiddenAction = () => {
    showModal('Reset Hidden Content', 'Are you sure you want to unhide all content?', [
        { text: 'Cancel', secondary: true },
        { text: 'Reset', action: () => {
            excludedContent = [];
            if(currentProfile) localStorage.setItem(`gtv_excluded_content_${currentProfile.id}`, '[]');
            persistCurrentProfileData();
            showToast('Hidden content reset');
        }}
    ]);
};

window.factoryResetAction = () => {
    showModal('Factory Reset', 'This will delete all your data (watchlist, settings, history). This action cannot be undone.', [
        { text: 'Cancel', secondary: true },
        { text: 'Reset App', action: () => {
            localStorage.clear();
            location.reload();
        }}
    ]);
};

window.showModal = (title, content, buttons) => {
    const overlay = document.getElementById('confirm-modal-overlay');
    const modal = overlay.querySelector('.confirmation-modal');
    
    modal.querySelector('h3').innerText = title;
    modal.querySelector('.modal-body').innerHTML = content;
    
    const btnContainer = modal.querySelector('.confirmation-btns');
    btnContainer.innerHTML = '';
    
    buttons.forEach(b => {
        const btn = document.createElement('button');
        if (b.className) {
            btn.className = b.className;
        } else {
            btn.className = b.secondary ? 'more-info-btn' : 'play-btn remove-confirm-btn';
        }
        btn.innerText = b.text;
        btn.onclick = () => {
            let shouldClose = true;
            try { 
                if (b.action && b.action() === false) shouldClose = false;
            } catch(e) { console.error(e); }
            
            if (shouldClose) setModalActive(overlay, false);
        };
        btnContainer.appendChild(btn);
    });
    
    setModalActive(overlay, true);
};

window.randomPick = async () => {
    const dd = document.getElementById('nav-dropdown');
    if(dd) dd.classList.remove('active');

    // Simple loading indicator
    const loadingToast = document.createElement('div');
    loadingToast.style.position = 'fixed';
    loadingToast.style.bottom = '30px';
    loadingToast.style.left = '50%';
    loadingToast.style.transform = 'translateX(-50%)';
    loadingToast.style.background = 'rgba(52, 152, 219, 0.9)';
    loadingToast.style.color = '#fff';
    loadingToast.style.padding = '12px 24px';
    loadingToast.style.borderRadius = '30px';
    loadingToast.style.zIndex = '10000';
    loadingToast.style.fontWeight = 'bold';
    loadingToast.style.boxShadow = '0 10px 30px rgba(0,0,0,0.5)';
    loadingToast.innerHTML = '<span class="material-icons" style="vertical-align:middle; margin-right:8px; animation:spin 1s infinite linear;">autorenew</span> Picking for you...';
    document.body.appendChild(loadingToast);

    try {
        const type = Math.random() > 0.5 ? 'movie' : 'tv';
        const page = Math.floor(Math.random() * 15) + 1; // Top 15 pages
        const res = await fetch(`${TMDB_BASE}/${type}/popular?api_key=${TMDB_KEY}&page=${page}`);
        const data = await res.json();
        const validItems = data.results.filter(i => !excludedContent.includes(i.id.toString()) && i.poster_path);
        
        if (validItems.length > 0) {
            const item = validItems[Math.floor(Math.random() * validItems.length)];
            openDetails(item.id, type);
        }
    } catch(e) {
        console.error(e);
    } finally {
        loadingToast.remove();
    }
};

function getRatingColor(rating) {
    if (rating >= 6.0) return '#46d369'; // Green
    if (rating >= 5) return '#f1c40f'; // Yellow
    return '#e74c3c'; // Red
}

function getCertification(data, type) {
    let cert = '';
    if (type === 'movie' && data.release_dates) {
        const release = data.release_dates.results.find(r => r.iso_3166_1 === 'US') || data.release_dates.results[0];
        if (release) {
            const date = release.release_dates.find(d => d.certification) || release.release_dates[0];
            if (date) cert = date.certification;
        }
    } else if (type === 'tv' && data.content_ratings) {
        const rating = data.content_ratings.results.find(r => r.iso_3166_1 === 'US') || data.content_ratings.results[0];
        if (rating) cert = rating.rating;
    }
    return cert;
}

function getSkeletonHtml(type) {
    if (type === 'hero') {
        return `<div class="skeleton-hero shimmer"></div>`;
    }
    if (type === 'dashboard') {
        return Array(3).fill(0).map(() => `
            <div class="skeleton-row">
                <div class="skeleton-row-title shimmer"></div>
                <div class="skeleton-row-posters">
                    ${Array(6).fill(0).map(() => `<div class="skeleton-poster shimmer"></div>`).join('')}
                </div>
            </div>
        `).join('');
    }
    if (type === 'grid') {
        return `<div class="skeleton-grid">${Array(12).fill(0).map(() => `<div class="skeleton-poster shimmer"></div>`).join('')}</div>`;
    }
    if (type === 'episodes') {
        return `<div class="episodes-list">${Array(5).fill(0).map(() => `
            <div class="episode-card" style="pointer-events:none;">
                <div class="episode-img-container shimmer"></div>
                <div class="episode-info" style="width:100%;">
                    <div class="shimmer" style="height:20px; width:60%; margin-bottom:10px; border-radius:4px;"></div>
                    <div class="shimmer" style="height:14px; width:90%; border-radius:4px;"></div>
                </div>
            </div>
        `).join('')}</div>`;
    }
    if (type === 'genres') {
         return `<div style="padding: 0 4%;">
            <div class="shimmer" style="width:150px; height:24px; margin-bottom:15px; border-radius:4px;"></div>
            <div class="genre-grid">
                ${Array(8).fill(0).map(() => `<div class="genre-card shimmer" style="height:60px; border:none;"></div>`).join('')}
            </div>
         </div>`;
    }
    return '';
}

// Navigation History Logic
function captureAndPushState() {
    if (skipNextNavigationCapture) {
        skipNextNavigationCapture = false;
        return;
    }

    let state = null;
    // Save current view state to stack before navigating away.
    // The search overlay sits above the current view, so preserve both layers.
    const profileView = document.getElementById('profile-view');
    if (profileView && profileView.style.display !== 'none') state = { view: 'profile' };

    const searchModal = document.getElementById('search-modal-overlay');
    if (!state && searchModal?.classList.contains('active')) {
        const searchInput = document.getElementById('modal-search-input');
        const searchResults = document.getElementById('modal-search-results');
        const baseView = document.getElementById('person-profile-view')?.style.display === 'block' ? 'person' :
            document.getElementById('people-view')?.style.display === 'block' ? 'people' :
            detailsView.style.display === 'block' ? 'details' :
            categoryView.style.display === 'block' ? 'category' : 'dashboard';
        state = {
            view: 'search',
            query: searchInput?.value || '',
            html: searchResults?.innerHTML || '',
            page: currentSearchPage,
            currentQuery: currentSearchQuery,
            resultsScroll: searchResults?.scrollTop || 0,
            baseView,
            baseScroll: window.scrollY,
            tab: currentTab,
            navigationSection: activeNavigationSection
        };
    } else if (!state && document.getElementById('community-profile-view')?.style.display === 'block') {
        state = { view: 'community-profile', username: communityCurrentUsername, scroll: window.scrollY };
    } else if (!state && document.getElementById('community-view')?.style.display === 'block') {
        state = { view: 'community-directory', query: document.getElementById('community-search-input')?.value || '', scroll: window.scrollY };
    } else if (!state && document.getElementById('person-profile-view')?.style.display === 'block') {
        state = { view: 'person', id: peopleCurrentProfileId, scroll: window.scrollY };
    } else if (!state && document.getElementById('people-view')?.style.display === 'block') {
        state = { view: 'people', scroll: window.scrollY, query: peopleCurrentQuery };
    } else if (!state && detailsView.style.display === 'block') {
        if (currentDetailsData) {
            state = {
                view: 'details',
                id: currentDetailsData.id,
                type: currentDetailsData.media_type,
                scroll: window.scrollY
            };
        }
    } else if (!state && categoryView.style.display === 'block') {
        state = {
            view: 'category',
            title: document.getElementById('category-title').textContent,
            html: categoryList.innerHTML,
            apiUrl: currentCategoryApiUrl,
            page: currentCategoryPage,
            items: [...allLoadedCategoryItems],
            scroll: window.scrollY
        };
    } else if (!state && dashboard.style.display === 'block') {
        state = { view: 'dashboard', scroll: window.scrollY, tab: currentTab, navigationSection: activeNavigationSection };
    }
    
    if (state) {
        navigationStack.push(state);
        appHistoryIndex += 1;
        history.pushState({ gtvhubNavigation: true, gtvhubIndex: appHistoryIndex }, '', window.location.href);
    }
}

window.handleBack = (fromPopState = false) => {
    if (!fromPopState && navigationStack.length > 0 && history.state?.gtvhubNavigation) {
        history.back();
        return;
    }

    // Ensure player is closed when navigating back
    if (playerContainer.style.display === 'flex') {
        closePlayer();
    }

    // This function is now primarily called by the 'popstate' event listener.
    if (navigationStack.length === 0) {
        // Default to dashboard
        setElementVisible(dashboard, true, 'block');
        setElementVisible(detailsView, false);
        setElementVisible(categoryView, false);
        setElementVisible(document.getElementById('people-view'), false);
        setElementVisible(document.getElementById('person-profile-view'), false);
        setElementVisible(document.getElementById('profile-view'), false);
        const nav = document.querySelector('.top-nav');
        if (nav) nav.style.display = 'flex';
        document.body.classList.remove('no-scroll');
        document.getElementById('hero-section').style.display = 'flex';
        resetUrl();
        return;
    }

    const state = navigationStack.pop();
    
    if (state.view === 'profile') {
        setElementVisible(document.getElementById('auth-view'), false);
        setElementVisible(document.getElementById('profile-view'), true, 'flex');
        setElementVisible(dashboard, false);
        setElementVisible(detailsView, false);
        setElementVisible(categoryView, false);
        setElementVisible(document.getElementById('people-view'), false);
        setElementVisible(document.getElementById('person-profile-view'), false);
        setElementVisible(playerContainer, false);
        const nav = document.querySelector('.top-nav');
        if (nav) nav.style.display = 'none';
        document.body.classList.add('no-scroll');
        renderProfileScreen();
    } else if (state.view === 'search') {
        currentTab = state.tab || currentTab;
        activeNavigationSection = state.navigationSection || currentTab;
        setupNewNavigation();
        setElementVisible(dashboard, state.baseView === 'dashboard', 'block');
        setElementVisible(detailsView, state.baseView === 'details', 'block');
        setElementVisible(categoryView, state.baseView === 'category', 'block');
        setElementVisible(document.getElementById('people-view'), state.baseView === 'people', 'block');
        setElementVisible(document.getElementById('person-profile-view'), state.baseView === 'person', 'block');

        currentSearchQuery = state.currentQuery || state.query || '';
        currentSearchPage = state.page || 1;
        const searchInput = document.getElementById('modal-search-input');
        const searchResults = document.getElementById('modal-search-results');
        searchInput.value = state.query || '';
        searchResults.innerHTML = state.html || '';
        searchResults.scrollTop = state.resultsScroll || 0;

        const modal = document.getElementById('search-modal-overlay');
        modal.classList.add('active');
        modal.setAttribute('aria-hidden', 'false');
        modal.inert = false;
        window.scrollTo(0, state.baseScroll || 0);
        setTimeout(() => searchInput.focus(), 50);
    } else if (state.view === 'dashboard') {
        currentTab = state.tab || currentTab;
        activeNavigationSection = state.navigationSection || currentTab;
        setupNewNavigation();
        setElementVisible(dashboard, true, 'block');
        setElementVisible(detailsView, false);
        setElementVisible(categoryView, false);
        setElementVisible(document.getElementById('people-view'), false);
        setElementVisible(document.getElementById('person-profile-view'), false);
        setElementVisible(document.getElementById('profile-view'), false);
        setElementVisible(playerContainer, false);
        const nav = document.querySelector('.top-nav');
        if (nav) nav.style.display = 'flex';
        document.body.classList.remove('no-scroll');
        document.getElementById('hero-section').style.display = 'flex';
        resetUrl();
        window.scrollTo(0, state.scroll);
    } else if (state.view === 'category') {
        activeNavigationSection = currentTab;
        setupNewNavigation();
        setElementVisible(dashboard, false);
        setElementVisible(detailsView, false);
        setElementVisible(categoryView, true, 'block');
        setElementVisible(document.getElementById('people-view'), false);
        setElementVisible(document.getElementById('person-profile-view'), false);
        
        document.getElementById('category-title').textContent = state.title;
        
        if (state.title === 'My Watchlist') {
            renderWatchlistContent();
        } else {
            categoryList.innerHTML = state.html;
        }
        
        currentCategoryApiUrl = state.apiUrl || '';
        currentCategoryPage = state.page || 1;
        allLoadedCategoryItems = state.items || [];

        // The Load More control belongs only to paginated result lists.
        // It is appended to categoryView (outside categoryList), so restoring
        // the Categories directory must explicitly remove the previous list's button.
        if (!currentCategoryApiUrl || state.title === 'Browse Categories') {
            const loadMoreContainer = document.getElementById('cat-load-more-container');
            if (loadMoreContainer) loadMoreContainer.remove();
        }
        
        window.scrollTo(0, state.scroll);
        resetUrl(); // Categories don't have deep links yet
    } else if (state.view === 'community-directory') {
        openCommunityDirectory(true);
        const communitySearch = document.getElementById('community-search-input');
        if (communitySearch && state.query) {
            communitySearch.value = state.query;
            loadCommunityDirectory(state.query);
        }
        window.scrollTo(0, state.scroll || 0);
    } else if (state.view === 'community-profile') {
        openCommunityProfile(state.username, true);
        window.scrollTo(0, state.scroll || 0);
    } else if (state.view === 'people') {
        openPeople(true);
        if (state.query) { document.getElementById('people-search-input').value = state.query; searchPeople(state.query); }
        window.scrollTo(0, state.scroll || 0);
    } else if (state.view === 'person') {
        openPersonProfile(state.id, true);
    } else if (state.view === 'details') {
        activeNavigationSection = state.type || currentTab;
        setupNewNavigation();
        openDetails(state.id, state.type, true);
    }
};

function prepareCategoryView() {
    captureAndPushState();
    setElementVisible(dashboard, false);
    setElementVisible(detailsView, false);
    setElementVisible(categoryView, true, 'block');
    setElementVisible(document.getElementById('people-view'), false);
    setElementVisible(document.getElementById('person-profile-view'), false);
    setElementVisible(document.getElementById('community-view'), false);
    setElementVisible(document.getElementById('community-profile-view'), false);
    setElementVisible(playerContainer, false);
    window.scrollTo(0, 0);
}

// URL Management
function updateUrl(id, type) {
    const newUrl = new URL(window.location);
    newUrl.searchParams.delete('movie');
    newUrl.searchParams.delete('tv');
    newUrl.searchParams.set(type === 'movie' ? 'movie' : 'tv', id);
    window.history.replaceState({ ...(history.state || {}), gtvhubNavigation: true, gtvhubIndex: appHistoryIndex, view: 'details', id, type }, '', newUrl);
}

function resetUrl() {
    const newUrl = new URL(window.location);
    newUrl.searchParams.delete('movie');
    newUrl.searchParams.delete('tv');
    window.history.replaceState({ ...(history.state || {}), gtvhubNavigation: true, gtvhubIndex: appHistoryIndex }, '', newUrl.pathname);
}

window.shareContent = (title) => {
    const url = window.location.href;
    
    showModal('Share Title', 
        `<p style="margin-bottom:15px; color:#ccc;">Share this link with your friends to watch <b>"${title}"</b>.</p>
         <div style="background:rgba(0,0,0,0.3); padding:12px; border-radius:6px; word-break:break-all; font-family:monospace; font-size:0.9rem; color:#fff; border:1px solid rgba(255,255,255,0.1); user-select:text;">${url}</div>`,
        [
            { text: 'Cancel', secondary: true },
            { text: 'Copy Link', className: 'play-btn', action: () => {
                if (navigator.clipboard && window.isSecureContext) {
                    navigator.clipboard.writeText(url);
                } else {
                    const textArea = document.createElement("textarea");
                    textArea.value = url;
                    textArea.style.position = "fixed";
                    textArea.style.left = "-9999px";
                    document.body.appendChild(textArea);
                    textArea.focus();
                    textArea.select();
                    try { document.execCommand('copy'); } catch (e) {}
                    document.body.removeChild(textArea);
                }
                showToast('Link copied to clipboard!');
            }}
        ]
    );
};

function showToast(msg) {
    const toast = document.createElement('div');
    toast.style.cssText = "position:fixed; bottom:30px; left:50%; transform:translateX(-50%); background:#3498db; color:white; padding:12px 24px; border-radius:30px; z-index:10000; font-weight:bold; box-shadow: 0 10px 30px rgba(0,0,0,0.5); display:flex; align-items:center; gap:10px;";
    toast.innerHTML = `<span class="material-icons">check</span> ${msg}`;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

function setupMobileCheck() {
    const overlay = document.createElement('div');
    overlay.id = 'mobile-warning-overlay';
    overlay.innerHTML = `
        <div class="profile-brand" style="font-size: 2.5rem; margin-bottom: 30px;">GTV <span>hub</span></div>
        <span class="material-icons warning-icon">screen_rotation</span>
        <div class="warning-title">Please Rotate Device</div>
        <p class="warning-text">For the best experience, please use <b>Portrait Mode</b>.<br><br>If you are using "Desktop Site" mode, please turn it off.</p>
    `;
    document.body.appendChild(overlay);

    const check = () => {
        const player = document.getElementById('player-container');
        const isPlayerActive = player && player.style.display !== 'none';
        
        // Never show warning if player is active (allows landscape video)
        if (isPlayerActive) {
            overlay.classList.remove('active');
            return;
        }

        // Detect TV - Explicitly allow TVs
        const ua = navigator.userAgent.toLowerCase();
        const isTV = /smart-tv|smarttv|tv|tizen|web0s|bravia|kmost|appletv|crkey|roku|androidtv|googletv|xbox|playstation|viera|lg|samsung|firetv|fire tv|amazon|silk|aft/i.test(ua);
        
        if (isTV) {
            overlay.classList.remove('active');
            if (document.getElementById('profile-view').style.display === 'none') {
                document.body.classList.remove('no-scroll');
            }
            return;
        }

        // Detect Phone (Small physical screen) - Reduced threshold to 600 to exclude Tablets/Laptops/TVs
        const isSmallDevice = Math.min(window.screen.width, window.screen.height) < 600;
        
        // Detect Landscape
        const isLandscape = window.innerWidth > window.innerHeight;

        // Detect "Request Desktop Site" (Wide viewport on small touch device)
        const isDesktopMode = navigator.maxTouchPoints > 0 && window.innerWidth > 800;

        if (isSmallDevice && (isLandscape || isDesktopMode)) {
            overlay.classList.add('active');
            document.body.classList.add('no-scroll');
        } else {
            overlay.classList.remove('active');
            // Only remove no-scroll if profile view is NOT active
            if (document.getElementById('profile-view').style.display === 'none') {
                document.body.classList.remove('no-scroll');
            }
        }
    };

    window.addEventListener('resize', check);
    window.addEventListener('orientationchange', check);
    
    // Observe player visibility to hide warning immediately when playing starts
    const playerContainer = document.getElementById('player-container');
    if (playerContainer) {
        const observer = new MutationObserver(check);
        observer.observe(playerContainer, { attributes: true, attributeFilter: ['style'] });
    }
    
    check();
}

// --- Search History Functions ---

window.saveSearchQuery = (query) => {
    if (!query || query.trim().length < 2) return;
    let history = safeJsonParse('gtv_search_history', []);
    const trimmed = query.trim();
    // Remove duplicates to move to top
    history = history.filter(q => q.toLowerCase() !== trimmed.toLowerCase());
    history.unshift(trimmed);
    if (history.length > 10) history.pop();
    localStorage.setItem('gtv_search_history', JSON.stringify(history));
};

window.renderSearchHistory = () => {
    const history = safeJsonParse('gtv_search_history', []);
    const container = document.getElementById('modal-search-results');
    
    if (history.length === 0) {
        container.innerHTML = '';
        return;
    }

    let html = `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 20px; color:#aaa; font-size:0.85rem; border-bottom:1px solid rgba(255,255,255,0.05);">
            <span>Recent Searches</span>
            <button onclick="clearSearchHistory()" class="clear-history-btn">Clear All</button>
        </div>
    `;

    html += history.map(q => {
        const safeQ = q.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
        const clickQ = q.replace(/'/g, "\\'");
        return `
        <div class="search-result-item" onclick="triggerSearch('${clickQ}')">
            <div style="width:50px; display:flex; justify-content:center; align-items:center; color:#666;">
                <span class="material-icons" style="font-size:20px;">history</span>
            </div>
            <div class="search-result-info">
                <h4 style="font-weight:normal; color:#ddd;">${safeQ}</h4>
            </div>
            <button onclick="removeSearchItem('${clickQ}', event)" style="background:none; border:none; color:#666; cursor:pointer; padding:10px; display:flex; align-items:center;">
                <span class="material-icons" style="font-size:18px;">close</span>
            </button>
        </div>
    `}).join('');

    container.innerHTML = html;
};

window.clearSearchHistory = () => {
    localStorage.removeItem('gtv_search_history');
    renderSearchHistory();
};

window.removeSearchItem = (query, e) => {
    e.stopPropagation();
    let history = safeJsonParse('gtv_search_history', []);
    history = history.filter(q => q !== query);
    localStorage.setItem('gtv_search_history', JSON.stringify(history));
    renderSearchHistory();
};

window.triggerSearch = (query) => {
    const input = document.getElementById('modal-search-input');
    input.value = query;
    handleSearchInput({ target: input });
};



/* Community discovery and public profiles */
let communityCurrentUsername = '';
let communityProfileSearchRequest=0;
let communityDirectoryRequest = 0;
let communityProfileRequest = 0;
let communityFeedOffset = 0;
let communityFeedHasMore = false;
let communityFeedRequest = 0;
function communityEscape(value){return escapeHtml(String(value==null?'':value));}
function communitySetPage(page){
 ['dashboard','details-view','category-view','people-view','person-profile-view','community-view','community-profile-view'].forEach(id=>{const el=document.getElementById(id);if(el)setElementVisible(el,id===page,'block');});
 setElementVisible(playerContainer,false);const nav=document.querySelector('.top-nav');if(nav)nav.style.display='flex';document.body.classList.remove('no-scroll');window.scrollTo(0,0);
}
function communitySetUrl(hash){const url=new URL(window.location.href);url.searchParams.delete('movie');url.searchParams.delete('tv');url.hash=hash;history.replaceState({...(history.state||{}),gtvhubNavigation:true,gtvhubIndex:appHistoryIndex},'',url);}
window.openCommunityDirectory=async function(fromHistory,directLink){
 if(!fromHistory&&!directLink)captureAndPushState();communitySetPage('community-view');communitySetUrl('community');
 const host=document.getElementById('community-view-content');
 host.innerHTML=`<section class="community-hero people-hero"><div class="people-hero-glow"></div><div class="community-hero-inner"><div class="community-hero-copy"><div class="people-eyebrow"><span class="material-icons">groups</span> CONNECTED BY STORIES</div><h1>A community of <span>viewers.</span></h1><p>Meet fellow viewers, share what you’re watching, and discover new favourites together.</p></div><div class="community-hero-actions"><button type="button" class="community-action-outline community-header-icon-button" onclick="openCommunityRecentMembers()" aria-label="Recently joined" title="Recently joined"><span class="material-icons">group_add</span></button><button type="button" class="community-action-outline community-header-icon-button" onclick="openCommunitySearchDialog()" aria-label="Search profiles" title="Search profiles"><span class="material-icons">search</span></button><button type="button" class="community-heading-avatar-button" onclick="openCommunityProfileSettings()" aria-label="Edit your community profile" title="Edit community profile"><img id="community-heading-avatar" src="./assets/avatars/avatar_1.webp" alt="Your community avatar"><span class="community-avatar-edit-indicator"><span class="material-icons">edit</span></span></button></div></div></section>
 <div class="community-main-content"><section class="community-feed-section"><div class="community-section-heading"><div><span class="community-page-kicker">FROM YOUR COMMUNITY</span><h2>Activity feed</h2></div>${authUser ? '<div class="community-feed-actions"><button type="button" class="community-action-outline" onclick="loadCommunityFeed(true)"><span class="material-icons">refresh</span> Refresh</button><button type="button" class="community-action-primary" onclick="openCommunityPostDialog()"><span class="material-icons">edit</span> Share an update</button></div>' : ''}</div><div id="community-feed-list" class="community-feed-list"><div class="community-loading">Loading activity...</div></div><button type="button" id="community-feed-more" class="community-action-outline community-feed-more" style="display:none" onclick="loadCommunityFeed(false)">Load more</button></section></div>
 `;
  const headingAvatar=document.getElementById('community-heading-avatar');
  if(headingAvatar&&authUser&&supabaseClient){const ownProfile=await supabaseClient.from('community_profiles').select('avatar_id').eq('user_id',authUser.id).maybeSingle();if(ownProfile.data&&headingAvatar.isConnected)headingAvatar.src=communityAvatarUrl(ownProfile.data.avatar_id);}
  await loadCommunityFeed(true);
};
function renderCommunityActivityCards(activities,profiles,emptyMessage){
 const hostProfiles=new Map((profiles||[]).map(p=>[p.user_id,p]));
 if(!activities||!activities.length)return '<div class="community-feed-empty"><span class="material-icons">dynamic_feed</span><strong>No activity yet</strong><p>'+communityEscape(emptyMessage||'Updates shared by this community will appear here.')+'</p></div>';
 return activities.map(item=>{
  const profile=hostProfiles.get(item.user_id);if(!profile)return '';
  const labels={watching:'Currently watching',watched:'Finished watching',recommendation:'Recommendation',update:'Community update'};
  const icons={watching:'play_circle',watched:'task_alt',recommendation:'thumb_up',update:'chat_bubble_outline'};
  const date=item.created_at?new Date(item.created_at):null;
  const dateLabel=date&&!isNaN(date.getTime())?date.toLocaleDateString(undefined,{month:'short',day:'numeric',year:date.getFullYear()!==new Date().getFullYear()?'numeric':undefined}):'';
  return '<article class="community-activity-card"><button type="button" class="community-activity-author" onclick="openCommunityProfile(\''+communityEscape(profile.username)+'\')"><img src="'+communityAvatarUrl(profile.avatar_id)+'" alt="" loading="lazy"><span><strong>'+communityEscape(profile.display_name||profile.username)+'</strong><small>@'+communityEscape(profile.username)+'</small></span></button><div class="community-activity-meta"><span><i class="material-icons">'+icons[item.activity_type]+'</i>'+labels[item.activity_type]+'</span><time>'+communityEscape(dateLabel)+'</time></div><p>'+communityEscape(item.message)+'</p></article>';
 }).join('');
}
async function loadCommunityFeed(reset){
 const host=document.getElementById('community-feed-list'),more=document.getElementById('community-feed-more');if(!host||!supabaseClient)return;
 const request=++communityFeedRequest;if(reset){communityFeedOffset=0;communityFeedHasMore=false;host.innerHTML='<div class="community-loading">Loading activity...</div>';}
 if(!authUser){host.innerHTML='<div class="community-feed-signin"><span class="material-icons">lock</span><div><strong>Your community feed starts here.</strong><p>Sign in to follow viewers and see the updates they share.</p></div><button type="button" class="community-action-primary" onclick="openAccountSignIn()">Sign in</button></div>';if(more)more.style.display='none';return;}
 const follows=await supabaseClient.from('follows').select('following_id').eq('follower_id',authUser.id).limit(100);
 if(request!==communityFeedRequest)return;
 if(follows.error){host.innerHTML='<div class="community-feed-error">Could not load the people you follow.</div>';return;}
 const userIds=Array.from(new Set([authUser.id,...(follows.data||[]).map(row=>row.following_id)]));
 const offset=reset?0:communityFeedOffset;
 const result=await supabaseClient.from('community_activity').select('id,user_id,activity_type,message,created_at').in('user_id',userIds).order('created_at',{ascending:false}).range(offset,offset+19);
 if(request!==communityFeedRequest)return;
 if(result.error){host.innerHTML='<div class="community-feed-error">Could not load the activity feed. Please make sure the community activity database setup has been applied.</div>';if(more)more.style.display='none';return;}
 const activities=result.data||[],profileIds=Array.from(new Set(activities.map(item=>item.user_id)));
 let profiles=[];
 if(profileIds.length){const pr=await supabaseClient.from('community_profiles').select('user_id,username,display_name,avatar_id').in('user_id',profileIds).eq('is_public',true);if(pr.error){host.innerHTML='<div class="community-feed-error">Could not load community members.</div>';return;}profiles=pr.data||[];}
 if(request!==communityFeedRequest)return;
 const markup=renderCommunityActivityCards(activities,profiles,'Updates from people you follow will appear here. Share your first update or follow more viewers.');
 if(reset)host.innerHTML=markup;else host.insertAdjacentHTML('beforeend',markup);
 communityFeedOffset=offset+activities.length;communityFeedHasMore=activities.length===20;
 if(more)more.style.display=communityFeedHasMore?'inline-flex':'none';
}
window.openCommunityPostDialog=async function(){
 if(!authUser||!supabaseClient){showToast('Sign in to share an update.');return;}
 const existing=document.getElementById('community-post-modal');if(existing)existing.remove();
 const profile=await supabaseClient.from('community_profiles').select('avatar_id,is_public').eq('user_id',authUser.id).maybeSingle();
 if(profile.error){showToast('Could not load your community profile.');return;}
 if(!profile.data||!profile.data.is_public){showToast('Create a public community profile before posting.');openCommunityProfileSettings();return;}
 const modal=document.createElement('div');modal.id='community-post-modal';modal.className='community-profile-overlay';
 modal.innerHTML='<div class="community-profile-dialog community-post-dialog" role="dialog" aria-modal="true" aria-labelledby="community-post-title"><div class="community-profile-header"><div><span class="community-profile-kicker">YOUR COMMUNITY</span><h2 id="community-post-title">Share an update</h2><p>Let other viewers know what is on your mind.</p></div><button type="button" class="community-profile-close" aria-label="Close" onclick="closeCommunityPostDialog()"><span class="material-icons">close</span></button></div><form id="community-post-form" class="community-profile-form" onsubmit="submitCommunityPost(event)"><div class="community-composer-top"><img src="'+communityAvatarUrl(profile.data.avatar_id)+'" alt=""><strong>Posting as you</strong></div><label class="community-profile-label" for="community-post-type">What would you like to share?</label><select id="community-post-type" class="community-profile-input" aria-label="Activity type"><option value="watching">I\'m currently watching</option><option value="watched">I\'ve finished watching</option><option value="recommendation">I recommend</option><option value="update">Community update</option></select><label class="community-profile-label" for="community-post-message">Your message</label><textarea id="community-post-message" class="community-profile-input community-profile-bio" maxlength="280" rows="5" required placeholder="Write something for the community..."></textarea><p class="community-profile-hint">Up to 280 characters. Only share what you choose to publish.</p><p id="community-post-error" class="community-profile-message" role="status"></p><div class="community-profile-actions"><button type="button" class="community-action-outline" onclick="closeCommunityPostDialog()">Cancel</button><button type="submit" id="community-post-submit" class="community-action-primary"><span class="material-icons">send</span> Share</button></div></form></div>';
 document.body.appendChild(modal);document.body.classList.add('no-scroll');modal.addEventListener('click',e=>{if(e.target===modal)closeCommunityPostDialog();});modal.querySelector('#community-post-message').focus();
};
window.closeCommunityPostDialog=function(){const modal=document.getElementById('community-post-modal');if(modal)modal.remove();document.body.classList.remove('no-scroll');};
window.submitCommunityPost=async function(event){
 event.preventDefault();if(!authUser||!supabaseClient)return;
 const form=document.getElementById('community-post-form'),button=document.getElementById('community-post-submit'),message=document.getElementById('community-post-message'),type=document.getElementById('community-post-type'),error=document.getElementById('community-post-error');
 if(!form||!button||!message||!type)return;const body=message.value.trim();
 if(!body||body.length>280){if(error)error.textContent='Write an update of up to 280 characters.';return;}
 button.disabled=true;button.textContent='Sharing…';if(error)error.textContent='';
 const profile=await supabaseClient.from('community_profiles').select('is_public').eq('user_id',authUser.id).maybeSingle();
 if(profile.error||!profile.data||!profile.data.is_public){button.disabled=false;button.innerHTML='<span class="material-icons">send</span> Share';if(error)error.textContent='A public community profile is required to post.';return;}
 const result=await supabaseClient.from('community_activity').insert({user_id:authUser.id,activity_type:type.value,message:body});
 if(result.error){button.disabled=false;button.innerHTML='<span class="material-icons">send</span> Share';if(error)error.textContent='Could not share your update. Please try again.';return;}
 closeCommunityPostDialog();showToast('Your update has been shared.');await loadCommunityFeed(true);
};
async function loadCommunityProfileActivity(userId,profile){
 const host=document.getElementById('community-profile-activity-list');if(!host||!supabaseClient)return;
 host.innerHTML='<div class="community-loading">Loading activity...</div>';
 const result=await supabaseClient.from('community_activity').select('id,user_id,activity_type,message,created_at').eq('user_id',userId).order('created_at',{ascending:false}).limit(20);
 if(!document.getElementById('community-profile-activity-list'))return;
 if(result.error){host.innerHTML='<div class="community-feed-error">Could not load activity right now.</div>';return;}
 host.innerHTML=renderCommunityActivityCards(result.data||[],[profile],'This viewer has not shared any activity yet.');
}

window.openCommunitySearchDialog=function(){
 if(document.getElementById('community-search-modal'))return;
 const modal=document.createElement('div');modal.id='community-search-modal';modal.className='community-profile-overlay';
 modal.innerHTML='<div class="community-profile-dialog community-recent-dialog community-search-dialog" role="dialog" aria-modal="true" aria-labelledby="community-search-title"><div class="community-profile-header"><div><span class="community-profile-kicker">COMMUNITY DIRECTORY</span><h2 id="community-search-title">Search profiles</h2><p>Find viewers by their username.</p></div><button type="button" class="community-profile-close" aria-label="Close" onclick="closeCommunitySearchDialog()"><span class="material-icons">close</span></button></div><form id="community-profile-search-form" class="community-profile-search-form"><span class="material-icons">search</span><input id="community-profile-search-input" type="search" maxlength="40" placeholder="Search by username..." autocomplete="off"><button type="submit" class="community-action-primary">Search</button></form><div id="community-profile-search-count" class="community-search-result-count"></div><div id="community-profile-search-results" class="community-recent-list"><div class="community-empty"><span class="material-icons">person_search</span><strong>Find a viewer</strong><p>Enter a username to search public profiles.</p></div></div></div>';
 document.body.appendChild(modal);document.body.classList.add('no-scroll');modal.addEventListener('click',event=>{if(event.target===modal)closeCommunitySearchDialog();});
 const form=modal.querySelector('#community-profile-search-form'),input=modal.querySelector('#community-profile-search-input'),results=modal.querySelector('#community-profile-search-results'),count=modal.querySelector('#community-profile-search-count');
 form.addEventListener('submit',async event=>{
  event.preventDefault();const term=String(input.value||'').trim().replace(/[%_,()]/g,' ').slice(0,40);
  if(!term){results.innerHTML='<div class="community-empty"><span class="material-icons">person_search</span><strong>Enter a username</strong><p>Type a username to find public profiles.</p></div>';count.textContent='';return;}
  const request=++communityProfileSearchRequest;results.innerHTML='<div class="community-loading">Searching community...</div>';count.textContent='';
  if(!supabaseClient){results.innerHTML='<div class="community-empty">Community profiles are unavailable right now.</div>';return;}
  const result=await supabaseClient.from('community_profiles').select('user_id,username,display_name,bio,avatar_id,created_at').eq('is_public',true).not('username','is',null).ilike('username','%'+term+'%').order('created_at',{ascending:false}).limit(30);
  if(!modal.isConnected||request!==communityProfileSearchRequest)return;
  if(result.error){results.innerHTML='<div class="community-empty">Could not search community profiles. Please try again.</div>';return;}
  const profiles=result.data||[];count.textContent=profiles.length+' '+(profiles.length===1?'profile found':'profiles found');
  if(!profiles.length){results.innerHTML='<div class="community-empty"><span class="material-icons">person_search</span><strong>No profiles found</strong><p>Try another username.</p></div>';return;}
  results.innerHTML=profiles.map(p=>'<button type="button" class="community-person-card" data-community-username="'+communityEscape(p.username)+'"><img src="'+communityAvatarUrl(p.avatar_id)+'" alt="" loading="lazy"><span class="community-person-info"><strong>'+communityEscape(p.display_name||p.username)+'</strong><span>@'+communityEscape(p.username)+'</span><small>'+communityEscape(p.bio||'No bio yet.')+'</small></span><span class="material-icons community-person-arrow">chevron_right</span></button>').join('');
 });
 results.addEventListener('click',event=>{const card=event.target.closest('[data-community-username]');if(!card)return;const username=card.dataset.communityUsername;closeCommunitySearchDialog();window.openCommunityProfile(username);});
 input.focus();
};
window.closeCommunitySearchDialog=function(){const modal=document.getElementById('community-search-modal');if(modal)modal.remove();document.body.classList.remove('no-scroll');};
window.openCommunityRecentMembers=async function(){
 if(document.getElementById('community-recent-modal'))return;
 const modal=document.createElement('div');modal.id='community-recent-modal';modal.className='community-profile-overlay';
 modal.innerHTML='<div class="community-profile-dialog community-recent-dialog" role="dialog" aria-modal="true" aria-labelledby="community-recent-title"><div class="community-profile-header"><div><span class="community-profile-kicker">MEET THE COMMUNITY</span><h2 id="community-recent-title">Recently joined</h2><p>The 10 newest public profiles.</p></div><button type="button" class="community-profile-close" aria-label="Close" onclick="closeCommunityRecentMembers()"><span class="material-icons">close</span></button></div><div id="community-recent-list" class="community-recent-list"><div class="community-loading">Loading recent members...</div></div></div>';
 document.body.appendChild(modal);document.body.classList.add('no-scroll');modal.addEventListener('click',event=>{if(event.target===modal)closeCommunityRecentMembers();});
 const host=modal.querySelector('#community-recent-list');
 if(!supabaseClient){host.innerHTML='<div class="community-empty">Community profiles are unavailable right now.</div>';return;}
 const result=await supabaseClient.from('community_profiles').select('user_id,username,display_name,bio,avatar_id,created_at').eq('is_public',true).not('username','is',null).order('created_at',{ascending:false}).limit(10);
 if(!modal.isConnected)return;
 if(result.error){host.innerHTML='<div class="community-empty">Could not load recently joined members. Please try again.</div>';return;}
 const profiles=result.data||[];
 if(!profiles.length){host.innerHTML='<div class="community-empty"><span class="material-icons">groups</span><strong>No public profiles yet</strong><p>When viewers join the community, they’ll appear here.</p></div>';return;}
 host.innerHTML=profiles.map(p=>'<button type="button" class="community-person-card" data-community-username="'+communityEscape(p.username)+'"><img src="'+communityAvatarUrl(p.avatar_id)+'" alt="" loading="lazy"><span class="community-person-info"><strong>'+communityEscape(p.display_name||p.username)+'</strong><span>@'+communityEscape(p.username)+'</span><small>'+communityEscape(p.bio||'No bio yet.')+'</small></span><span class="material-icons community-person-arrow">chevron_right</span></button>').join('');
 host.addEventListener('click',event=>{const card=event.target.closest('[data-community-username]');if(!card)return;const username=card.dataset.communityUsername;closeCommunityRecentMembers();window.openCommunityProfile(username);});
};
window.closeCommunityRecentMembers=function(){const modal=document.getElementById('community-recent-modal');if(modal)modal.remove();document.body.classList.remove('no-scroll');};
async function loadCommunityDirectory(searchTerm){
 const host=document.getElementById('community-directory-list'),heading=document.getElementById('community-results-heading'),count=document.getElementById('community-results-count');if(!host||!supabaseClient)return;
 const term=String(searchTerm||'').trim().replace(/[%_,()]/g,' ').slice(0,40),req=++communityDirectoryRequest;
 if(!term){host.innerHTML='';if(heading)heading.style.display='none';if(count)count.textContent='';return;}
 if(heading)heading.style.display='flex';host.innerHTML='<div class="community-loading">Searching community...</div>';
 const result=await supabaseClient.from('community_profiles').select('user_id,username,display_name,bio,avatar_id,created_at').eq('is_public',true).not('username','is',null).ilike('username','%'+term+'%').order('created_at',{ascending:false}).limit(30);
 if(req!==communityDirectoryRequest||!document.getElementById('community-directory-list'))return;
 if(result.error){host.innerHTML='<div class="community-empty">Could not search community profiles. Please try again.</div>';return;}
 const profiles=result.data||[];if(count)count.textContent=profiles.length+' '+(profiles.length===1?'profile':'profiles');
 if(!profiles.length){host.innerHTML='<div class="community-empty"><span class="material-icons">person_search</span><strong>No profiles found</strong><p>Try another username.</p></div>';return;}
 host.innerHTML=profiles.map(p=>`<button type="button" class="community-person-card" onclick="openCommunityProfile('${communityEscape(p.username)}')"><img src="${communityAvatarUrl(p.avatar_id)}" alt="" loading="lazy"><span class="community-person-info"><strong>${communityEscape(p.display_name||p.username)}</strong><span>@${communityEscape(p.username)}</span><small>${communityEscape(p.bio||'No bio yet.')}</small></span><span class="material-icons community-person-arrow">chevron_right</span></button>`).join('');
}
window.openCommunityProfile=async function(username,fromHistory,directLink){
 const clean=String(username||'').trim().toLowerCase();if(!/^[a-z0-9_]{3,20}$/.test(clean))return;if(!fromHistory&&!directLink)captureAndPushState();communityCurrentUsername=clean;communitySetPage('community-profile-view');communitySetUrl('profile/'+encodeURIComponent(clean));
 const host=document.getElementById('community-profile-content'),req=++communityProfileRequest;host.innerHTML='<div class="community-profile-loading"><div class="spinner"></div><span>Loading profile...</span></div>';if(!supabaseClient){host.innerHTML='<div class="community-empty">Community profiles are unavailable right now.</div>';return;}
 let result=await supabaseClient.from('community_profiles').select('user_id,username,display_name,bio,avatar_id,is_public,created_at').eq('username',clean).maybeSingle();
 if ((!result.data || result.error) && authUser) {
  const ownResult=await supabaseClient.from('community_profiles').select('user_id,username,display_name,bio,avatar_id,is_public,created_at').eq('user_id',authUser.id).maybeSingle();
  if(ownResult.data&&ownResult.data.username===clean)result=ownResult;
 }
 if(req!==communityProfileRequest||communityCurrentUsername!==clean)return;
 if(result.error||!result.data){host.innerHTML='<div class="community-profile-not-found"><div class="category-header-block" style="padding: 0 4%; margin-bottom: 20px; display: flex; align-items: center; gap: 15px;"><button class="back-btn-simple" onclick="openCommunityDirectory()"><span class="material-icons">arrow_back</span></button></div><span class="material-icons">person_off</span><h1>Profile unavailable</h1><p>This profile does not exist, or it is private.</p></div>';return;}
 const p=result.data,own=!!(authUser&&authUser.id===p.user_id);
 const [fr,fg,follow]=await Promise.all([supabaseClient.from('follows').select('follower_id',{count:'exact',head:true}).eq('following_id',p.user_id),supabaseClient.from('follows').select('following_id',{count:'exact',head:true}).eq('follower_id',p.user_id),authUser&&!own?supabaseClient.from('follows').select('follower_id').eq('follower_id',authUser.id).eq('following_id',p.user_id).maybeSingle():Promise.resolve({data:null,error:null})]);
 if(req!==communityProfileRequest||communityCurrentUsername!==clean)return;const followers=fr.count||0,following=fg.count||0,isFollowing=!!follow.data;
 let action='';if(own)action='<button class="community-action-primary community-profile-edit-button" type="button" onclick="openCommunityProfileSettings()"><span class="material-icons">edit</span> Edit profile</button>';else if(authUser)action='<button class="community-follow-button '+(isFollowing?'is-following':'')+'" type="button" onclick="toggleCommunityFollow(\''+communityEscape(p.username)+'\','+isFollowing+')"><span class="material-icons">'+(isFollowing?'check':'person_add')+'</span> '+(isFollowing?'Following':'Follow')+'</button>';else action='<p class="community-signin-hint">Sign in to follow this profile.</p>';
 host.innerHTML=`<div class="category-header-block community-profile-header-block" style="padding: 0 4%; margin-bottom: 30px; display: flex; align-items: center; gap: 15px;"><button class="back-btn-simple" onclick="openCommunityDirectory()"><span class="material-icons">arrow_back</span></button><h1 class="community-profile-page-title">Community</h1></div><div class="community-profile-page"><div class="community-profile-hero"><img class="community-profile-large-avatar" src="${communityAvatarUrl(p.avatar_id)}" alt=""><div class="community-profile-identity"><span class="community-page-kicker">COMMUNITY PROFILE</span><h1>${communityEscape(p.display_name||p.username)}</h1><div class="community-profile-handle">@${communityEscape(p.username)}</div><p>${communityEscape(p.bio||'This viewer has not added a bio yet.')}</p><div class="community-profile-stats"><span><strong>${followers}</strong> followers</span><span><strong>${following}</strong> following</span></div>${action}</div></div><section class="community-profile-activity"><div class="community-section-heading"><div><span class="community-page-kicker">SHARED WITH THE COMMUNITY</span><h2>Activity</h2></div></div><div id="community-profile-activity-list" class="community-feed-list"><div class="community-loading">Loading activity...</div></div></section><button class="community-share-link" type="button" onclick="shareCommunityProfile('${communityEscape(p.username)}')"><span class="material-icons">link</span> Copy profile link</button></div>`;
 await loadCommunityProfileActivity(p.user_id,p);
};
window.toggleCommunityFollow=async function(username,current){
 if(!authUser||!supabaseClient){showToast('Sign in to follow community profiles.');return;}const target=await supabaseClient.from('community_profiles').select('user_id,is_public').eq('username',username).maybeSingle();if(target.error||!target.data||!target.data.is_public){showToast('This profile is no longer available.');return;}
 const button=document.querySelector('.community-follow-button');if(button){button.disabled=true;button.textContent=current?'Unfollowing…':'Following…';}
 const result=current?await supabaseClient.from('follows').delete().eq('follower_id',authUser.id).eq('following_id',target.data.user_id):await supabaseClient.from('follows').insert({follower_id:authUser.id,following_id:target.data.user_id});
 if(result.error){if(button)button.disabled=false;showToast('Could not update follow status. Please try again.');return;}await openCommunityProfile(username,true);
};
window.shareCommunityProfile=async function(username){
 const link=window.location.origin+window.location.pathname+'#profile/'+encodeURIComponent(username);try{if(navigator.clipboard&&window.isSecureContext)await navigator.clipboard.writeText(link);else{const field=document.createElement('textarea');field.value=link;field.style.position='fixed';field.style.opacity='0';document.body.appendChild(field);field.select();document.execCommand('copy');field.remove();}showToast('Profile link copied.');}catch(e){showToast('Could not copy the profile link.');}
};

// Community profile setup and editing
const COMMUNITY_AVATAR_COUNT = 90;
function communityAvatarUrl(avatarId) {
    const id = Math.max(1, Math.min(COMMUNITY_AVATAR_COUNT, Number(avatarId) || 1));
    return './assets/avatars/avatar_' + id + '.webp';
}
window.openCommunityHome = async function() {
    if (!cloudProfileMode || !authUser || !supabaseClient) {
        window.openCommunityDirectory();
        return;
    }
    const result = await supabaseClient.from('community_profiles')
        .select('username').eq('user_id', authUser.id).maybeSingle();
    if (result.error) {
        showToast('Could not load your community profile. Please try again.');
        return;
    }
    if (result.data && result.data.username) {
        await window.openCommunityProfile(result.data.username);
    } else {
        await window.openCommunityProfileSettings();
    }
};
window.openCommunityProfileSettings = async function () {
    if (!cloudProfileMode || !authUser || !supabaseClient) { showToast('Sign in to create a community profile.'); return; }
    document.getElementById('community-profile-modal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'community-profile-modal';
    modal.className = 'community-profile-overlay';
    let avatarOptions = '';
    for (let id = 1; id <= COMMUNITY_AVATAR_COUNT; id++) {
        avatarOptions += '<button type="button" class="community-avatar-option' + (id === 1 ? ' selected' : '') + '" data-avatar-id="' + id + '" aria-label="Avatar ' + id + '" aria-pressed="' + (id === 1) + '"><img src="' + communityAvatarUrl(id) + '" alt="" loading="lazy" decoding="async"></button>';
    }
    modal.innerHTML =
      '<div class="community-profile-dialog" role="dialog" aria-modal="true" aria-labelledby="community-profile-title">' +
        '<div class="community-profile-header"><div><span class="community-profile-kicker">YOUR COMMUNITY IDENTITY</span><h2 id="community-profile-title">Create your profile</h2><p>Choose how other people see you in the community.</p></div>' +
        '<button type="button" class="community-profile-close" aria-label="Close" onclick="closeCommunityProfileSettings()"><span class="material-icons">close</span></button></div>' +
        '<form id="community-profile-form" class="community-profile-form">' +
          '<div class="community-profile-avatar-row"><img id="community-profile-preview" src="./assets/avatars/avatar_1.webp" alt="Selected avatar"><div><strong>Choose your avatar</strong><span>Pick one that feels like you.</span></div></div>' +
          '<div class="community-avatar-grid" id="community-avatar-grid" aria-label="Choose an avatar">' + avatarOptions + '</div>' +
          '<input type="hidden" id="community-avatar-id" value="1">' +
          '<label class="community-profile-label" for="community-display-name">Display name</label><input id="community-display-name" class="community-profile-input" type="text" maxlength="40" placeholder="How should we call you?" required>' +
          '<label class="community-profile-label" for="community-username">Username</label><div class="community-username-field"><span>@</span><input id="community-username" class="community-profile-input" type="text" minlength="3" maxlength="20" pattern="[a-zA-Z0-9_]{3,20}" autocomplete="username" placeholder="your_username" required></div>' +
          '<p class="community-profile-hint">3–20 characters. Letters, numbers and underscores only.</p>' +
          '<label class="community-profile-label" for="community-bio">Bio <span>Optional</span></label><textarea id="community-bio" class="community-profile-input community-profile-bio" maxlength="160" rows="3" placeholder="A little about you and what you like watching..."></textarea>' +
          '<label class="community-profile-visibility"><input id="community-profile-public" type="checkbox"><span class="community-profile-switch"></span><span><strong>Make my profile public</strong><small>Other people can find your profile and follow you. You can change this anytime.</small></span></label>' +
          '<p id="community-profile-message" class="community-profile-message" role="status"></p>' +
          '<div class="community-profile-actions"><button type="button" class="community-action-outline" onclick="closeCommunityProfileSettings()">Cancel</button><button type="submit" class="community-action-primary" id="community-profile-save">Create profile</button></div>' +
        '</form></div>';
    modal.querySelector('#community-avatar-grid').addEventListener('click', function(event) {
        const option = event.target.closest('[data-avatar-id]');
        if (!option) return;
        const id = Number(option.dataset.avatarId);
        modal.querySelectorAll('.community-avatar-option').forEach(function(button) {
            const active = Number(button.dataset.avatarId) === id;
            button.classList.toggle('selected', active);
            button.setAttribute('aria-pressed', String(active));
        });
        modal.querySelector('#community-avatar-id').value = String(id);
        modal.querySelector('#community-profile-preview').src = communityAvatarUrl(id);
    });
    modal.querySelector('#community-profile-form').addEventListener('submit', saveCommunityProfile);
    modal.addEventListener('click', function(event) { if (event.target === modal) closeCommunityProfileSettings(); });
    const result = await supabaseClient.from('community_profiles').select('username,display_name,bio,avatar_id,is_public').eq('user_id', authUser.id).maybeSingle();
    const message = modal.querySelector('#community-profile-message');
    if (result.error) {
        modal.querySelector('#community-profile-title').textContent = 'Community profile';
        message.textContent = 'Could not load your profile: ' + result.error.message;
        message.classList.add('error');
        document.body.appendChild(modal);
        document.body.classList.add('no-scroll');
        return;
    }
    const data = result.data;
    const metadata = authUser.user_metadata || {};
    const defaultName = metadata.display_name || metadata.full_name || (authUser.email ? authUser.email.split('@')[0] : '');
    modal.querySelector('#community-profile-title').textContent = data ? 'Edit your profile' : 'Create your profile';
    modal.querySelector('#community-display-name').value = (data && data.display_name) || defaultName;
    modal.querySelector('#community-username').value = (data && data.username) || '';
    modal.querySelector('#community-bio').value = (data && data.bio) || '';
    modal.querySelector('#community-profile-public').checked = !!(data && data.is_public);
    const avatarId = Math.max(1, Math.min(COMMUNITY_AVATAR_COUNT, Number(data && data.avatar_id) || 1));
    modal.querySelector('#community-avatar-id').value = String(avatarId);
    modal.querySelector('#community-profile-preview').src = communityAvatarUrl(avatarId);
    modal.querySelectorAll('.community-avatar-option').forEach(function(option) {
        const active = Number(option.dataset.avatarId) === avatarId;
        option.classList.toggle('selected', active);
        option.setAttribute('aria-pressed', String(active));
    });
    modal.querySelector('#community-profile-save').textContent = data ? 'Save changes' : 'Create profile';
    // Reveal the dialog only after the saved profile has populated every field.
    document.body.appendChild(modal);
    document.body.classList.add('no-scroll');
};
window.closeCommunityProfileSettings = function() {
    const modal = document.getElementById('community-profile-modal');
    if (modal) modal.remove();
    document.body.classList.remove('no-scroll');
};
async function saveCommunityProfile(event) {
    event.preventDefault();
    if (!authUser || !supabaseClient) return;
    const modal = document.getElementById('community-profile-modal');
    const button = modal.querySelector('#community-profile-save');
    const message = modal.querySelector('#community-profile-message');
    const username = modal.querySelector('#community-username').value.trim().toLowerCase();
    const displayName = modal.querySelector('#community-display-name').value.trim();
    const bio = modal.querySelector('#community-bio').value.trim();
    const avatarId = Number(modal.querySelector('#community-avatar-id').value);
    const isPublic = modal.querySelector('#community-profile-public').checked;
    message.textContent = '';
    message.classList.remove('error');
    if (!/^[a-z0-9_]{3,20}$/.test(username)) { message.textContent = 'Username must be 3–20 characters and use only letters, numbers or underscores.'; message.classList.add('error'); return; }
    if (!displayName || displayName.length > 40 || bio.length > 160 || !Number.isInteger(avatarId) || avatarId < 1 || avatarId > COMMUNITY_AVATAR_COUNT) { message.textContent = 'Please check your profile details and try again.'; message.classList.add('error'); return; }
    button.disabled = true;
    button.textContent = 'Saving…';
    const result = await supabaseClient.from('community_profiles').upsert({user_id:authUser.id,username:username,display_name:displayName,bio:bio,avatar_id:avatarId,is_public:isPublic},{onConflict:'user_id'});
    button.disabled = false;
    button.textContent = 'Save changes';
    if (result.error) {
        message.textContent = result.error.code === '23505' ? 'That username is already taken. Try another one.' : 'Could not save your profile: ' + result.error.message;
        message.classList.add('error');
        return;
    }
    closeCommunityProfileSettings();
    showToast(isPublic ? 'Community profile saved and published.' : 'Community profile saved privately.');
    await window.openCommunityProfile(username, true, true);
}
