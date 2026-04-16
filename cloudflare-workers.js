// ==================== CLOUDFLARE WORKER + D1 + R2 ====================
// Complete Backend with Creator System, Admin Config, and Analytics

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;
        const method = request.method;

        // CORS Headers
        const corsHeaders = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Session-Id, X-Creator-Token",
        };

        if (method === "OPTIONS") {
            return new Response(null, { status: 204, headers: corsHeaders });
        }

        const jsonResponse = (data, status = 200) => 
            new Response(JSON.stringify(data), { 
                status, 
                headers: { ...corsHeaders, "Content-Type": "application/json" } 
            });

        const errorResponse = (message, status = 400) => 
            jsonResponse({ error: message, status, timestamp: new Date().toISOString() }, status);

        // Auth checks
        const checkAdminAuth = () => {
            const auth = request.headers.get("Authorization")?.replace("Bearer ", "");
            return auth === env.ADMIN_TOKEN;
        };

        const checkCreatorAuth = async () => {
            const token = request.headers.get("X-Creator-Token");
            if (!token) return null;
            
            const creator = await env.DB.prepare(
                "SELECT * FROM creators WHERE token = ? AND status = 'approved'"
            ).bind(token).first();
            
            return creator;
        };

        const getSessionId = () => 
            request.headers.get("X-Session-Id") || crypto.randomUUID();

        const getClientIP = () => 
            request.headers.get("X-Forwarded-For")?.split(",")[0] || "unknown";

        try {
            // ==================== PUBLIC CONFIG ENDPOINTS ====================
            
            // Get site configuration (public)
            if (path === "/api/config" && method === "GET") {
                const config = await env.DB.prepare(
                    "SELECT siteName, siteLogo, vastTagUrl, placementUrls, outstreamAdTags, primaryColor FROM site_config ORDER BY id DESC LIMIT 1"
                ).first();
                
                return jsonResponse(config || {
                    siteName: "Xplitleaks",
                    siteLogo: null,
                    vastTagUrl: null,
                    placementUrls: [],
                    outstreamAdTags: [],
                    primaryColor: "#ff0050"
                });
            }

            // ==================== AUTHENTICATION ====================
            
            // Creator signup
            if (path === "/api/creator/signup" && method === "POST") {
                const data = await request.json().catch(() => ({}));
                
                if (!data.username || !data.email || !data.password) {
                    return errorResponse("Username, email, and password required", 400);
                }

                // Check if exists
                const existing = await env.DB.prepare(
                    "SELECT * FROM creators WHERE email = ? OR username = ?"
                ).bind(data.email, data.username).first();
                
                if (existing) {
                    return errorResponse("Email or username already exists", 409);
                }

                const token = crypto.randomUUID();
                const now = new Date().toISOString();
                
                await env.DB.prepare(`
                    INSERT INTO creators (id, username, email, password, token, status, createdAt, updatedAt)
                    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
                `).bind(
                    crypto.randomUUID(),
                    data.username,
                    data.email,
                    data.password, // In production, hash this
                    token,
                    now,
                    now
                ).run();

                return jsonResponse({ 
                    success: true, 
                    message: "Signup successful. Waiting for admin approval.",
                    token 
                });
            }

            // Creator login
            if (path === "/api/creator/login" && method === "POST") {
                const data = await request.json().catch(() => ({}));
                
                const creator = await env.DB.prepare(
                    "SELECT * FROM creators WHERE (email = ? OR username = ?) AND password = ? AND status = 'approved'"
                ).bind(data.email || data.username, data.username || data.email, data.password).first();
                
                if (!creator) {
                    return errorResponse("Invalid credentials or account not approved", 401);
                }

                // Update last login
                await env.DB.prepare(
                    "UPDATE creators SET lastLogin = datetime('now') WHERE id = ?"
                ).bind(creator.id).run();

                return jsonResponse({
                    success: true,
                    token: creator.token,
                    username: creator.username,
                    email: creator.email
                });
            }

            // Get creator profile
            if (path === "/api/creator/profile" && method === "GET") {
                const creator = await checkCreatorAuth();
                if (!creator) return errorResponse("Unauthorized", 401);
                
                // Get stats
                const videoCount = await env.DB.prepare(
                    "SELECT COUNT(*) as count FROM videos WHERE creatorId = ?"
                ).bind(creator.id).first();
                
                const shortCount = await env.DB.prepare(
                    "SELECT COUNT(*) as count FROM shorts WHERE creatorId = ?"
                ).bind(creator.id).first();
                
                const totalViews = await env.DB.prepare(`
                    SELECT COALESCE(SUM(views), 0) as views 
                    FROM videos WHERE creatorId = ?
                `).bind(creator.id).first();
                
                return jsonResponse({
                    ...creator,
                    password: undefined,
                    stats: {
                        videos: videoCount?.count || 0,
                        shorts: shortCount?.count || 0,
                        totalViews: totalViews?.views || 0
                    }
                });
            }

            // ==================== PUBLIC VIDEO ENDPOINTS ====================

            // Health check
            if (path === "/api/health" && method === "GET") {
                return jsonResponse({ 
                    status: "ok", 
                    ts: Date.now(), 
                    platform: "cloudflare-all-in-one"
                });
            }

            // Get videos with pagination
            if (path === "/api/videos" && method === "GET") {
                const page = Math.max(1, parseInt(url.searchParams.get("page")) || 1);
                const limit = Math.min(50, parseInt(url.searchParams.get("limit")) || 12);
                const offset = (page - 1) * limit;
                const search = url.searchParams.get("search");
                const category = url.searchParams.get("category");
                const tag = url.searchParams.get("tag");
                
                let whereClause = "WHERE status = 'active'";
                let params = [];
                
                if (search) {
                    whereClause += " AND (title LIKE ? OR description LIKE ?)";
                    params.push(`%${search}%`, `%${search}%`);
                }
                
                if (category && category !== 'all') {
                    whereClause += " AND category = ?";
                    params.push(category);
                }
                
                if (tag && tag !== 'all') {
                    whereClause += " AND tags LIKE ?";
                    params.push(`%${tag}%`);
                }

                // Get total count
                const countResult = await env.DB.prepare(
                    `SELECT COUNT(*) as total FROM videos ${whereClause}`
                ).bind(...params).first();
                
                // Get videos
                const { results } = await env.DB.prepare(`
                    SELECT v.*, c.username as creatorName 
                    FROM videos v 
                    LEFT JOIN creators c ON v.creatorId = c.id 
                    ${whereClause} 
                    ORDER BY v.addedAt DESC 
                    LIMIT ? OFFSET ?
                `).bind(...params, limit, offset).all();

                return jsonResponse({
                    videos: results || [],
                    pagination: {
                        page,
                        limit,
                        total: countResult?.total || 0,
                        totalPages: Math.ceil((countResult?.total || 0) / limit)
                    }
                });
            }

            // Get single video
            if (path.match(/^\/api\/video\/[a-zA-Z0-9_-]+$/) && method === "GET") {
                const id = path.split("/")[3];
                const video = await env.DB.prepare(`
                    SELECT v.*, c.username as creatorName 
                    FROM videos v 
                    LEFT JOIN creators c ON v.creatorId = c.id 
                    WHERE (v.numericId = ? OR v.id = ?) AND v.status = 'active'
                `).bind(id, id).first();
                
                if (!video) return errorResponse("Video not found", 404);
                
                // Track view asynchronously
                ctx.waitUntil(
                    env.DB.prepare("UPDATE videos SET views = views + 1 WHERE numericId = ?")
                        .bind(id).run()
                );
                
                return jsonResponse(video);
            }

            // Track video view (detailed)
            if (path === "/api/video/view" && method === "POST") {
                const { videoId, watchDuration } = await request.json().catch(() => ({}));
                const sessionId = getSessionId();
                
                if (!videoId) return errorResponse("Video ID required", 400);

                await env.DB.prepare(`
                    INSERT INTO video_views (videoId, sessionId, watchDuration, ipAddress, viewedAt)
                    VALUES (?, ?, ?, ?, datetime('now'))
                `).bind(videoId, sessionId, watchDuration || 0, getClientIP()).run();

                return jsonResponse({ success: true });
            }

            // Get shorts with pagination and recommendation
            if (path === "/api/shorts" && method === "GET") {
                const page = Math.max(1, parseInt(url.searchParams.get("page")) || 1);
                const limit = Math.min(20, parseInt(url.searchParams.get("limit")) || 6);
                const offset = (page - 1) * limit;
                const sessionId = url.searchParams.get("sessionId") || getSessionId();
                const excludeIds = url.searchParams.get("exclude")?.split(",") || [];
                
                // Get recommendation scores if session exists
                const { results } = await env.DB.prepare(`
                    SELECT s.*, c.username as creatorName,
                           CASE 
                               WHEN sh.tags IS NOT NULL THEN 
                                   (SELECT COUNT(*) FROM json_each(s.tags) 
                                    WHERE value IN (SELECT value FROM json_each(sh.tags)))
                               ELSE 0 
                           END as tagMatchScore
                    FROM shorts s
                    LEFT JOIN creators c ON s.creatorId = c.id
                    LEFT JOIN session_history sh ON sh.sessionId = ? AND sh.shortId = s.numericId
                    WHERE s.status = 'active' 
                    AND s.numericId NOT IN (${excludeIds.length > 0 ? excludeIds.map(() => '?').join(',') : "''"})
                    ORDER BY tagMatchScore DESC, s.engagementScore DESC, s.views DESC
                    LIMIT ? OFFSET ?
                `).bind(sessionId, ...excludeIds, limit, offset).all();

                return jsonResponse({
                    shorts: results || [],
                    pagination: { page, limit, offset }
                });
            }

            // Get recommended shorts (algorithm)
            if (path === "/api/shorts/recommend" && method === "GET") {
                const sessionId = url.searchParams.get("sessionId") || getSessionId();
                const limit = parseInt(url.searchParams.get("limit")) || 20;
                const excludeIds = url.searchParams.get("exclude")?.split(",") || [];
                
                // Get user history
                let userHistory = { tags: {}, categories: {}, watchedIds: [] };
                try {
                    const history = await env.DB.prepare(`
                        SELECT tags, category, shortId, watchDuration 
                        FROM session_history 
                        WHERE sessionId = ? 
                        ORDER BY watchedAt DESC 
                        LIMIT 20
                    `).bind(sessionId).all();
                    
                    if (history.results) {
                        history.results.forEach((item, index) => {
                            const weight = Math.max(0.1, 1 - (index * 0.05));
                            if (item.tags) {
                                try {
                                    const tags = JSON.parse(item.tags);
                                    tags.forEach(tag => {
                                        userHistory.tags[tag] = (userHistory.tags[tag] || 0) + weight;
                                    });
                                } catch (e) {}
                            }
                            if (item.category) {
                                userHistory.categories[item.category] = 
                                    (userHistory.categories[item.category] || 0) + weight;
                            }
                            userHistory.watchedIds.push(item.shortId);
                        });
                    }
                } catch (e) {
                    console.error("History error:", e);
                }

                // Fetch candidates
                const excludePlaceholders = excludeIds.length > 0 
                    ? excludeIds.map(() => '?').join(',') 
                    : "''";
                    
                const { results } = await env.DB.prepare(`
                    SELECT s.*, c.username as creatorName,
                           (s.likes * 2 + s.shares * 3) / MAX(s.views, 1) as engagementRate,
                           julianday('now') - julianday(s.uploadDate) as ageDays
                    FROM shorts s
                    LEFT JOIN creators c ON s.creatorId = c.id
                    WHERE s.status = 'active' 
                    AND s.numericId NOT IN (${excludePlaceholders})
                    AND s.numericId NOT IN (SELECT value FROM json_array(${userHistory.watchedIds.length > 0 ? userHistory.watchedIds.map(() => '?').join(',') : "''"}))
                    ORDER BY s.addedAt DESC
                    LIMIT 100
                `).bind(...excludeIds, ...userHistory.watchedIds).all();

                if (!results || results.length === 0) {
                    return jsonResponse([]);
                }

                // Score and diversify
                const scored = results.map(short => {
                    let tagScore = 0;
                    let categoryScore = 0;
                    
                    try {
                        const tags = short.tags ? JSON.parse(short.tags) : [];
                        if (tags.length > 0 && Object.keys(userHistory.tags).length > 0) {
                            const matchCount = tags.filter(t => userHistory.tags[t]).length;
                            tagScore = matchCount / tags.length;
                        }
                    } catch (e) {}
                    
                    if (short.category && userHistory.categories[short.category]) {
                        categoryScore = Math.min(userHistory.categories[short.category], 1);
                    }
                    
                    const engagementScore = Math.min(short.engagementRate || 0, 1);
                    const recencyScore = short.ageDays <= 7 ? 1.0 : 
                                        short.ageDays <= 30 ? 0.7 : 0.4;
                    
                    const hasHistory = Object.keys(userHistory.tags).length > 0;
                    
                    const finalScore = hasHistory ? 
                        (tagScore * 0.45) + (categoryScore * 0.20) + 
                        (engagementScore * 0.20) + (recencyScore * 0.15) :
                        (engagementScore * 0.40) + (recencyScore * 0.35) + (Math.random() * 0.25);
                    
                    return { ...short, score: finalScore };
                });

                // Diversify - limit same creator
                const diversified = [];
                const creatorCount = {};
                
                for (const short of scored.sort((a, b) => b.score - a.score)) {
                    creatorCount[short.creatorId || 'unknown'] = 
                        (creatorCount[short.creatorId || 'unknown'] || 0) + 1;
                    
                    if (creatorCount[short.creatorId || 'unknown'] <= 3) {
                        diversified.push(short);
                    }
                    
                    if (diversified.length >= limit) break;
                }

                return jsonResponse(diversified);
            }

            // Get single short
            if (path.match(/^\/api\/short\/[a-zA-Z0-9_-]+$/) && method === "GET") {
                const id = path.split("/")[3];
                const short = await env.DB.prepare(`
                    SELECT s.*, c.username as creatorName 
                    FROM shorts s 
                    LEFT JOIN creators c ON s.creatorId = c.id 
                    WHERE (s.numericId = ? OR s.id = ?) AND s.status = 'active'
                `).bind(id, id).first();
                
                if (!short) return errorResponse("Short not found", 404);
                
                ctx.waitUntil(
                    env.DB.prepare("UPDATE shorts SET views = views + 1 WHERE numericId = ?")
                        .bind(id).run()
                );
                
                return jsonResponse(short);
            }

            // Get tags
            if (path === "/api/tags" && method === "GET") {
                const { results } = await env.DB.prepare(
                    "SELECT * FROM tags ORDER BY usageCount DESC LIMIT 100"
                ).all();
                return jsonResponse(results || []);
            }

            // ==================== PROTECTED CREATOR ENDPOINTS ====================

            // Creator upload video
            if (path === "/api/creator/upload/video" && method === "POST") {
                const creator = await checkCreatorAuth();
                if (!creator) return errorResponse("Unauthorized", 401);
                
                const data = await request.json().catch(() => ({}));
                
                if (!data.title || !data.videoUrl) {
                    return errorResponse("Title and videoUrl required", 400);
                }

                const numericIdResult = await env.DB.prepare(
                    "SELECT MAX(CAST(numericId AS INTEGER)) as maxId FROM videos"
                ).first();
                const maxId = numericIdResult?.maxId || 0;
                const numericId = String(maxId + 1).padStart(6, "0");
                const urlFriendlyId = data.title.toLowerCase()
                    .replace(/[^a-z0-9]+/g, "-")
                    .substring(0, 50) || `video-${numericId}`;
                const now = new Date().toISOString();

                await env.DB.prepare(`
                    INSERT INTO videos (
                        id, numericId, title, videoUrl, thumbnail, duration, 
                        category, tags, description, creatorId, uploadDate, 
                        type, views, status, addedAt, updatedAt
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'active', ?, ?)
                `).bind(
                    urlFriendlyId, numericId, data.title, data.videoUrl,
                    data.thumbnail || "", data.duration || "0:00",
                    data.category || "uncategorized", JSON.stringify(data.tags || []),
                    data.description || "", creator.id,
                    data.uploadDate || now.split("T")[0], 'r2', now, now
                ).run();

                // Update tag counts
                if (data.tags && Array.isArray(data.tags)) {
                    for (const tag of data.tags) {
                        await env.DB.prepare(`
                            INSERT INTO tags (name, usageCount) 
                            VALUES (?, 1) 
                            ON CONFLICT(name) DO UPDATE SET usageCount = usageCount + 1
                        `).bind(tag.toLowerCase()).run();
                    }
                }

                return jsonResponse({ success: true, numericId, id: urlFriendlyId });
            }

            // Creator upload short
            if (path === "/api/creator/upload/short" && method === "POST") {
                const creator = await checkCreatorAuth();
                if (!creator) return errorResponse("Unauthorized", 401);
                
                const data = await request.json().catch(() => ({}));
                
                if (!data.title || !data.videoUrl) {
                    return errorResponse("Title and videoUrl required", 400);
                }

                const numericIdResult = await env.DB.prepare(
                    "SELECT MAX(CAST(numericId AS INTEGER)) as maxId FROM shorts"
                ).first();
                const maxId = numericIdResult?.maxId || 0;
                const numericId = String(maxId + 1).padStart(6, "0");
                const now = new Date().toISOString();

                await env.DB.prepare(`
                    INSERT INTO shorts (
                        id, numericId, title, videoUrl, thumbnail, duration,
                        category, tags, creatorId, uploadDate, views, likes, shares,
                        engagementScore, status, addedAt, updatedAt
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0.0, 'active', ?, ?)
                `).bind(
                    `short-${numericId}`, numericId, data.title, data.videoUrl,
                    data.thumbnail || "", data.duration || "0:00",
                    data.category || "uncategorized", JSON.stringify(data.tags || []),
                    creator.id, data.uploadDate || now.split("T")[0], now, now
                ).run();

                if (data.tags && Array.isArray(data.tags)) {
                    for (const tag of data.tags) {
                        await env.DB.prepare(`
                            INSERT INTO tags (name, usageCount) 
                            VALUES (?, 1) 
                            ON CONFLICT(name) DO UPDATE SET usageCount = usageCount + 1
                        `).bind(tag.toLowerCase()).run();
                    }
                }

                return jsonResponse({ success: true, numericId });
            }

            // Get creator's content
            if (path === "/api/creator/content" && method === "GET") {
                const creator = await checkCreatorAuth();
                if (!creator) return errorResponse("Unauthorized", 401);
                
                const type = url.searchParams.get("type") || "all";
                
                let videos = [], shorts = [];
                
                if (type === 'all' || type === 'videos') {
                    const { results } = await env.DB.prepare(`
                        SELECT * FROM videos WHERE creatorId = ? ORDER BY addedAt DESC
                    `).bind(creator.id).all();
                    videos = results || [];
                }
                
                if (type === 'all' || type === 'shorts') {
                    const { results } = await env.DB.prepare(`
                        SELECT * FROM shorts WHERE creatorId = ? ORDER BY addedAt DESC
                    `).bind(creator.id).all();
                    shorts = results || [];
                }
                
                return jsonResponse({ videos, shorts });
            }

            // ==================== ADMIN ENDPOINTS ====================

            if (!checkAdminAuth()) {
                return errorResponse("Unauthorized", 401);
            }

            // Get admin stats
            if (path === "/api/admin/stats" && method === "GET") {
                const period = url.searchParams.get("period") || '7d';
                
                const videoCount = await env.DB.prepare(
                    "SELECT COUNT(*) as count FROM videos WHERE status = 'active'"
                ).first();
                
                const shortCount = await env.DB.prepare(
                    "SELECT COUNT(*) as count FROM shorts WHERE status = 'active'"
                ).first();
                
                const tagCount = await env.DB.prepare(
                    "SELECT COUNT(*) as count FROM tags"
                ).first();
                
                const creatorCount = await env.DB.prepare(
                    "SELECT COUNT(*) as count FROM creators WHERE status = 'approved'"
                ).first();
                
                const pendingCreators = await env.DB.prepare(
                    "SELECT COUNT(*) as count FROM creators WHERE status = 'pending'"
                ).first();
                
                const totalViews = await env.DB.prepare(`
                    SELECT COALESCE(SUM(views), 0) as views 
                    FROM videos WHERE status = 'active'
                `).first();
                
                const totalShortViews = await env.DB.prepare(`
                    SELECT COALESCE(SUM(views), 0) as views 
                    FROM shorts WHERE status = 'active'
                `).first();

                // Daily stats for charts
                const dailyStats = await env.DB.prepare(`
                    SELECT date(addedAt) as date, COUNT(*) as count, SUM(views) as views
                    FROM videos
                    WHERE addedAt >= datetime('now', '-30 days')
                    GROUP BY date(addedAt)
                    ORDER BY date DESC
                    LIMIT 30
                `).all();

                return jsonResponse({
                    overview: {
                        totalVideos: videoCount?.count || 0,
                        totalShorts: shortCount?.count || 0,
                        totalTags: tagCount?.count || 0,
                        totalCreators: creatorCount?.count || 0,
                        pendingCreators: pendingCreators?.count || 0,
                        totalViews: (totalViews?.views || 0) + (totalShortViews?.views || 0)
                    },
                    dailyStats: dailyStats?.results || []
                });
            }

            // Update site config
            if (path === "/api/admin/config" && method === "PUT") {
                const data = await request.json().catch(() => ({}));
                
                const now = new Date().toISOString();
                
                await env.DB.prepare(`
                    INSERT INTO site_config (
                        siteName, siteLogo, vastTagUrl, placementUrls, 
                        outstreamAdTags, primaryColor, updatedAt
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        siteName = excluded.siteName,
                        siteLogo = excluded.siteLogo,
                        vastTagUrl = excluded.vastTagUrl,
                        placementUrls = excluded.placementUrls,
                        outstreamAdTags = excluded.outstreamAdTags,
                        primaryColor = excluded.primaryColor,
                        updatedAt = excluded.updatedAt
                `).bind(
                    data.siteName || "Xplitleaks",
                    data.siteLogo || null,
                    data.vastTagUrl || null,
                    JSON.stringify(data.placementUrls || []),
                    JSON.stringify(data.outstreamAdTags || []),
                    data.primaryColor || "#ff0050",
                    now
                ).run();

                return jsonResponse({ success: true, message: "Config updated" });
            }

            // Get all creators (admin)
            if (path === "/api/admin/creators" && method === "GET") {
                const status = url.searchParams.get("status");
                
                let whereClause = "";
                let params = [];
                
                if (status) {
                    whereClause = "WHERE status = ?";
                    params.push(status);
                }
                
                const { results } = await env.DB.prepare(`
                    SELECT id, username, email, status, createdAt, lastLogin,
                           (SELECT COUNT(*) FROM videos WHERE creatorId = creators.id) as videoCount,
                           (SELECT COUNT(*) FROM shorts WHERE creatorId = creators.id) as shortCount
                    FROM creators
                    ${whereClause}
                    ORDER BY createdAt DESC
                `).bind(...params).all();
                
                return jsonResponse(results || []);
            }

            // Approve/reject creator
            if (path === "/api/admin/creator/status" && method === "PUT") {
                const { creatorId, status } = await request.json().catch(() => ({}));
                
                if (!creatorId || !['approved', 'rejected', 'suspended'].includes(status)) {
                    return errorResponse("Invalid parameters", 400);
                }
                
                await env.DB.prepare(`
                    UPDATE creators SET status = ?, updatedAt = datetime('now') WHERE id = ?
                `).bind(status, creatorId).run();
                
                return jsonResponse({ success: true, message: `Creator ${status}` });
            }

            // Delete video (admin)
            if (path === "/api/admin/video/delete" && method === "DELETE") {
                const { id } = await request.json().catch(() => ({}));
                if (!id) return errorResponse("Video ID required", 400);
                
                await env.DB.prepare(
                    "UPDATE videos SET status = 'removed', updatedAt = datetime('now') WHERE numericId = ? OR id = ?"
                ).bind(id, id).run();
                
                return jsonResponse({ success: true, message: "Video removed" });
            }

            // Delete short (admin)
            if (path === "/api/admin/short/delete" && method === "DELETE") {
                const { id } = await request.json().catch(() => ({}));
                if (!id) return errorResponse("Short ID required", 400);
                
                await env.DB.prepare(
                    "UPDATE shorts SET status = 'removed', updatedAt = datetime('now') WHERE numericId = ? OR id = ?"
                ).bind(id, id).run();
                
                return jsonResponse({ success: true, message: "Short removed" });
            }

            // Update video
            if (path === "/api/admin/video/update" && method === "PUT") {
                const { id, title, category, tags, description, status } = await request.json().catch(() => ({}));
                if (!id) return errorResponse("Video ID required", 400);

                const updates = [];
                const params = [];
                
                if (title) { updates.push("title = ?"); params.push(title); }
                if (category) { updates.push("category = ?"); params.push(category); }
                if (tags) { updates.push("tags = ?"); params.push(JSON.stringify(tags)); }
                if (description !== undefined) { updates.push("description = ?"); params.push(description); }
                if (status) { updates.push("status = ?"); params.push(status); }
                
                if (updates.length === 0) return errorResponse("No fields to update", 400);
                
                params.push(id);
                await env.DB.prepare(
                    `UPDATE videos SET ${updates.join(", ")}, updatedAt = datetime('now') 
                     WHERE numericId = ? OR id = ?`
                ).bind(...params, id).run();
                
                return jsonResponse({ success: true, message: "Video updated" });
            }

            // R2 File Upload (admin or creator)
            if (path === "/api/upload/file" && method === "POST") {
                const formData = await request.formData();
                const file = formData.get("file");
                const storagePath = formData.get("path");
                const filename = formData.get("filename");

                if (!file || !storagePath || !filename) {
                    return errorResponse("file, path, and filename required", 400);
                }

                if (!env.BUCKET) {
                    return errorResponse("R2 Bucket not configured", 500);
                }

                try {
                    await env.BUCKET.put(`${storagePath}/${filename}`, file.stream(), {
                        httpMetadata: {
                            contentType: file.type || "application/octet-stream"
                        }
                    });

                    const publicUrl = `https://${env.R2_PUBLIC_URL}/${storagePath}/${filename}`;

                    return jsonResponse({ success: true, url: publicUrl });
                } catch (error) {
                    console.error("R2 upload error:", error);
                    return errorResponse("Upload failed: " + error.message, 500);
                }
            }

            // Track like
            if (path === "/api/short/like" && method === "POST") {
                const { shortId } = await request.json().catch(() => ({}));
                const sessionId = getSessionId();
                
                if (!shortId) return errorResponse("Short ID required", 400);

                const existing = await env.DB.prepare(
                    "SELECT * FROM short_interactions WHERE shortId = ? AND sessionId = ? AND action = 'like'"
                ).bind(shortId, sessionId).first();

                if (existing) {
                    await env.DB.prepare("DELETE FROM short_interactions WHERE id = ?").bind(existing.id).run();
                    await env.DB.prepare("UPDATE shorts SET likes = MAX(likes - 1, 0) WHERE numericId = ?").bind(shortId).run();
                    return jsonResponse({ success: true, action: "unliked" });
                } else {
                    await env.DB.prepare(`
                        INSERT INTO short_interactions (shortId, sessionId, action, ipAddress, timestamp)
                        VALUES (?, ?, 'like', ?, datetime('now'))
                    `).bind(shortId, sessionId, getClientIP()).run();
                    await env.DB.prepare("UPDATE shorts SET likes = likes + 1 WHERE numericId = ?").bind(shortId).run();
                    return jsonResponse({ success: true, action: "liked" });
                }
            }

            // Track share
            if (path === "/api/short/share" && method === "POST") {
                const { shortId } = await request.json().catch(() => ({}));
                const sessionId = getSessionId();
                
                if (!shortId) return errorResponse("Short ID required", 400);

                await env.DB.prepare(`
                    INSERT INTO short_interactions (shortId, sessionId, action, ipAddress, timestamp)
                    VALUES (?, ?, 'share', ?, datetime('now'))
                `).bind(shortId, sessionId, getClientIP()).run();
                
                await env.DB.prepare("UPDATE shorts SET shares = shares + 1 WHERE numericId = ?").bind(shortId).run();
                
                return jsonResponse({ success: true, action: "shared" });
            }

            // Track short view with history
            if (path === "/api/short/view" && method === "POST") {
                const { shortId, watchDuration, watchTime } = await request.json().catch(() => ({}));
                const sessionId = getSessionId();
                
                if (!shortId) return errorResponse("Short ID required", 400);

                const shouldTrack = watchDuration >= 0.5 || watchTime >= 15 || watchDuration >= 0.9;
                
                if (!shouldTrack) {
                    return jsonResponse({ success: true, tracked: false, reason: "threshold not met" });
                }

                const action = watchDuration >= 0.9 ? 'complete' : 'view';

                await env.DB.prepare(`
                    INSERT INTO short_interactions (shortId, sessionId, action, metadata, ipAddress, timestamp)
                    VALUES (?, ?, ?, ?, ?, datetime('now'))
                `).bind(shortId, sessionId, action, JSON.stringify({ watchDuration, watchTime }), getClientIP()).run();

                // Update session history for recommendations
                try {
                    const short = await env.DB.prepare(
                        "SELECT tags, category FROM shorts WHERE numericId = ?"
                    ).bind(shortId).first();
                    
                    if (short) {
                        await env.DB.prepare(`
                            INSERT INTO session_history (sessionId, shortId, tags, category, watchDuration, watchedAt)
                            VALUES (?, ?, ?, ?, ?, datetime('now'))
                            ON CONFLICT(sessionId, shortId) DO UPDATE SET 
                                watchDuration = MAX(excluded.watchDuration, ?),
                                watchedAt = datetime('now')
                        `).bind(
                            sessionId, shortId, short.tags, short.category, 
                            watchDuration, watchDuration
                        ).run();
                    }
                } catch (e) {
                    console.error("Session history error:", e);
                }
                
                return jsonResponse({ success: true, tracked: true, action });
            }

            // Batch track views
            if (path === "/api/short/view/batch" && method === "POST") {
                const { views } = await request.json().catch(() => ({}));
                const sessionId = getSessionId();
                
                if (!views || !Array.isArray(views)) {
                    return errorResponse("views array required", 400);
                }

                const results = [];
                
                for (const view of views) {
                    try {
                        const { shortId, watchDuration, watchTime } = view;
                        if (!shortId) continue;
                        
                        const shouldTrack = watchDuration >= 0.5 || watchTime >= 15 || watchDuration >= 0.9;
                        
                        if (shouldTrack) {
                            const action = watchDuration >= 0.9 ? 'complete' : 'view';
                            
                            await env.DB.prepare(`
                                INSERT INTO short_interactions (shortId, sessionId, action, metadata, ipAddress, timestamp)
                                VALUES (?, ?, ?, ?, ?, datetime('now'))
                            `).bind(shortId, sessionId, action, JSON.stringify({ watchDuration, watchTime }), getClientIP()).run();
                            
                            const short = await env.DB.prepare(
                                "SELECT tags, category FROM shorts WHERE numericId = ?"
                            ).bind(shortId).first();
                            
                            if (short) {
                                await env.DB.prepare(`
                                    INSERT INTO session_history (sessionId, shortId, tags, category, watchDuration, watchedAt)
                                    VALUES (?, ?, ?, ?, ?, datetime('now'))
                                    ON CONFLICT(sessionId, shortId) DO UPDATE SET 
                                        watchDuration = MAX(excluded.watchDuration, ?),
                                        watchedAt = datetime('now')
                                `).bind(
                                    sessionId, shortId, short.tags, short.category, 
                                    watchDuration, watchDuration
                                ).run();
                            }
                            
                            results.push({ shortId, tracked: true });
                        } else {
                            results.push({ shortId, tracked: false });
                        }
                    } catch (e) {
                        results.push({ shortId: view.shortId, tracked: false, error: e.message });
                    }
                }
                
                return jsonResponse({ success: true, results });
            }

            // 404
            return errorResponse("Endpoint not found", 404);

        } catch (error) {
            console.error("Worker error:", error);
            return errorResponse("Internal server error: " + error.message, 500);
        }
    }
};
