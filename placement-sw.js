// placement-sw.js - Service Worker for cross-tab placement tracking
const CACHE_NAME = 'placement-v1';

self.addEventListener('install', (e) => {
    console.log('[SW] Installing...');
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    console.log('[SW] Activating...');
    e.waitUntil(clients.claim());
});

// Handle messages from pages
self.addEventListener('message', (event) => {
    if (!event.data) return;
    
    console.log('[SW] Received message:', event.data.type);
    
    if (event.data.type === 'PLACEMENT_STATE_UPDATE') {
        // Broadcast to all clients except sender
        event.waitUntil(
            self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
                clients.forEach((client) => {
                    if (client.id !== event.source.id) {
                        client.postMessage({
                            type: 'PLACEMENT_STATE_SYNC',
                            state: event.data.state,
                            timestamp: Date.now()
                        });
                    }
                });
            })
        );
    }
    
    if (event.data.type === 'GET_TAB_ID') {
        // Respond with unique tab ID
        event.source.postMessage({
            type: 'TAB_ID_RESPONSE',
            tabId: 'tab_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9)
        });
    }
});
