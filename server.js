
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require("fs");
const { google } = require("googleapis");

const connectDB = require('./config/db');
const Admin = require('./models/Admin');
const Allocation = require('./models/Allocation');

const authRoutes = require('./routes/authRoutes');
const officerRoutes = require('./routes/officerRoutes');
const boothRoutes = require('./routes/boothRoutes');
const allocationRoutes = require('./routes/allocationRoutes');
const uploadRoutes = require('./routes/uploadRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const settingsRoutes = require('./routes/settingsRoutes');
const webhookRoutes = require('./routes/webhookRoutes');
const reportsRoutes = require('./routes/reportsRoutes');
const idCardRoutes = require('./routes/idCardRoutes');

const crypto = require("crypto");
const helmet = require("helmet");
const expressMongoSanitize = require("express-mongo-sanitize");

const { protect } = require('./middleware/authMiddleware');
const { notFound, errorHandler } = require('./middleware/errorMiddleware');
const requestLogger = require('./middleware/requestLogger');
const morganMiddleware = requestLogger.morganMiddleware;
const { rateLimit } = require('./middleware/rateLimitMiddleware');
const { buildSessionMiddleware } = require('./config/session');
const { swaggerDocsAuth } = require('./middleware/basicAuthMiddleware');
const secureTokenStore = require('./services/secureTokenStore');

const { mountSwagger } = require("./docs/swagger");

// Docs kill-switch: documentation stays ON by default (protected by its own
// Basic-Auth login); set ENABLE_SWAGGER=false to remove it entirely.
const ENABLE_SWAGGER =
  String(process.env.ENABLE_SWAGGER || 'true').trim().toLowerCase() !== 'false';

// Blunts Basic-Auth brute force on the docs without breaking the UI
// (Swagger UI loads ~7 assets + the spec per view; 100 ≈ a dozen views).
const docsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many documentation requests',
});

/*
 * OAuth CSRF state store (in-memory, single instance): a random nonce is
 * created when an admin starts the Google flow; the callback MUST present
 * it, so forged callbacks / state-injection are rejected. Entries expire
 * after 10 minutes and are swept periodically.
 */
const pendingOAuthStates = new Map();
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now();
  for (const [state, expiresAt] of pendingOAuthStates) {
    if (expiresAt <= cutoff) pendingOAuthStates.delete(state);
  }
}, 60 * 1000).unref();

const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
);

const SCOPES = [
    "https://www.googleapis.com/auth/gmail.send"
];


// Load any saved Google credentials - decrypted via the secure token store
// (migrates the legacy plaintext tokens.json automatically on first boot).
const savedTokens = secureTokenStore.loadTokens();
if (savedTokens) {
    oauth2Client.setCredentials(savedTokens);
    console.log("[AUTH] Saved Google credentials loaded (encrypted at rest)");
}

// The mail endpoints AND the notification flow share this OAuth client via
// mailService (allocation letters now carry the generated ID-card PDF).
const mailService = require('./services/mailService');
mailService.initMail({ oauth2Client });



const app = express();

// Trust the first proxy hop (Vite dev proxy, ngrok tunnel) so the secure
// cookie works over https and req.ip reflects the real client (rate limiter).
app.set('trust proxy', 1);

// ------------------------------ Request logging -----------------------------
// morgan prints the standard one-line access log (method, url, status, time);
// requestLogger adds the redacted request-body / response-body detail lines.
// Toggle both with LOG_REQUESTS=true/false (on by default in dev, off in
// production unless enabled). Passwords/tokens/cookies are redacted.
app.use(morganMiddleware);
app.use(requestLogger);

// --------------------------- Global middleware ------------------------------
// CORS allow-list: same-origin/proxied requests (no Origin header), localhost
// dev origins, any ngrok tunnel (free-tier URLs rotate) and anything extra in
// ALLOWED_ORIGINS. Every other browser origin is rejected.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

function isAllowedOrigin(origin) {
  if (!origin) return true; // curl / server-to-server / same-origin via proxy
  let hostname;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return false;
  }
  if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
  if (/(^|\.)ngrok-free\.app$/i.test(hostname)) return true;
  if (/(^|\.)ngrok\.io$/i.test(hostname)) return true;
  // Vercel deploys (production + rotating preview subdomains) so the hosted
  // frontend can talk to this API without listing every preview URL.
  if (/(^|\.)vercel\.app$/i.test(hostname)) return true;
  return allowedOrigins.includes(origin);
}

// Security headers (CSP disabled: Swagger UI serves its own local scripts).
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: (origin, cb) => cb(null, isAllowedOrigin(origin)),
  credentials: true, // the session cookie must ride along on cross-origin calls
}));
app.disable('x-powered-by');
// Delivery-status webhooks mount BEFORE express.json(): the WhatsApp route
// needs the exact raw bytes for HMAC signature verification.
app.use('/api/webhooks', webhookRoutes);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
// Neutralize NoSQL-injection vectors: strips $-prefixed and dotted keys out of
// req.body, req.query and req.params before any controller sees them.
app.use(expressMongoSanitize());

// ------------------------------- Session -------------------------------------
// HttpOnly cookie session backed by MongoDB - replaces the JWT/Bearer scheme
// (JavaScript can no longer read the credential; logout destroys the session).
app.use(buildSessionMiddleware());

// --------------------------- CSRF (Origin check) -----------------------------
// Cookie auth re-opens the classic CSRF vector. SameSite=lax blocks most of
// it; this closes the rest: browsers attach an Origin header to cross-site
// state-changing requests, so any such request whose Origin is not on the
// allow-list is rejected. Non-browser clients (curl) send no Origin and pass
// untouched.
app.use((req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  if (!isAllowedOrigin(req.headers.origin)) {
    return res.status(403).json({
      success: false,
      message: 'Cross-site request blocked: untrusted Origin',
    });
  }
  return next();
});

// ------------------------------- Routes --------------------------------------
app.get('/api/health', (req, res) =>
  res.json({ success: true, message: 'Smart Polling Allocation API is running' })
);

app.use('/api/auth', authRoutes);
app.use('/api/officers', officerRoutes);
app.use('/api/booths', boothRoutes);
app.use('/api/allocation', allocationRoutes.router);


// Dashboard stats endpoint (protected, lives next to allocation data).
app.get('/api/dashboard/stats', protect, allocationRoutes.getDashboardStats);

app.use('/api/upload', uploadRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/idcards', idCardRoutes);
app.use('/api/settings', settingsRoutes);

// NOTE: the public /static file mount was REMOVED - it served the uploads
// folder with no authentication, so anything that ever landed there would be
// publicly downloadable through the tunnel. Nothing in the app linked to it.

// ----------------------------- API documentation ------------------------------
// Interactive Swagger UI  ->  http://localhost:<PORT>/api-docs
// Raw OpenAPI 3 JSON spec ->  http://localhost:<PORT>/api-docs.json
// PROTECTED by its own Basic-Auth login (SWAGGER_USERNAME / SWAGGER_PASSWORD) -
// separate from the admin session and granting no API access. Rate-limited to
// blunt brute force. ENABLE_SWAGGER=false removes the docs entirely.
if (ENABLE_SWAGGER) {
    mountSwagger(app, { guard: [docsLimiter, swaggerDocsAuth] });
}



// ------------- Google OAuth (admin-gated, CSRF-protected) -------------------
// 1. Only a signed-in admin may start the flow: open /auth/google while
//    logged in - the session cookie authorizes the navigation automatically
//    (no token in the URL anymore, so nothing leaks into history/logs).
// 2. Every start generates a random CSRF `state`; the callback must present
//    it, so forged callbacks / state-injection are rejected.
app.get("/auth/google", async (req, res) => {
    if (!req.session || !req.session.adminId) {
        return res.status(401).send(
            "<h1>401 - Admin login required</h1>" +
            "<p>Google (Gmail) authorization can only be started by a signed-in admin.</p>" +
            "<p>Log in to the app, then open <code>/auth/google</code>.</p>"
        );
    }
    const admin = await Admin.findById(req.session.adminId).select('role status').lean();
    if (!admin || admin.status === 'inactive') {
        return res.status(401).send(
            "<h1>401 - Admin login required</h1>" +
            "<p>Your session is no longer valid. Log in to the app and try again.</p>"
        );
    }

    const state = crypto.randomBytes(16).toString("hex");
    pendingOAuthStates.set(state, Date.now() + OAUTH_STATE_TTL_MS);

    const authUrl =
        oauth2Client.generateAuthUrl({
            access_type: "offline",
            prompt: "consent",
            scope: SCOPES,
            state,
        });

    console.log("[AUTH URL]");
    console.log(authUrl);

    res.redirect(authUrl);
});
app.get("/auth/google/callback", async (req, res) => {
    const { code, state } = req.query;

    // CSRF check: the state must be one this server issued (and not expired).
    if (!state || !pendingOAuthStates.has(state)) {
        return res.status(403).send(
            "<h1>403 - Invalid OAuth state</h1>" +
            "<p>The authorization request is invalid or expired. " +
            "Start again from the admin dashboard.</p>"
        );
    }
    pendingOAuthStates.delete(state); // single use

    try {
        if (!code) {
            return res.status(400).send(
                "Authorization code missing"
            );
        }

        console.log("[AUTH] Authorization code received");

        const { tokens } =
            await oauth2Client.getToken(code);

        console.log("[AUTH] Tokens received");

        console.log({
            access_token: !!tokens.access_token,
            refresh_token: !!tokens.refresh_token,
            expiry_date: tokens.expiry_date
        });

        // AUTHORIZED_GMAILS allow-list: reject Google accounts that are not
        // explicitly trusted (comma-separated list; empty = allow any account).
        // The email is read from the id_token issued by Google's token
        // endpoint (received over TLS directly from Google, not user input).
        const authorized = String(process.env.AUTHORIZED_GMAILS || '')
            .split(',')
            .map((e) => e.trim().toLowerCase())
            .filter(Boolean);
        let accountEmail = null;
        try {
            const idPayload = JSON.parse(
                Buffer.from(tokens.id_token.split('.')[1], 'base64').toString('utf8')
            );
            accountEmail = idPayload.email || null;
        } catch {
            /* no id_token in the response - allow-list still enforced below */
        }
        if (authorized.length > 0 && !authorized.includes(String(accountEmail || '').toLowerCase())) {
            // Best-effort revoke of the just-issued access token, then refuse.
            try { await oauth2Client.revokeToken(tokens.access_token); } catch { /* ignore */ }
            console.warn(`[AUTH] Rejected non-authorized Google account: ${accountEmail || 'unknown'}`);
            return res.status(403).send(
                "<h1>403 - Account not authorized</h1>" +
                "<p><strong>" + (accountEmail || 'This Google account') + "</strong> is not on the allowed Gmail list.</p>" +
                "<p>The administrator must add it to <code>AUTHORIZED_GMAILS</code> in backend/.env.</p>"
            );
        }

        oauth2Client.setCredentials(tokens);

        // Save tokens locally - ENCRYPTED at rest (plaintext never hits disk).
        secureTokenStore.saveTokens(tokens);

        console.log(
            "[AUTH] Google authentication successful"
        );

        res.send(`
            <h1>Google Authentication Successful! ✅</h1>
            <p>Connected Gmail: <strong>${accountEmail || 'unknown'}</strong></p>
            <p>Tokens saved encrypted. You can close this page.</p>
        `);

    } catch (error) {

        console.error(
            "[AUTH] OAuth error:"
        );

        console.error(
            error.response?.data ||
            error.message
        );

        res.status(500).json({

            success: false,

            error:
                error.response?.data ||
                error.message
        });
    }
});

// --------------------------- Mail helpers ------------------------------------
// sendGmailMessage / mailErrorResponse / buildAllocationLetter /
// sendAllocationLetter moved to services/mailService.js so the notification
// flow can send the same SHORT allocation mail (mandal + ID-card download
// link, no PDF attachment). (The shared OAuth client is injected at boot:
// mailService.initMail.)
const {
    sendGmailMessage,
    mailErrorResponse,
    sendAllocationLetter,
} = require('./services/mailService');


// POST /api/mail/send - free-form e-mail through the connected Gmail account.
// PROTECTED: requires a valid admin JWT - public sending would turn the
// tunnel-exposed API into a spam relay.
app.post("/api/mail/send", protect, async (req, res) => {
    try {
        const { to, subject, text } = req.body;
        const messageId = await sendGmailMessage({ to, subject, text });
        res.status(200).json({
            success: true,
            message: "Email sent successfully",
            messageId,
        });
    } catch (error) {
        console.error("[MAIL] Failed to send email:", error.message);
        mailErrorResponse(res, error);
    }
});

// POST /api/mail/allocation/:allocationId - polling-duty letter for one allocation.
// PROTECTED: requires a valid admin JWT.
app.post("/api/mail/allocation/:allocationId", protect, async (req, res) => {
    try {
        const allocation = await Allocation.findById(req.params.allocationId)
            .populate("officer")
            .populate("booth");

        if (!allocation) {
            return res.status(404).json({ success: false, message: "Allocation not found" });
        }
        if (allocation.status !== "ALLOCATED") {
            return res.status(400).json({
                success: false,
                message: "Mail can only be sent for an ALLOCATED allocation",
            });
        }

        const result = await sendAllocationLetter(allocation);

        if (result.status === "skipped") {
            return res.status(400).json({
                success: false,
                message: "Officer has no e-mail address on record",
            });
        }
        if (result.status === "failed") {
            return res.status(500).json({ success: false, message: result.reason });
        }

        res.status(200).json({
            success: true,
            message: `E-mail sent to ${allocation.officer.email}`,
            messageId: result.messageId,
        });
    } catch (error) {
        console.error("[MAIL] Allocation letter failed:", error.message);
        mailErrorResponse(res, error);
    }
});

// POST /api/mail/allocation - bulk polling-duty letters.
// Body: { "allocationIds": [...] } (max 100) or { "mandal": "..." }.
// PROTECTED: requires a valid admin JWT.
app.post("/api/mail/allocation", protect, async (req, res) => {
    try {
        const { allocationIds, mandal } = req.body || {};

        const filter = { status: "ALLOCATED" };
        if (Array.isArray(allocationIds) && allocationIds.length) {
            if (allocationIds.length > 100) {
                return res.status(400).json({
                    success: false,
                    message: "Maximum 100 allocations per request",
                });
            }
            filter._id = { $in: allocationIds };
        } else if (mandal) {
            const re = new RegExp(`^${String(mandal).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
            filter.$or = [{ mandal: re }];
        }

        const allocations = await Allocation.find(filter)
            .populate("officer")
            .populate("booth")
            .limit(100);

        if (!allocations.length) {
            return res.status(404).json({
                success: false,
                message: "No ALLOCATED allocations match the request",
            });
        }

        let sent = 0;
        let failed = 0;
        let skipped = 0;
        const failures = [];

        for (const allocation of allocations) {
            const result = await sendAllocationLetter(allocation);
            if (result.status === "sent") {
                sent += 1;
            } else if (result.status === "skipped") {
                skipped += 1;
            } else {
                failed += 1;
                failures.push({
                    allocationId: allocation._id,
                    officer: allocation.officer?.officerName || "",
                    reason: result.reason,
                });
            }
        }

        res.status(200).json({
            success: true,
            message: `ID-card link mails processed: ${sent} sent, ${failed} failed, ${skipped} skipped (no e-mail address).`,
            data: { total: allocations.length, sent, failed, skipped, failures },
        });
    } catch (error) {
        console.error("[MAIL] Bulk ID-card link mails failed:", error.message);
        mailErrorResponse(res, error);
    }
});

// POST /api/mail/test - simple connectivity check for the Gmail connection.
// PROTECTED: requires a valid admin JWT.
app.post("/api/mail/test", protect, async (req, res) => {
    try {
        const messageId = await sendGmailMessage({
            to: req.body?.to,
            subject: "Polling Officer - Gmail test",
            text: "This is a test e-mail from the Polling Officer Allocation System.",
        });
        res.status(200).json({
            success: true,
            message: "Test e-mail sent successfully",
            messageId,
        });
    } catch (error) {
        console.error("[MAIL] Test e-mail failed:", error.message);
        mailErrorResponse(res, error);
    }
});

// POST /api/mail/disconnect - revoke the Google refresh token server-side and
// delete the local credential store, so the connected account can no longer
// send mail. PROTECTED: requires a valid admin JWT.
app.post("/api/mail/disconnect", protect, async (req, res, next) => {
    try {
        const tokens = secureTokenStore.loadTokens();
        if (tokens && tokens.refresh_token) {
            try {
                await oauth2Client.revokeToken(tokens.refresh_token);
            } catch (err) {
                console.warn("[AUTH] Google revoke failed (token removed locally anyway):", err.message);
            }
        }
        secureTokenStore.clearTokens();
        try { oauth2Client.setCredentials({}); } catch { /* ignore */ }
        res.json({ success: true, message: "Gmail account disconnected and tokens revoked" });
    } catch (error) {
        next(error);
    }
});

// --------------------------- Error handling -----------------------------------
app.use(notFound);
app.use(errorHandler);



async function seedMainAdmin() {
  const bcrypt = require('bcryptjs');
  const countService = require('./services/countService');

  const username = (process.env.ADMIN_USERNAME || 'admin').toLowerCase();
  const seedPassword = process.env.ADMIN_PASSWORD || 'admin123';
  const production = process.env.NODE_ENV === 'production';

  // Fail closed: never allow the default password in production.
  if (production && (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD === 'admin123')) {
    throw new Error(
      '[SECURITY] ADMIN_PASSWORD must be set to a strong value when NODE_ENV=production - refusing to start with a default password'
    );
  }

  const existing = await Admin.findOne({ username }).select('+password');
  if (!existing) {
    await Admin.create({
      username,
      password: await bcrypt.hash(seedPassword, 12),
      name: 'Main Admin',
      role: 'SUPER_ADMIN',
      district: process.env.ADMIN_DISTRICT || '',
      status: 'active',
    });
    console.log(`[AUTH] Created Main Admin account '${username}'`);
  } else if (!production) {
    const ok = await existing.comparePassword(seedPassword);
    if (!ok) {
      existing.password = await bcrypt.hash(seedPassword, 12);
      await existing.save();
      console.log(`[AUTH] Synced Main Admin password for '${username}'`);
    }
  }

  // Requirement A: remove ONLY demo/test auth accounts, never domain data.
  try {
    const removed = await Admin.deleteMany({ username: { $ne: username } });
    if (removed.deletedCount > 0) {
      console.log(`[AUTH] Removed ${removed.deletedCount} non-admin demo account(s)`);
    }
  } catch (error) {
    console.warn('[AUTH] Could not clean demo accounts:', error.message);
  }

  // Requirement B: booth counters are rebuilt from allocation documents.
  try {
    await countService.resyncAllBoothCounts();
    console.log('[BOOT] Booth counters resynced from ALLOCATED allocations');
  } catch (error) {
    console.warn('[BOOT] Could not resync booth counts:', error.message);
  }
}

// ---------------------------------------------------------------
//  SERVER STARTUP
// ---------------------------------------------------------------
// Connect to MongoDB and seed the Main Admin whenever this module loads.
// This runs for both the real server AND the test suite (which requires this
// module), so a DB connection is always ready. connectDB() reads
// MONGODB_URI from the environment, so tests that set MONGODB_URI before
// requiring this file get their own isolated test database.
(async function start() {
  await connectDB();
  await seedMainAdmin();

  // Only bind a port when run directly (node server.js / nodemon server.js).
  // Tests require this module and start their own throwaway server, so we must
  // NOT listen here in that case - it would collide or bind the wrong port.
  if (require.main === module) {
    const port = process.env.PORT || 5000;
    app.listen(port, '0.0.0.0', () => {
      console.log(`[SERVER] Polling Officer Allocation API running on http://localhost:${port}`);
    });
  }
})();

module.exports = { app, connectDB, seedMainAdmin };
