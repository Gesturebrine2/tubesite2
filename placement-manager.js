// ============================================
// UNIFIED PLACEMENT SYSTEM - CROSS-TAB SYNC
// ============================================

const PLACEMENT_CONFIG = {
    // Timing settings (milliseconds)
    NON_LINK_MIN_DELAY: 30000,      // 30 seconds
    NON_LINK_MAX_DELAY: 60000,      // 60 seconds
    SHORTS_INTERVAL_MIN: 30000,     // 30 seconds
    SHORTS_INTERVAL_MAX: 50000,     // 50 seconds
    
    // Storage
    STORAGE_KEY: 'placement_state_v3',
    TAB_KEY: 'placement_active_tabs',
    
    // Page types
    PAGE_TYPES: {
        INDEX: 'index',
        VIDEO: 'video',
        SHORTS: 'shorts',
        UPLOAD: 'upload',
        OTHER: 'other'
    }
};

class PlacementManager {
    constructor() {
        this.state = null;
        this.pageType = this.detectPageType();
        this.currentUrl = window.location.href;
        this.isNewTab = window.opener !== null;
        this.tabId = null;
        this.parentTabId = null;
        this.videoProgress = 0;
        this.clickCount = 0;
        this.lastClickTime = 0;
        this.placementUrls = [];
        this.isProcessing = false;
        
        // Initialize
        this.init();
    }
    
    async init() {
        // Get or create tab ID
        this.tabId = await this.getTabId();
        
        // Load placement URLs from global config
        this.loadPlacementUrls();
        
        // Register this tab
        this.registerTab();
        
        // Load state (sync across tabs)
        this.loadState();
        
        // Determine if we're a child tab
        this.detectParentTab();
        
        // Setup cross-tab sync
        this.setupSync();
        
        // Page-specific setup
        this.setupPageSpecific();
        
        // Start click handling
        this.setupClickHandler();
        
        console.log('[Placement] Initialized:', {
            tabId: this.tabId,
            pageType: this.pageType,
            isNewTab: this.isNewTab,
            parentTabId: this.parentTabId
        });
    }
    
    // Get unique tab ID via service worker or fallback
    async getTabId() {
        return new Promise((resolve) => {
            if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
                const channel = new MessageChannel();
                const timeout = setTimeout(() => {
                    resolve(this.fallbackTabId());
                }, 500);
                
                channel.port1.onmessage = (event) => {
                    clearTimeout(timeout);
                    if (event.data && event.data.tabId) {
                        resolve(event.data.tabId);
                    } else {
                        resolve(this.fallbackTabId());
                    }
                };
                
                navigator.serviceWorker.controller.postMessage(
                    { type: 'GET_TAB_ID' },
                    [channel.port2]
                );
            } else {
                resolve(this.fallbackTabId());
            }
        });
    }
    
    fallbackTabId() {
        return 'tab_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }
    
    // Load placement URLs from site config
    loadPlacementUrls() {
        // Try to get from global siteConfig
        if (typeof siteConfig !== 'undefined' && siteConfig.placementUrls) {
            try {
                this.placementUrls = JSON.parse(siteConfig.placementUrls);
            } catch (e) {
                console.warn('[Placement] Failed to parse placement URLs');
                this.placementUrls = [];
            }
        }
        
        // Fallback to window.placementUrls
        if (this.placementUrls.length === 0 && window.placementUrls) {
            this.placementUrls = window.placementUrls;
        }
    }
    
    // Register this tab in active tabs list
    registerTab() {
        const tabs = this.getActiveTabs();
        tabs[this.tabId] = {
            url: this.currentUrl,
            pageType: this.pageType,
            startTime: Date.now(),
            lastActive: Date.now()
        };
        this.saveActiveTabs(tabs);
    }
    
    getActiveTabs() {
        try {
            const stored = localStorage.getItem(PLACEMENT_CONFIG.TAB_KEY);
            return stored ? JSON.parse(stored) : {};
        } catch (e) {
            return {};
        }
    }
    
    saveActiveTabs(tabs) {
        try {
            localStorage.setItem(PLACEMENT_CONFIG.TAB_KEY, JSON.stringify(tabs));
        } catch (e) {
            console.error('[Placement] Failed to save tabs:', e);
        }
    }
    
    // Detect if this is a child tab (opened by another tab)
    detectParentTab() {
        const tabs = this.getActiveTabs();
        const currentTime = Date.now();
        
        // Find a tab that opened recently (within last 5 seconds) and is not us
        for (const [id, info] of Object.entries(tabs)) {
            if (id !== this.tabId && 
                (currentTime - info.lastActive) < 5000 &&
                this.isNewTab) {
                this.parentTabId = id;
                break;
            }
        }
    }
    
    // Detect page type
    detectPageType() {
        const path = window.location.pathname.toLowerCase();
        const search = window.location.search.toLowerCase();
        
        if (path.includes('shorts') || path.includes('shorts1')) {
            return PLACEMENT_CONFIG.PAGE_TYPES.SHORTS;
        }
        if (path.includes('video') || path.includes('video2') || path.includes('video5')) {
            return PLACEMENT_CONFIG.PAGE_TYPES.VIDEO;
        }
        if (path.includes('upload')) {
            return PLACEMENT_CONFIG.PAGE_TYPES.UPLOAD;
        }
        if (path.includes('index') || path === '/' || path === '/index.html') {
            return PLACEMENT_CONFIG.PAGE_TYPES.INDEX;
        }
        return PLACEMENT_CONFIG.PAGE_TYPES.OTHER;
    }
    
    // Setup cross-tab synchronization
    setupSync() {
        // Listen for storage changes (other tabs)
        window.addEventListener('storage', (e) => {
            if (e.key === PLACEMENT_CONFIG.STORAGE_KEY) {
                const newState = JSON.parse(e.newValue || '{}');
                this.syncState(newState);
            }
            
            if (e.key === PLACEMENT_CONFIG.TAB_KEY) {
                this.handleTabChange();
            }
        });
        
        // Listen for service worker messages
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.addEventListener('message', (event) => {
                if (event.data && event.data.type === 'PLACEMENT_STATE_SYNC') {
                    this.syncState(event.data.state);
                }
            });
        }
        
        // Heartbeat to keep tab active
        setInterval(() => this.heartbeat(), 5000);
        
        // Cleanup on unload
        window.addEventListener('beforeunload', () => this.unregisterTab());
    }
    
    // Sync state from another tab
    syncState(newState) {
        // Don't overwrite our own tab-specific data
        const ourTabData = this.state?.tabs?.[this.tabId];
        
        this.state = {
            ...newState,
            tabs: {
                ...(newState.tabs || {}),
                [this.tabId]: ourTabData || this.state?.tabs?.[this.tabId]
            }
        };
    }
    
    // Handle tab list changes
    handleTabChange() {
        const tabs = this.getActiveTabs();
        
        // Check if parent tab closed
        if (this.parentTabId && !tabs[this.parentTabId]) {
            console.log('[Placement] Parent tab closed, becoming master');
            this.parentTabId = null;
            // This tab is now the master
        }
    }
    
    // Heartbeat to show we're still active
    heartbeat() {
        const tabs = this.getActiveTabs();
        if (tabs[this.tabId]) {
            tabs[this.tabId].lastActive = Date.now();
            tabs[this.tabId].url = window.location.href;
            this.saveActiveTabs(tabs);
        }
        
        // Cleanup old tabs (>30 seconds inactive)
        const now = Date.now();
        let changed = false;
        for (const [id, info] of Object.entries(tabs)) {
            if (now - info.lastActive > 30000) {
                delete tabs[id];
                changed = true;
            }
        }
        if (changed) {
            this.saveActiveTabs(tabs);
        }
    }
    
    // Remove this tab from active list
    unregisterTab() {
        const tabs = this.getActiveTabs();
        delete tabs[this.tabId];
        this.saveActiveTabs(tabs);
    }
    
    // Load or initialize state
    loadState() {
        try {
            const stored = localStorage.getItem(PLACEMENT_CONFIG.STORAGE_KEY);
            if (stored) {
                this.state = JSON.parse(stored);
            }
        } catch (e) {
            console.error('[Placement] Failed to load state:', e);
        }
        
        // Initialize if needed
        if (!this.state) {
            this.state = this.createInitialState();
            this.saveState();
        }
        
        // Ensure tabs object exists
        if (!this.state.tabs) {
            this.state.tabs = {};
        }
        
        // Initialize our tab's state
        if (!this.state.tabs[this.tabId]) {
            this.state.tabs[this.tabId] = this.createTabState();
        }
        
        // Restore video progress if applicable
        this.restoreState();
    }
    
    createInitialState() {
        return {
            globalFirstClick: false,      // Has ANY tab done first click?
            globalClickCount: 0,          // Total clicks across all tabs
            lastGlobalPlacement: 0,       // Last placement timestamp
            tabs: {},                     // Per-tab state
            videoProgress: {},            // Saved video positions
            shortsScroll: {},             // Saved scroll positions
            placementIndex: 0             // Rotation index for URLs
        };
    }
    
    createTabState() {
        return {
            firstClickDone: false,
            clickCount: 0,
            lastPlacementTime: 0,
            lastNonLinkClickTime: 0,
            isMaster: !this.parentTabId,   // Is this the master tab?
            pageType: this.pageType
        };
    }
    
    // Save state to localStorage
    saveState() {
        try {
            // Update our tab's state
            if (this.state.tabs[this.tabId]) {
                this.state.tabs[this.tabId].lastPlacementTime = this.lastClickTime;
                this.state.tabs[this.tabId].clickCount = this.clickCount;
            }
            
            localStorage.setItem(PLACEMENT_CONFIG.STORAGE_KEY, JSON.stringify(this.state));
            
            // Notify service worker
            if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
                navigator.serviceWorker.controller.postMessage({
                    type: 'PLACEMENT_STATE_UPDATE',
                    state: this.state
                });
            }
        } catch (e) {
            console.error('[Placement] Failed to save state:', e);
        }
    }
    
    // Restore state from parent tab or previous session
    restoreState() {
        const tabState = this.state.tabs[this.tabId];
        
        // If we're a new tab with a parent, inherit some state
        if (this.parentTabId && this.state.tabs[this.parentTabId]) {
            const parentState = this.state.tabs[this.parentTabId];
            
            // Inherit first click status
            tabState.firstClickDone = parentState.firstClickDone;
            this.clickCount = parentState.clickCount || 0;
            
            // Restore video progress for video pages
            if (this.pageType === PLACEMENT_CONFIG.PAGE_TYPES.VIDEO) {
                this.restoreVideoProgress();
            }
            
            // Restore scroll for shorts
            if (this.pageType === PLACEMENT_CONFIG.PAGE_TYPES.SHORTS) {
                this.restoreShortsScroll();
            }
        }
    }
    
    // Setup page-specific features
    setupPageSpecific() {
        switch (this.pageType) {
            case PLACEMENT_CONFIG.PAGE_TYPES.VIDEO:
                this.setupVideoTracking();
                break;
            case PLACEMENT_CONFIG.PAGE_TYPES.SHORTS:
                this.setupShortsTracking();
                break;
        }
    }
    
    // Video progress tracking
    setupVideoTracking() {
        const video = document.getElementById('videoPlayer') || document.querySelector('video');
        if (!video) return;
        
        // Track progress
        video.addEventListener('timeupdate', () => {
            if (video.duration > 0) {
                this.videoProgress = video.currentTime / video.duration;
                
                // Save progress periodically
                if (Math.floor(video.currentTime) % 5 === 0) { // Every 5 seconds
                    this.saveVideoProgress(video.currentTime, video.duration);
                }
            }
        });
        
        // Save on pause
        video.addEventListener('pause', () => {
            this.saveVideoProgress(video.currentTime, video.duration);
        });
        
        // Try to restore immediately if metadata loaded
        if (video.readyState >= 1) {
            this.restoreVideoProgress();
        } else {
            video.addEventListener('loadedmetadata', () => {
                this.restoreVideoProgress();
            }, { once: true });
        }
    }
    
    saveVideoProgress(currentTime, duration) {
        const videoId = new URL(window.location.href).searchParams.get('id');
        if (!videoId) return;
        
        this.state.videoProgress[this.tabId] = {
            videoId: videoId,
            url: window.location.href,
            currentTime: currentTime,
            duration: duration,
            progress: currentTime / duration,
            timestamp: Date.now(),
            tabId: this.tabId
        };
        
        this.saveState();
    }
    
    restoreVideoProgress() {
        // Look for progress from parent tab or recent tabs with same video
        const videoId = new URL(window.location.href).searchParams.get('id');
        if (!videoId) return;
        
        let savedProgress = null;
        let bestTime = 0;
        
        // Check all tabs for matching video
        for (const [tabId, progress] of Object.entries(this.state.videoProgress)) {
            if (progress.videoId === videoId && progress.timestamp > bestTime) {
                savedProgress = progress;
                bestTime = progress.timestamp;
            }
        }
        
        if (savedProgress && savedProgress.currentTime > 0) {
            const video = document.getElementById('videoPlayer') || document.querySelector('video');
            if (video) {
                video.currentTime = savedProgress.currentTime;
                console.log('[Placement] Restored video to:', savedProgress.currentTime);
                
                // Show notification
                this.showResumeNotification(savedProgress.currentTime);
                
                // Auto-play if it was playing
                if (savedProgress.progress > 0 && savedProgress.progress < 0.95) {
                    video.play().catch(e => console.log('Autoplay blocked'));
                }
            }
        }
    }
    
    showResumeNotification(time) {
        // Remove existing
        const existing = document.getElementById('placement-resume-notif');
        if (existing) existing.remove();
        
        const notif = document.createElement('div');
        notif.id = 'placement-resume-notif';
        notif.style.cssText = `
            position: fixed;
            top: 80px;
            right: 20px;
            background: linear-gradient(135deg, #ff0050, #00f2ea);
            color: white;
            padding: 12px 20px;
            border-radius: 8px;
            z-index: 10000;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            font-size: 14px;
            font-weight: 600;
            box-shadow: 0 4px 20px rgba(0,0,0,0.3);
            animation: slideInRight 0.3s ease;
        `;
        notif.innerHTML = `
            <i class="fas fa-play-circle"></i> Resumed at ${this.formatTime(time)}
        `;
        
        // Add animation
        const style = document.createElement('style');
        style.textContent = `
            @keyframes slideInRight {
                from { transform: translateX(100%); opacity: 0; }
                to { transform: translateX(0); opacity: 1; }
            }
        `;
        document.head.appendChild(style);
        
        document.body.appendChild(notif);
        
        setTimeout(() => {
            notif.style.opacity = '0';
            notif.style.transform = 'translateX(100%)';
            setTimeout(() => notif.remove(), 300);
        }, 3000);
    }
    
    formatTime(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }
    
    // Shorts scroll tracking
    setupShortsTracking() {
        let scrollTimeout;
        const container = document.getElementById('video-container');
        if (!container) return;
        
        container.addEventListener('scroll', () => {
            clearTimeout(scrollTimeout);
            scrollTimeout = setTimeout(() => {
                this.state.shortsScroll[this.tabId] = {
                    url: window.location.href,
                    scrollY: container.scrollTop,
                    currentIndex: this.getCurrentShortIndex(),
                    timestamp: Date.now()
                };
                this.saveState();
            }, 500);
        }, { passive: true });
        
        // Restore scroll
        this.restoreShortsScroll();
    }
    
    getCurrentShortIndex() {
        const cards = document.querySelectorAll('.video-card');
        const container = document.getElementById('video-container');
        if (!container || cards.length === 0) return 0;
        
        const scrollPos = container.scrollTop;
        const cardHeight = cards[0].offsetHeight;
        return Math.round(scrollPos / cardHeight);
    }
    
    restoreShortsScroll() {
        // Find most recent scroll position for this URL
        const currentPath = window.location.pathname;
        let savedScroll = null;
        let bestTime = 0;
        
        for (const [tabId, scroll] of Object.entries(this.state.shortsScroll)) {
            if (scroll.url.includes(currentPath) && scroll.timestamp > bestTime) {
                savedScroll = scroll;
                bestTime = scroll.timestamp;
            }
        }
        
        if (savedScroll && savedScroll.scrollY > 0) {
            const container = document.getElementById('video-container');
            if (container) {
                setTimeout(() => {
                    container.scrollTop = savedScroll.scrollY;
                    console.log('[Placement] Restored shorts scroll to:', savedScroll.scrollY);
                }, 100);
            }
        }
    }
    
    // Main click handler
    setupClickHandler() {
        document.addEventListener('click', (e) => this.handleClick(e), true);
    }
    
    handleClick(e) {
        if (this.isProcessing) return;
        
        const clickInfo = this.analyzeClick(e.target);
        const now = Date.now();
        
        // Update click tracking
        this.clickCount++;
        this.lastClickTime = now;
        
        // Get our tab state
        const tabState = this.state.tabs[this.tabId];
        
        // Determine if we should execute placement
        const shouldExecute = this.shouldExecute(clickInfo, tabState, now);
        
        if (!shouldExecute) {
            // Normal click - just update state
            if (!clickInfo.isExempt) {
                tabState.lastNonLinkClickTime = now;
            }
            this.saveState();
            return;
        }
        
        // Execute placement
        e.preventDefault();
        e.stopPropagation();
        
        this.isProcessing = true;
        this.executePlacement(clickInfo, tabState);
        
        return false;
    }
    
    // Analyze what was clicked
    analyzeClick(target) {
        // Check for video player
        const isVideoPlayer = !!(
            target.closest('#videoPlayer') || 
            target.closest('.fluid_video_wrapper') ||
            target.closest('.video-wrapper') ||
            target.closest('video') ||
            target.closest('.fluid_controls_container')
        );
        
        // Check for play button specifically
        const isPlayButton = !!(
            target.closest('.fluid_control_play') ||
            target.closest('.fluid_button_play') ||
            target.closest('[class*="play"]') ||
            target.closest('button[aria-label*="play" i]') ||
            target.closest('button[title*="play" i]')
        );
        
        // Check for links
        const linkElement = target.closest('a');
        const isLink = !!linkElement && !!linkElement.href && !linkElement.href.startsWith('javascript:');
        const href = isLink ? linkElement.href : null;
        
        // Check for menu elements (exempt from timing)
        const isMenu = !!(
            target.closest('#sidebarMenu') ||
            target.closest('#sidebarContent') ||
            target.closest('[onclick*="toggleMenu"]') ||
            target.closest('.header-btn') ||
            target.closest('header') ||
            target.closest('button[onclick*="toggleMenu"]')
        );
        
        // Check for search elements (exempt)
        const isSearch = !!(
            target.closest('#searchInput') ||
            target.closest('#searchInputDesktop') ||
            target.closest('#mobileSearchDropdown') ||
            target.closest('[onclick*="toggleSearch"]') ||
            target.closest('[onclick*="handleSearch"]') ||
            target.closest('input[type="text"]')
        );
        
        // Check for footer
        const isFooter = !!target.closest('footer');
        
        return {
            isVideoPlayer,
            isPlayButton,
            isLink,
            href,
            isMenu,
            isSearch,
            isFooter,
            isExempt: isMenu || isSearch,
            target
        };
    }
    
    // Determine if placement should execute
    shouldExecute(clickInfo, tabState, now) {
        const globalState = this.state;
        
        // FIRST CLICK EVER (across all tabs)
        if (!globalState.globalFirstClick) {
            return true;
        }
        
        // Page-specific logic
        switch (this.pageType) {
            case PLACEMENT_CONFIG.PAGE_TYPES.INDEX:
            case PLACEMENT_CONFIG.PAGE_TYPES.UPLOAD:
                return this.shouldExecuteIndex(clickInfo, tabState, now);
                
            case PLACEMENT_CONFIG.PAGE_TYPES.VIDEO:
                return this.shouldExecuteVideo(clickInfo, tabState, now);
                
            case PLACEMENT_CONFIG.PAGE_TYPES.SHORTS:
                return this.shouldExecuteShorts(clickInfo, tabState, now);
                
            default:
                return this.shouldExecuteIndex(clickInfo, tabState, now);
        }
    }
    
    // Index page logic
    shouldExecuteIndex(clickInfo, tabState, now) {
        // Link click always executes
        if (clickInfo.isLink) {
            return true;
        }
        
        // Exempt elements (menu/search) - check timing for subsequent clicks
        if (clickInfo.isExempt) {
            // First exempt click is free, second+ needs timing
            if (tabState.clickCount <= 1) {
                return false;
            }
        }
        
        // Non-link, non-exempt click - check 30-60 second delay
        const timeSinceLast = now - (tabState.lastNonLinkClickTime || 0);
        const requiredDelay = this.getRandomDelay(
            PLACEMENT_CONFIG.NON_LINK_MIN_DELAY,
            PLACEMENT_CONFIG.NON_LINK_MAX_DELAY
        );
        
        return timeSinceLast >= requiredDelay;
    }
    
    // Video page logic
    shouldExecuteVideo(clickInfo, tabState, now) {
        // Play button never triggers placement
        if (clickInfo.isPlayButton) {
            return false;
        }
        
        // If watched 50%+ and clicked video area, execute
        if (clickInfo.isVideoPlayer && this.videoProgress >= 0.5) {
            return true;
        }
        
        // Link click - same as index
        if (clickInfo.isLink) {
            return true;
        }
        
        // Exempt elements
        if (clickInfo.isExempt) {
            if (tabState.clickCount <= 1) {
                return false;
            }
        }
        
        // Non-link click with timing
        const timeSinceLast = now - (tabState.lastNonLinkClickTime || 0);
        const requiredDelay = this.getRandomDelay(
            PLACEMENT_CONFIG.NON_LINK_MIN_DELAY,
            PLACEMENT_CONFIG.NON_LINK_MAX_DELAY
        );
        
        return timeSinceLast >= requiredDelay;
    }
    
    // Shorts page logic
    shouldExecuteShorts(clickInfo, tabState, now) {
        // Second click doesn't execute (user browsing)
        if (tabState.clickCount === 1) {
            return false;
        }
        
        // Every 30-50 seconds any click executes
        const timeSinceLast = now - (tabState.lastPlacementTime || 0);
        const requiredDelay = this.getRandomDelay(
            PLACEMENT_CONFIG.SHORTS_INTERVAL_MIN,
            PLACEMENT_CONFIG.SHORTS_INTERVAL_MAX
        );
        
        return timeSinceLast >= requiredDelay;
    }
    
    getRandomDelay(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }
    
    // Execute placement redirect
    executePlacement(clickInfo, tabState) {
        const now = Date.now();
        const targetUrl = this.getPlacementUrl();
        
        // Determine what to open in new tab
        let newTabUrl;
        
        if (!this.state.globalFirstClick) {
            // VERY FIRST CLICK: Open current page in new tab
            newTabUrl = window.location.href;
            this.state.globalFirstClick = true;
        } else if (clickInfo.isLink && clickInfo.href) {
            // Link click: Open the link in new tab
            newTabUrl = clickInfo.href;
        } else {
            // Other click: Open current page in new tab (to continue session)
            newTabUrl = window.location.href;
        }
        
        // Update state BEFORE redirect
        tabState.firstClickDone = true;
        tabState.lastPlacementTime = now;
        this.state.globalClickCount++;
        this.state.lastGlobalPlacement = now;
        
        if (!clickInfo.isLink && !clickInfo.isExempt) {
            tabState.lastNonLinkClickTime = now;
        }
        
        // Mark that we're about to redirect (for child tab detection)
        tabState.isRedirecting = true;
        tabState.redirectTime = now;
        
        this.saveState();
        
        console.log('[Placement] Executing:', {
            newTabUrl,
            targetUrl,
            clickInfo
        });
        
        // Open new tab FIRST (before we lose control)
        const newTab = window.open(newTabUrl, '_blank');
        
        // Then redirect current tab
        window.location.href = targetUrl;
        
        // Fallback if popup blocked
        if (!newTab || newTab.closed || typeof newTab.closed === 'undefined') {
            console.warn('[Placement] Popup blocked, attempting fallback...');
            
            // Try again
            setTimeout(() => {
                const retry = window.open(newTabUrl, '_blank');
                if (!retry) {
                    console.error('[Placement] Popup blocked, user must allow popups');
                    // Show message to user
                    alert('Please allow popups for this site to continue');
                }
            }, 100);
        }
    }
    
    getPlacementUrl() {
        if (this.placementUrls.length === 0) {
            return window.location.href;
        }
        
        const index = this.state.placementIndex || 0;
        const url = this.placementUrls[index % this.placementUrls.length];
        
        this.state.placementIndex = (index + 1) % this.placementUrls.length;
        
        return url;
    }
    
    // Debug/reset methods
    reset() {
        localStorage.removeItem(PLACEMENT_CONFIG.STORAGE_KEY);
        localStorage.removeItem(PLACEMENT_CONFIG.TAB_KEY);
        console.log('[Placement] State reset');
        window.location.reload();
    }
    
    getDebugInfo() {
        return {
            tabId: this.tabId,
            pageType: this.pageType,
            isNewTab: this.isNewTab,
            parentTabId: this.parentTabId,
            state: this.state,
            clickCount: this.clickCount,
            videoProgress: this.videoProgress
        };
    }
}

// ============================================
// INITIALIZATION
// ============================================

function initPlacementManager() {
    // Wait for site config to load if it exists
    if (typeof siteConfig !== 'undefined') {
        window.placementManager = new PlacementManager();
    } else {
        // Retry after short delay
        setTimeout(initPlacementManager, 100);
    }
}

// Start when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPlacementManager);
} else {
    initPlacementManager();
}

// Expose for debugging
window.PlacementDebug = {
    reset: () => window.placementManager?.reset(),
    info: () => console.log(window.placementManager?.getDebugInfo()),
    state: () => window.placementManager?.state
};
