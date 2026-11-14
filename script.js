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
let currentCategoryPage = 1;
let currentCategoryApiUrl = '';
let currentSearchPage = 1;
let currentSearchQuery = '';
let heroCache = { movie: null, tv: null };
let sessionRecItems = { movie: { like: null }, tv: { like: null } };
let heroInterval = null; // For carousel auto-rotation

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
let pendingDeepLink = null;

if (localStorage.getItem('gtv_reduced_motion') === 'true') {
    document.body.classList.add('reduced-motion');
}

document.addEventListener('DOMContentLoaded', () => {
    // Global Error Handler for stability
    window.onerror = function(msg, url, line, col, error) {
        console.error("GTV Error:", msg, error);
        return false; 
    };

    // Capture deep link params immediately
    const urlParams = new URLSearchParams(window.location.search);
    const movieId = urlParams.get('movie');
    const tvId = urlParams.get('tv');
    if (movieId || tvId) {
        pendingDeepLink = { movieId, tvId };
    }

    setupBranding();
    initApp(); // Start with Profile Check instead of direct Dashboard load
    setupNewNavigation();
    setupMobileCheck();
    
    // Register Service Worker for Caching
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js').catch(console.error);
    }
    
    // Listen for the browser/remote back button
    window.addEventListener('popstate', (e) => {
        if (isManualBack) {
            isManualBack = false;
            return;
        }
        // When the back button is pressed, we trigger our custom back handler.
        // The navigationStack should be popped by the handler itself.
        handleBack();
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
            console.warn('GTV Hub: fullscreen request was denied.', error);
        }
    };

    // Small hint shown whenever GTV Hub enters fullscreen.
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

    document.addEventListener('fullscreenchange', updateFullscreenButton);
    document.addEventListener('webkitfullscreenchange', updateFullscreenButton);
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
    header.appendChild(rightActions);
    
    // Close dropdown on click outside
    window.addEventListener('click', (e) => {
        if (!e.target.closest('.server-select-container')) {
             const dd = document.getElementById('server-dropdown-menu');
             if(dd) dd.classList.remove('active');
        }
    });
    
    playerCont.insertBefore(header, playerCont.firstChild);

    // Auto-hide GTV Hub controls. Cross-origin iframe movement cannot be
    // tracked, so keep controls visible while the pointer is inside the frame.
    let controlsHideTimer = null;
    const scheduleControlsHide = () => {
        if (controlsHideTimer) clearTimeout(controlsHideTimer);
        controlsHideTimer = setTimeout(() => {
            const dropdownOpen = document.getElementById('server-dropdown-menu')?.classList.contains('active');
            const focusInsideHeader = header.contains(document.activeElement);
            if (!dropdownOpen && !focusInsideHeader) {
                playerCont.classList.add('controls-hidden');
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

function setupBranding() {
    document.title = 'GTV hub - Movies & TV Shows';
    const style = document.createElement('style');
    style.textContent = `
        :root {
            --accent: #3498db; /* GTV/Hub style blue accent */
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
    if(currentTab === 'movie') moviesBtn.classList.add('active');
    navLinks.appendChild(moviesBtn);

    // TV Shows
    const tvBtn = document.createElement('div');
    tvBtn.className = 'nav-item';
    tvBtn.textContent = 'TV Shows';
    tvBtn.onclick = () => switchTab('tv');
    if(currentTab === 'tv') tvBtn.classList.add('active');
    navLinks.appendChild(tvBtn);

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
        <div class="dropdown-item" onclick="renderProfileScreen(); document.getElementById('nav-dropdown').classList.remove('active');"><span class="material-icons">people</span> Switch Profile</div>
        <div class="dropdown-item" onclick="openCategories(); document.getElementById('nav-dropdown').classList.remove('active');"><span class="material-icons">category</span> Categories</div>
        <div class="dropdown-item" onclick="randomPick();"><span class="material-icons">shuffle</span> Random Pick</div>
        <div class="dropdown-item" onclick="openWatchlist();"><span class="material-icons">list</span> My Watchlist</div>
        <div class="dropdown-item" onclick="openHiddenContent();"><span class="material-icons">visibility_off</span> Hidden Content</div>
        <div class="dropdown-item" onclick="openSettingsView(); document.getElementById('nav-dropdown').classList.remove('active');"><span class="material-icons">settings</span> Settings</div>
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

window.closeSearchModal = () => {
    const modal = document.getElementById('search-modal-overlay');
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
    modal.inert = true;
    document.getElementById('modal-search-input').value = '';
    document.getElementById('modal-search-results').innerHTML = '';
};

window.handleSearchResultClick = (query, id, type) => {
    saveSearchQuery(query);
    closeSearchModal();

    if (type !== currentTab && (type === 'movie' || type === 'tv')) {
        switchTab(type);
    }
    
    openDetails(id, type);
};

async function handleSearchInput(e) {
    const query = e.target.value.trim();
    const resultsContainer = document.getElementById('modal-search-results');
    
    clearTimeout(searchDebounceTimer);
    
    if (query.length === 0) {
        renderSearchHistory();
        return;
    }

    if (query.length < 2) {
        resultsContainer.innerHTML = '';
        return;
    }

    searchDebounceTimer = setTimeout(async () => {
        currentSearchQuery = query;
        currentSearchPage = 1;
        
        try {
            const res = await fetch(`${TMDB_BASE}/search/multi?api_key=${TMDB_KEY}&query=${encodeURIComponent(query)}&page=1`);
            const data = await res.json();
            
            resultsContainer.innerHTML = generateSearchItemsHtml(data.results);
    
            if (data.total_pages > 1) {
                const btnHtml = `
                    <div id="search-load-more-btn" style="text-align:center; padding:15px;">
                        <button class="more-info-btn" onclick="loadMoreSearch()" style="display:inline-flex; margin:0 auto; font-size:0.8rem; padding:8px 20px;">Load More</button>
                    </div>`;
                resultsContainer.insertAdjacentHTML('beforeend', btnHtml);
            }
        } catch(e) {
            console.error(e);
        }
    }, 500);
}

function generateSearchItemsHtml(results) {
    return results.filter(item => !excludedContent.includes(item.id.toString()) && item.poster_path).map(item => {
        if (item.media_type === 'person') return '';
        const type = item.media_type || 'movie';
        const year = (item.release_date || item.first_air_date || '').split('-')[0] || 'N/A';
        const title = item.title || item.name || 'Untitled';
        
        const imgContent = `<img class="search-result-poster" src="${IMG_BASE + item.poster_path}" alt="${escapeHtml(title)}" onerror="this.onerror=null; this.src='./icon.png';">`;
        
        const safeQuery = escapeInlineJsString(currentSearchQuery);

        return `
            <div class="search-result-item" onclick="handleSearchResultClick('${safeQuery}', '${item.id}', '${type}')" style="cursor:pointer;">
                ${imgContent}
                <div class="search-result-info">
                    <h4>${escapeHtml(title)}</h4>
                    <p>${type.toUpperCase()} • ${year}</p>
                </div>
            </div>
        `;
    }).join('');
}

window.loadMoreSearch = async () => {
    const btnContainer = document.getElementById('search-load-more-btn');
    if (!btnContainer) return;
    const btn = btnContainer.querySelector('button');
    btn.innerText = 'Loading...';
    
    currentSearchPage++;
    
    try {
        const res = await fetch(`${TMDB_BASE}/search/multi?api_key=${TMDB_KEY}&query=${encodeURIComponent(currentSearchQuery)}&page=${currentSearchPage}`);
        const data = await res.json();
        
        const newItems = generateSearchItemsHtml(data.results);
        btnContainer.insertAdjacentHTML('beforebegin', newItems);
        
        if (currentSearchPage >= data.total_pages) {
            btnContainer.remove();
        } else {
            btn.innerText = 'Load More';
        }
    } catch(e) {
        console.error(e);
        btn.innerText = 'Error';
    }
};

// --- Profile System Logic ---

let isManagingProfiles = false;

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
            deleteBtn = `<button class="profile-delete-btn" onclick="deleteProfile(${p.id}, event)"><span class="material-icons" style="font-size:16px;">close</span></button>`;
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

window.createProfile = (name) => {
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
        { text: 'Delete', className: 'play-btn remove-confirm-btn', action: () => {
            profiles = profiles.filter(p => p.id !== id);
            localStorage.setItem('gtv_profiles', JSON.stringify(profiles));
            // Cleanup data
            localStorage.removeItem(`gtv_watchlist_${id}`);
            localStorage.removeItem(`gtv_liked_content_${id}`);
            localStorage.removeItem(`gtv_excluded_content_${id}`);
            localStorage.removeItem(`gtv_watch_history_${id}`);
            renderProfileScreen();
        }}
    ]);
};

window.selectProfile = (id) => {
    currentProfile = profiles.find(p => p.id === id);
    if (!currentProfile) return;
    
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
            <div class="dropdown-item" onclick="renderProfileScreen(); document.getElementById('nav-dropdown').classList.remove('active');"><span class="material-icons">people</span> Switch Profile</div>
            <div class="dropdown-item" onclick="openCategories(); document.getElementById('nav-dropdown').classList.remove('active');"><span class="material-icons">category</span> Categories</div>
            <div class="dropdown-item" onclick="randomPick();"><span class="material-icons">shuffle</span> Random Pick</div>
            <div class="dropdown-item" onclick="openWatchlist();"><span class="material-icons">list</span> My Watchlist</div>
            <div class="dropdown-item" onclick="openHiddenContent();"><span class="material-icons">visibility_off</span> Hidden Content</div>
            <div class="dropdown-item" onclick="openSettingsView(); document.getElementById('nav-dropdown').classList.remove('active');"><span class="material-icons">settings</span> Settings</div>
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
        const trendingData = await trendingRes.json();
        
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
            createTop10Row(top10Data.results);
        } catch(e) { console.error("Top 10 Error", e); }

        // Populate Rows with 20 items each
        createRow('Trending Now', trendingData.results, `${TMDB_BASE}/trending/${mode}/week?api_key=${TMDB_KEY}`);
        const top = await (await fetch(`${TMDB_BASE}/${currentTab}/top_rated?api_key=${TMDB_KEY}${regionParam}`)).json();
        createRow('Top Rated', top.results, `${TMDB_BASE}/${currentTab}/top_rated?api_key=${TMDB_KEY}${regionParam}`);

        // Add more content rows
        const popular = await (await fetch(`${TMDB_BASE}/${currentTab}/popular?api_key=${TMDB_KEY}${regionParam}`)).json();
        createRow('Popular on GTV', popular.results, `${TMDB_BASE}/${currentTab}/popular?api_key=${TMDB_KEY}${regionParam}`);

        // Coming Soon / On The Air
        const upcomingEndpoint = currentTab === 'movie' ? 'upcoming' : 'on_the_air';
        const upcomingTitle = currentTab === 'movie' ? 'In Theaters' : 'On TV Now';
        try {
            const upcoming = await (await fetch(`${TMDB_BASE}/${currentTab}/${upcomingEndpoint}?api_key=${TMDB_KEY}${regionParam}`)).json();
            if(upcoming.results && upcoming.results.length > 0) createRow(upcomingTitle, upcoming.results, `${TMDB_BASE}/${currentTab}/${upcomingEndpoint}?api_key=${TMDB_KEY}${regionParam}`);
        } catch(e) {}

        // Genre specific rows
        const genre1Id = currentTab === 'movie' ? 28 : 10759; // Action / Action & Adventure
        const genre1Name = currentTab === 'movie' ? 'Action Movies' : 'Action & Adventure';
        const genre1 = await (await fetch(`${TMDB_BASE}/discover/${currentTab}?api_key=${TMDB_KEY}&with_genres=${genre1Id}`)).json();
        createRow(genre1Name, genre1.results, `${TMDB_BASE}/discover/${currentTab}?api_key=${TMDB_KEY}&with_genres=${genre1Id}`);

        const genre2Id = 35; // Comedy
        const genre2 = await (await fetch(`${TMDB_BASE}/discover/${currentTab}?api_key=${TMDB_KEY}&with_genres=${genre2Id}`)).json();
        createRow('Comedy Hits', genre2.results, `${TMDB_BASE}/discover/${currentTab}?api_key=${TMDB_KEY}&with_genres=${genre2Id}`);

        createFooter();
    } catch (e) {
        rowsContainer.innerHTML = '<p style="text-align:center; padding:50px;">Failed to load content.</p>';
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
            <div class="continue-watching-card" onclick="playItem('${item.id}', '${type}')">
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
    
    currentCategoryApiUrl = apiUrl;
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
    if (!currentCategoryApiUrl) return;
    
    const btn = document.querySelector('#cat-load-more-container button');
    if(btn) btn.innerText = 'Loading...';

    currentCategoryPage++;
    const separator = currentCategoryApiUrl.includes('?') ? '&' : '?';
    const url = `${currentCategoryApiUrl}${separator}page=${currentCategoryPage}`;

    try {
        const res = await fetch(url);
        const data = await res.json();
        
        if (data.results && data.results.length > 0) {
            renderCategoryItems(data.results);
            if(btn) btn.innerText = 'Load More';
        } else {
            if(btn) {
                btn.innerText = 'No More Content';
                btn.disabled = true;
            }
        }
    } catch (e) {
        if(btn) btn.innerText = 'Error Loading';
    }
};

window.closeCategoryView = () => {
    handleBack();
};

window.openCategories = async () => {
    prepareCategoryView();

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
    document.getElementById('category-title').innerText = 'My Watchlist';
    categoryList.innerHTML = '';
    
    const existingBtn = document.getElementById('cat-load-more-container');
    if(existingBtn) existingBtn.remove();

    if (watchlist.length === 0) {
        categoryList.innerHTML = '<div style="padding:50px; text-align:center; color:#888;">Your watchlist is empty.</div>';
        return;
    }

    categoryList.innerHTML = '<div class="watchlist-grid">' + watchlist.filter(i => i.poster_path).map(item => {
        const type = item.media_type || 'movie';
        const img = IMG_BASE + item.poster_path;
        const titleText = item.title || item.name || 'Untitled';
        const yearVal = (item.release_date || item.first_air_date || '').split('-')[0];
        const ratingVal = item.vote_average ? item.vote_average.toFixed(1) : null;
        const ratingColor = getRatingColor(item.vote_average || 0);
        const ratingHtml = ratingVal && parseFloat(ratingVal) > 0 ? `<div class="poster-rating" style="color:${ratingColor}"><span class="material-icons">star</span> ${ratingVal}</div>` : '';
        return `
            <div class="poster-card" onclick="openDetails('${item.id}', '${type}')">
                <div class="poster-type">${type === 'tv' ? 'TV SHOW' : 'MOVIE'}</div>
                <img class="poster-img" src="${img}" alt="${escapeHtml(titleText)}">
                <div class="poster-info">
                    <div class="poster-title">${escapeHtml(titleText)}</div>
                    ${ratingHtml}
                </div>
                <button class="watchlist-remove-btn" onclick="removeFromWatchlist('${item.id}', event)" title="Remove">
                    <span class="material-icons" style="font-size: 16px;">close</span>
                </button>
            </div>
        `;
    }).join('') + '</div>';
};

window.openWatchlist = () => {
    document.getElementById('nav-dropdown').classList.remove('active');
    
    if (watchlist.length === 0) {
        showModal('My Watchlist', 'Your watchlist is empty. Add movies and TV shows to keep track of what you want to watch.', [{ text: 'OK', secondary: true }]);
        return;
    }
    
    prepareCategoryView();
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

window.switchTab = (tab) => {
    currentTab = tab;
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    const activeBtn = document.getElementById(`nav-${tab}`);
    if(activeBtn) activeBtn.classList.add('active');
    // Re-run nav setup to update active state visual
    setupNewNavigation();
    loadDashboard();
    window.scrollTo(0, 0);
};

window.openDetails = async (id, type, isHistory = false) => {
    if (!isHistory) captureAndPushState();

    setElementVisible(dashboard, false);
    setElementVisible(detailsView, true, 'block');
    setElementVisible(categoryView, false);
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
            <div class="hero-section" style="min-height:100vh; background-image:${backdropStyle}; background-size:cover; background-position:center; position:relative; display:flex; align-items:flex-start; padding:140px 4% 80px 4%;">
                <div class="hero-overlay" style="position:absolute; inset:0; background:linear-gradient(to right, #050505 0%, rgba(5,5,5,0.8) 20%, rgba(5,5,5,0.2) 100%);"></div>
                <button onclick="closeDetails()" class="hero-icon-btn page-back-btn" style="position:absolute; z-index:20;"><span class="material-icons">arrow_back</span></button>
                <div style="position:relative; z-index:10; max-width: 700px; text-align:left;">
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
    // Fix for stuck history (iframe pollution):
    // Force UI update immediately, then try to sync history.
    isManualBack = true;
    handleBack();
    
    if (history.length > 1) {
        history.back();
    }
    setTimeout(() => { isManualBack = false; }, 300);
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
    
    setElementVisible(playerContainer, true, 'flex');
    playerContainer.classList.remove('controls-hidden');
    if (window.showGtvPlayerControls) window.showGtvPlayerControls();
    document.body.style.overflow = 'hidden';
    const itemData = await addToHistory(id, type);
    
    const hideBtn = document.getElementById('player-hide-btn');
    if (hideBtn && itemData) {
        const title = escapeInlineJsString(itemData.title || '');
        hideBtn.onclick = () => reportStreamIssue(id, title);
    }
    
    loadPlayerSource();
};

async function addToHistory(id, type) {
    const historyKey = currentProfile ? `gtv_watch_history_${currentProfile.id}` : 'gtv_watch_history';
    let history = safeJsonParse(historyKey, []);
    
    let season = null;
    let episode = null;
    if (window.currentPlayInfo && window.currentPlayInfo.id == id) {
         season = window.currentPlayInfo.season;
         episode = window.currentPlayInfo.episode;
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
    updateContinueWatchingRow();
    return itemData;
}

window.loadPlayerSource = () => {
    const { id, type, season, episode } = window.currentPlayInfo;
    const baseUrl = playerSources[currentSourceIdx];  

    let embedUrl = type === 'movie' 
        ? `${baseUrl}/movie/${id}`
        : `${baseUrl}/tv/${id}/${season}/${episode}`;
        
    if (baseUrl.includes('vidking.net')) {
        embedUrl += '?autoPlay=true';
        if (type === 'tv') {
            embedUrl += '&nextEpisode=true&episodeSelector=true';
        }
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
        <div style="max-width: 800px; margin: 0 auto; padding: 20px; line-height: 1.6; color: #ccc;">
        <h3 style="color:var(--accent); margin-bottom:10px;">Getting Started</h3>
        <p>Welcome to GTV hub! Browse and stream a vast collection of Movies and TV Shows.</p>
        
        <h4 style="color:#fff; margin-top:25px; margin-bottom:10px;">How to Watch</h4>
        <p>Click on any poster to view details. On the details page, click "Play Now". For TV Shows, select seasons and episodes from the dropdown.</p>
        
        <h4 style="color:#fff; margin-top:25px; margin-bottom:10px;">Switching Servers</h4>
        <p>If a video fails to load or buffers frequently, try switching the server. In the player, click the "Server" button (or the DNS icon) to select a different video source.</p>

        <h4 style="color:#fff; margin-top:25px; margin-bottom:10px;">Custom API Key</h4>
        <p>This site uses the TMDB API for metadata. If you experience issues with data loading, you can use your own TMDB API Key in Settings. This ensures you don't hit shared rate limits.</p>

        <h4 style="color:#fff; margin-top:25px; margin-bottom:10px;">My Watchlist</h4>
        <p>Save content for later by clicking the "Add to Watchlist" button on any movie or show. Access your list from the main menu or the dashboard.</p>

        <h4 style="color:#fff; margin-top:25px; margin-bottom:10px;">Trailers</h4>
        <p>Watch trailers for movies and shows directly within the app by clicking the "Trailer" button on the details page.</p>

        <h4 style="color:#fff; margin-top:25px; margin-bottom:10px;">Hidden Content</h4>
        <p>Some content may not be available at the moment. If a stream is broken, please <b>try all available servers</b> in the player first. If it still doesn't work, you can hide the title from your lists so it doesn't appear again. Manage your hidden items in the "Hidden Content" section in the menu.</p>
        
        <h4 style="color:#fff; margin-top:25px; margin-bottom:10px;">Ads & Popups</h4>
        <p>The video player is provided by a third-party service and may contain ads. We do not control these ads and we do not receive any revenue from them. They are inserted by the video host to support their servers.</p>
        
        <h4 style="color:#fff; margin-top:25px; margin-bottom:10px;">Troubleshooting</h4>
        <p>If a video fails to load, try refreshing the page. Ensure you have a stable internet connection.</p>
        <p style="margin-top:10px; color:#aaa; font-size:0.9em;"><strong>Note:</strong> If you see a movie or episode without a cover image or thumbnail, it often indicates that the content is not available on the server. Playback for these items is likely to fail.</p>
        </div>
    `);
};

window.openAboutView = () => {
    openInfoView('About', `
        <div style="max-width: 900px; margin: 0 auto; padding: 40px 20px; color: #e0e0e0; font-family: 'Outfit', sans-serif;">
            
            <!-- Hero Header -->
            <div style="text-align: center; margin-bottom: 60px; position: relative;">
                <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 200px; height: 200px; background: var(--accent); filter: blur(100px); opacity: 0.2; z-index: -1;"></div>
                <img src="../icon.png" alt="GTV Hub" style="width: 100px; height: 100px; border-radius: 24px; margin-bottom: 25px; box-shadow: 0 20px 40px rgba(0,0,0,0.3);">
                <h1 style="font-size: 3.5rem; font-weight: 800; margin: 0 0 10px 0; letter-spacing: -1px; background: linear-gradient(135deg, #3498db 0%, #9b59b6 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">GTV <span style="font-weight: 300;">hub</span></h1>
                <div style="display: flex; align-items: center; justify-content: center; gap: 15px; margin-bottom: 30px;">
                    <span style="background: rgba(255,255,255,0.1); padding: 6px 16px; border-radius: 20px; font-size: 0.85rem; font-weight: 600; letter-spacing: 0.5px; border: 1px solid rgba(255,255,255,0.1);">v2.1.0</span>
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
                    <p style="color: #888; font-size: 0.95rem; line-height: 1.6; margin: 0;">No account required. Your data stays locally on your device.</p>
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
                            <div style="color: #fff; font-weight: 700; font-size: 1.1rem;">VidSrc</div>
                            <div style="font-size: 0.85rem; color: #888; margin-top: 5px;">Video player integration.</div>
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
                <a href="mailto:exeinn.info@gmail.com?subject=GTV Hub Feedback" style="text-decoration:none;">
                    <button class="feedback-btn" style="background: #fff; color: #000; border: none; padding: 15px 35px; font-size: 1rem;">
                        <span class="material-icons" style="color: #000;">mail</span> Send Feedback
                    </button>
                </a>
            </div>
        </div>
    `);
};

window.openLegalView = () => {
    openInfoView('Legal & DMCA', `
        <div style="max-width: 800px; margin: 0 auto; padding: 20px; line-height: 1.6; color: #ccc;">
            <h4 style="color:#fff; margin-bottom:10px;">General Disclaimer</h4>
            <p>GTV hub is a search engine and indexing platform. We do not host, upload, store, or transmit any video, film, or media files on our servers. We simply crawl and index content found on third-party websites and public domains.</p>
            <p>We have no control over the content found on external sites. If you find any content that violates your rights, please understand that removing it from GTV hub will not remove it from the source. You must contact the hosting provider directly.</p>

            <h4 style="color:#fff; margin-top:25px; margin-bottom:10px;">DMCA Compliance</h4>
            <p>GTV hub respects the intellectual property rights of others and expects its users to do the same. It is our policy to respond to clear notices of alleged copyright infringement that comply with the Digital Millennium Copyright Act (DMCA).</p>
            <p>If you believe that your copyrighted work has been copied in a way that constitutes copyright infringement and is accessible on this site, please notify us. However, since we do not host the files, we strongly recommend contacting the actual video hosting site to have the content removed permanently from the internet.</p>

            <h4 style="color:#fff; margin-top:25px; margin-bottom:10px;">Third-Party Links</h4>
            <p>This site contains links to other sites on the Internet. We are not responsible for the accuracy, legality, or decency of material contained on those sites. The inclusion of any link does not imply endorsement by GTV hub.</p>
        </div>
    `);
};

window.openTermsView = () => {
    openInfoView('Terms of Use', `
        <div style="max-width: 800px; margin: 0 auto; padding: 20px; line-height: 1.6; color: #ccc;">
            <h4 style="color:#fff; margin-bottom:10px;">1. Acceptance of Terms</h4>
            <p>By accessing and using GTV hub ("the Service"), you accept and agree to be bound by the terms and provision of this agreement. In addition, when using these particular services, you shall be subject to any posted guidelines or rules applicable to such services.</p>

            <h4 style="color:#fff; margin-top:25px; margin-bottom:10px;">2. Description of Service</h4>
            <p>GTV hub is a search engine and media indexing tool. We do not host, upload, or store any video files on our servers. The Service acts as a client-side interface to browse metadata provided by The Movie Database (TMDB) and embed video players from third-party providers (such as VidSrc).</p>

            <h4 style="color:#fff; margin-top:25px; margin-bottom:10px;">3. User Responsibilities</h4>
            <p>You agree to use the Service only for lawful purposes. You are prohibited from violating or attempting to violate the security of the Service, including, without limitation, accessing data not intended for you or logging into a server or account which you are not authorized to access.</p>

            <h4 style="color:#fff; margin-top:25px; margin-bottom:10px;">4. Intellectual Property</h4>
            <p>The metadata, posters, and images displayed are the property of their respective owners (TMDB and its contributors). GTV hub claims no ownership over this content. Video content is hosted by third parties; GTV hub has no control over and assumes no responsibility for the content, privacy policies, or practices of any third-party sites or services.</p>

            <h4 style="color:#fff; margin-top:25px; margin-bottom:10px;">5. Disclaimer of Warranties</h4>
            <p>The Service is provided on an "AS IS" and "AS AVAILABLE" basis. GTV hub makes no representations or warranties of any kind, express or implied, as to the operation of their services, or the information, content, or materials included therein.</p>

            <h4 style="color:#fff; margin-top:25px; margin-bottom:10px;">6. Limitation of Liability</h4>
            <p>In no event shall GTV hub be liable for any direct, indirect, incidental, special, exemplary, or consequential damages (including, but not limited to, procurement of substitute goods or services; loss of use, data, or profits; or business interruption) however caused and on any theory of liability.</p>
        </div>
    `);
};

window.openPrivacyView = () => {
    openInfoView('Privacy Policy', `
        <div style="max-width: 800px; margin: 0 auto; padding: 20px; line-height: 1.6; color: #ccc;">
            <p>Last updated: ${new Date().toLocaleDateString()}</p>
            
            <h4 style="color:#fff; margin-top:25px; margin-bottom:10px;">1. Information Collection</h4>
            <p>GTV hub is designed with privacy in mind. We do not require you to create an account or provide personal information (such as name, email address, or phone number) to use the Service.</p>

            <h4 style="color:#fff; margin-top:25px; margin-bottom:10px;">2. Local Storage & Cookies</h4>
            <p>We do not use traditional server-side "cookies" to track you across the internet. However, we use your browser's <strong>Local Storage</strong> to save your preferences and enhance your experience. This data stays on your device and is never sent to our servers.</p>
            <p><strong>Data stored locally includes:</strong></p>
            <ul style="list-style-type: disc; padding-left: 20px; margin-top: 5px;">
                <li>Your Watchlist and Favorites</li>
                <li>Watch History</li>
                <li>App Settings (Theme, Region, API Keys)</li>
                <li>Profile Information (Names and Colors)</li>
            </ul>
            <p>You can clear this data at any time by clearing your browser's cache or using the "Factory Reset" option in Settings.</p>

            <h4 style="color:#fff; margin-top:25px; margin-bottom:10px;">3. Third-Party Services</h4>
            <p>Our Service interacts with third-party APIs and services. These services may collect their own data according to their privacy policies:</p>
            <ul style="list-style-type: disc; padding-left: 20px; margin-top: 5px;">
                <li><strong>The Movie Database (TMDB):</strong> Used for fetching movie/TV show data.</li>
                <li><strong>VidSrc / Video Hosts:</strong> When you play a video, you are connecting directly to a third-party server. They may use cookies or collect IP addresses for logging and ad delivery.</li>
            </ul>
        </div>
    `);
};

window.openSettingsView = () => {
    const region = localStorage.getItem('gtv_region') || 'US';
    const defaultTab = localStorage.getItem('gtv_default_tab') || 'movie';
    const reducedMotion = localStorage.getItem('gtv_reduced_motion') === 'true';
    const version = '2.1.1';

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

window.saveSetting = (key, value) => {
    localStorage.setItem(key, value);
    
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
    let state = null;
    // Save current view state to stack before navigating away
    // Note: We do NOT push to browser history here, the new view handles that.

    if (detailsView.style.display === 'block') {
        if (currentDetailsData) {
            state = {
                view: 'details',
                id: currentDetailsData.id,
                type: currentDetailsData.media_type,
                scroll: window.scrollY
            };
        }
    } else if (categoryView.style.display === 'block') {
        state = {
            view: 'category',
            title: document.getElementById('category-title').textContent,
            html: categoryList.innerHTML,
            apiUrl: currentCategoryApiUrl,
            page: currentCategoryPage,
            items: [...allLoadedCategoryItems],
            scroll: window.scrollY
        };
    } else if (dashboard.style.display === 'block') {
        state = { view: 'dashboard', scroll: window.scrollY };
    }
    
    if (state) navigationStack.push(state);
}

window.handleBack = () => {
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
        document.getElementById('hero-section').style.display = 'flex';
        resetUrl();
        return;
    }

    const state = navigationStack.pop();
    
    if (state.view === 'dashboard') {
        setElementVisible(dashboard, true, 'block');
        setElementVisible(detailsView, false);
        setElementVisible(categoryView, false);
        document.getElementById('hero-section').style.display = 'flex';
        resetUrl();
        window.scrollTo(0, state.scroll);
    } else if (state.view === 'category') {
        setElementVisible(dashboard, false);
        setElementVisible(detailsView, false);
        setElementVisible(categoryView, true, 'block');
        
        document.getElementById('category-title').textContent = state.title;
        
        if (state.title === 'My Watchlist') {
            renderWatchlistContent();
        } else {
            categoryList.innerHTML = state.html;
        }
        
        currentCategoryApiUrl = state.apiUrl;
        currentCategoryPage = state.page;
        allLoadedCategoryItems = state.items;
        
        window.scrollTo(0, state.scroll);
        resetUrl(); // Categories don't have deep links yet
    } else if (state.view === 'details') {
        openDetails(state.id, state.type, true);
    }
};

function prepareCategoryView() {
    captureAndPushState();
    setElementVisible(dashboard, false);
    setElementVisible(detailsView, false);
    setElementVisible(categoryView, true, 'block');
    setElementVisible(playerContainer, false);
    window.scrollTo(0, 0);
    // Push history for category view since captureAndPushState no longer does it
    history.pushState({view: 'category'}, '');
}

// URL Management
function updateUrl(id, type) {
    const newUrl = new URL(window.location);
    newUrl.searchParams.delete('movie');
    newUrl.searchParams.delete('tv');
    newUrl.searchParams.set(type === 'movie' ? 'movie' : 'tv', id);
    // Only push state if we are NOT navigating back/forward in history
    // This prevents creating duplicate entries when using the Back button
    window.history.pushState({view: 'details', id, type}, '', newUrl);
}

function resetUrl() {
    const newUrl = new URL(window.location);
    newUrl.searchParams.delete('movie');
    newUrl.searchParams.delete('tv');
    window.history.replaceState({}, '', newUrl.pathname);
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
