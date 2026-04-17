// ============================================
// SIMPLIFIED PLACEMENT SYSTEM v2.0
// No Service Workers - Uses localStorage + window.open()
// ============================================

const PlacementManager = (function() {
    'use strict';
    
    // Configuration
    const CONFIG = {
        STORAGE_KEY: 'placement_data_v2',
        FIRST_CLICK_DELAY: 100,      // ms after first click
        LINK_CLICK_DELAY: 50,        // ms for link clicks
        NON_LINK_MIN_DELAY: 30000,    // 30 seconds min
        NON_LINK_MAX_DELAY: 60000,    // 60 seconds max
        SHORTS_SCROLL_MIN: 3,         // min scrolls before placement
        SHORTS_SCROLL_MAX: 5,         // max scrolls before placement
        VIDEO_WATCH_THRESHOLD: 0.5,   // 50% watched
    };

    // State
    let state = {
        firstClickDone: false,
        lastPlacementTime: 0,
        clickCount: 0,
        lastNonLinkClick: 0,
        shortsScrollCount: 0,
        videoProgress: 0,
        isProcessing: false
    };

    // Placement URLs from site config
    let placementUrls = [];
    let currentUrlIndex = 0;

    // Page type detection
    function getPageType() {
        const path = window.location.pathname.toLowerCase();
        const search = window.location.search.toLowerCase();
        
        if (path.includes('shorts')) return 'shorts';
        if (path.includes('video')) return 'video';
        if (path.includes('upload')) return 'upload';
        if (path === '/' || path.includes('index')) return 'index';
        return 'other';
    }

    // Load placement URLs
    function loadPlacementUrls() {
        // Try global siteConfig first
        if (typeof window.siteConfig !== 'undefined' && window.siteConfig.placementUrls) {
            try {
                const urls = JSON.parse(window.siteConfig.placementUrls);
                if (Array.isArray(urls) && urls.length > 0) {
                    placementUrls = urls;
                    console.log('[Placement] Loaded', placementUrls.length, 'URLs from siteConfig');
                    return;
                }
            } catch (e) {
                console.warn('[Placement] Failed to parse siteConfig.placementUrls');
            }
        }
        
        // Fallback to window.placementUrls
        if (window.placementUrls && Array.isArray(window.placementUrls)) {
            placementUrls = window.placementUrls;
            console.log('[Placement] Loaded', placementUrls.length, 'URLs from global');
        }
    }

    // Get next placement URL (round-robin)
    function getNextPlacementUrl() {
        if (placementUrls.length === 0) return null;
        const url = placementUrls[currentUrlIndex % placementUrls.length];
        currentUrlIndex++;
        return url;
    }

    // Save state to localStorage
    function saveState() {
        try {
            localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify({
                firstClickDone: state.firstClickDone,
                lastPlacementTime: state.lastPlacementTime,
                currentUrlIndex: currentUrlIndex,
                timestamp: Date.now()
            }));
        } catch (e) {
            console.warn('[Placement] Failed to save state');
        }
    }

    // Load state from localStorage
    function loadState() {
        try {
            const stored = localStorage.getItem(CONFIG.STORAGE_KEY);
            if (stored) {
                const data = JSON.parse(stored);
                // Only use if less than 30 minutes old
                if (Date.now() - data.timestamp < 30 * 60 * 1000) {
                    state.firstClickDone = data.firstClickDone || false;
                    state.lastPlacementTime = data.lastPlacementTime || 0;
                    currentUrlIndex = data.currentUrlIndex || 0;
                }
            }
        } catch (e) {
            console.warn('[Placement] Failed to load state');
        }
    }

    // Check if element is exempt from placement
    function isExemptElement(target) {
        // Check for form elements, inputs, etc.
        const tagName = target.tagName.toLowerCase();
        if (['input', 'textarea', 'select', 'button'].includes(tagName)) return true;
        
        // Check for specific roles
        if (target.closest('form')) return true;
        if (target.closest('input')) return true;
        
        // Check for header/menu elements
        if (target.closest('header')) return true;
        if (target.closest('.header')) return true;
        if (target.closest('nav')) return true;
        
        // Check for search elements
        if (target.closest('[id*="search"]')) return true;
        if (target.closest('[class*="search"]')) return true;
        
        return false;
    }

    // Check if click is on video play button
    function isPlayButton(target) {
        const classes = target.className || '';
        const parentClasses = target.parentElement?.className || '';
        
        return classes.includes('play') || 
               parentClasses.includes('play') ||
               target.closest('[class*="play"]') ||
               target.closest('button[title*="play" i]') ||
               target.closest('button[aria-label*="play" i]');
    }

    // Check if click is on a link
    function isLinkClick(target) {
        const link = target.closest('a');
        return link && link.href && !link.href.startsWith('javascript:');
    }

    // Execute placement redirect
    function executePlacement(clickTarget, isLink) {
        if (state.isProcessing) return;
        state.isProcessing = true;
        
        const placementUrl = getNextPlacementUrl();
        if (!placementUrl) {
            console.warn('[Placement] No placement URLs configured');
            state.isProcessing = false;
            return;
        }

        // Determine what to open in new tab
        let newTabUrl;
        
        if (!state.firstClickDone) {
            // First click ever: open current page in new tab
            newTabUrl = window.location.href;
            state.firstClickDone = true;
        } else if (isLink) {
            // Link click: open the link in new tab
            const link = clickTarget.closest('a');
            newTabUrl = link.href;
        } else {
            // Other click: open current page in new tab
            newTabUrl = window.location.href;
        }

        // Update state
        state.lastPlacementTime = Date.now();
        state.clickCount++;
        saveState();

        console.log('[Placement] Executing:', {
            newTabUrl: newTabUrl.substring(0, 100),
            placementUrl: placementUrl.substring(0, 100)
        });

        // CRITICAL: Open new tab FIRST (before we lose control)
        const newTab = window.open(newTabUrl, '_blank');
        
        // Then redirect current tab
        window.location.href = placementUrl;

        // Fallback if popup blocked
        if (!newTab || newTab.closed || typeof newTab.closed === 'undefined') {
            console.warn('[Placement] Popup may be blocked');
            // Still redirect current tab - user can use back button
            setTimeout(() => {
                window.location.href = placementUrl;
            }, 100);
        }
    }

    // Should we execute placement?
    function shouldExecute(event) {
        const pageType = getPageType();
        const target = event.target;
        const now = Date.now();
        
        // Never execute if already processing
        if (state.isProcessing) return false;
        
        // Check for exempt elements
        if (isExemptElement(target)) {
            console.log('[Placement] Exempt element clicked');
            return false;
        }

        const isLink = isLinkClick(target);
        const isPlay = isPlayButton(target);

        // FIRST CLICK - Always execute (except exempt elements)
        if (!state.firstClickDone) {
            console.log('[Placement] First click detected');
            return true;
        }

        // Page-specific logic
        switch (pageType) {
            case 'video':
                // Video page logic
                if (isPlay) {
                    // Play button - don't execute, just play
                    return false;
                }
                
                if (isLink) {
                    // Link click - execute immediately
                    return true;
                }
                
                // Non-link click - check timing (30-60s)
                const timeSinceLast = now - state.lastNonLinkClick;
                const requiredDelay = Math.floor(
                    Math.random() * (CONFIG.NON_LINK_MAX_DELAY - CONFIG.NON_LINK_MIN_DELAY) + 
                    CONFIG.NON_LINK_MIN_DELAY
                );
                
                if (timeSinceLast >= requiredDelay) {
                    state.lastNonLinkClick = now;
                    return true;
                }
                return false;

            case 'shorts':
                // Shorts page logic - scroll-based
                if (state.shortsScrollCount === 0) {
                    // First interaction on shorts
                    state.shortsScrollCount++;
                    return true;
                }
                
                // Check scroll count
                if (state.shortsScrollCount >= Math.floor(
                    Math.random() * (CONFIG.SHORTS_SCROLL_MAX - CONFIG.SHORTS_SCROLL_MIN) + 
                    CONFIG.SHORTS_SCROLL_MIN
                )) {
                    state.shortsScrollCount = 0; // Reset
                    return true;
                }
                
                state.shortsScrollCount++;
                return false;

            case 'index':
            case 'upload':
            default:
                // Standard page logic
                if (isLink) {
                    return true;
                }
                
                // Non-link click - check timing
                const timeSince = now - state.lastNonLinkClick;
                const delay = Math.floor(
                    Math.random() * (CONFIG.NON_LINK_MAX_DELAY - CONFIG.NON_LINK_MIN_DELAY) + 
                    CONFIG.NON_LINK_MIN_DELAY
                );
                
                if (timeSince >= delay) {
                    state.lastNonLinkClick = now;
                    return true;
                }
                return false;
        }
    }

    // Handle click events
    function handleClick(event) {
        // Quick checks first
        if (event.button !== 0) return; // Only left clicks
        
        if (!shouldExecute(event)) return;

        // Execute placement
        event.preventDefault();
        event.stopPropagation();
        
        const isLink = isLinkClick(event.target);
        executePlacement(event.target, isLink);
        
        return false;
    }

    // Track video progress for video pages
    function trackVideoProgress() {
        const video = document.querySelector('video');
        if (!video) return;

        video.addEventListener('timeupdate', () => {
            if (video.duration > 0) {
                state.videoProgress = video.currentTime / video.duration;
            }
        });
    }

    // Track scrolls for shorts page
    function trackShortsScrolls() {
        if (getPageType() !== 'shorts') return;
        
        const container = document.getElementById('video-container') || window;
        let lastScroll = 0;
        
        container.addEventListener('scroll', () => {
            const currentScroll = container.scrollTop || window.scrollY;
            if (Math.abs(currentScroll - lastScroll) > 100) {
                state.shortsScrollCount++;
                lastScroll = currentScroll;
                console.log('[Placement] Shorts scroll count:', state.shortsScrollCount);
            }
        }, { passive: true });
    }

    // Initialize
    function init() {
        console.log('[Placement] Initializing...');
        
        loadPlacementUrls();
        loadState();
        
        // Delay to let page load
        setTimeout(() => {
            // Add click listener to document
            document.addEventListener('click', handleClick, true);
            
            // Page-specific tracking
            trackVideoProgress();
            trackShortsScrolls();
            
            console.log('[Placement] Active on', getPageType(), 'page');
        }, 500);
    }

    // Public API
    return {
        init: init,
        reset: function() {
            localStorage.removeItem(CONFIG.STORAGE_KEY);
            location.reload();
        },
        debug: function() {
            return {
                state: state,
                placementUrls: placementUrls,
                pageType: getPageType()
            };
        }
    };
})();

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', PlacementManager.init);
} else {
    PlacementManager.init();
}

// Expose for debugging
window.PlacementDebug = PlacementManager;
