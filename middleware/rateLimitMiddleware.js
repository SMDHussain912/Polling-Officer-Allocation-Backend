/**
 * rateLimitMiddleware.js
 * ======================
 * Minimal fixed-window, in-memory rate limiter (no external dependency).
 *
 * Used to protect the PUBLIC endpoints (admin login, employee
 * self-registration) against brute-force / spam floods.
 *
 * NOTE: when the app is reached through the Vite dev-server proxy
 * (browser -> ngrok -> Vite :5173 -> backend :5000) the backend's socket
 * peer is the Vite process, so the per-IP key collapses into one shared
 * bucket. Limits are therefore set generously - they exist to blunt abuse,
 * not to meter real users.
 */
const buckets = new Map();

/* Periodically drop expired buckets so the Map cannot grow without bound. */
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, 5 * 60 * 1000).unref();

/** Prefers the first X-Forwarded-For hop (when a reverse proxy sets it). */
function clientKey(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || 'unknown';
}

/**
 * @param {object}  options
 * @param {number}  options.windowMs  Window length in ms (default 15 min).
 * @param {number}  options.max       Max requests per window per client.
 * @param {string}  options.message   Human message returned on HTTP 429.
 */
function rateLimit({ windowMs = 15 * 60 * 1000, max = 30, message = 'Too many requests' } = {}) {
  return function rateLimiter(req, res, next) {
    const key = clientKey(req);
    const now = Date.now();

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    if (bucket.count > max) {
      const retrySec = Math.ceil((bucket.resetAt - now) / 1000);
      return res.status(429).json({
        success: false,
        message: `${message} - please try again in ${retrySec}s`,
      });
    }
    return next();
  };
}

module.exports = { rateLimit };