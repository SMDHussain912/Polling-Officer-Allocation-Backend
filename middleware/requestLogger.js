/**
 * requestLogger — logs every API request and its response.
 *
 * Built on morgan (request line: method, url, status, response time) plus a
 * small wrapper that captures the JSON response body so you can see WHAT came
 * back, not just the status code.
 *
 * Safety:
 *  - Sensitive fields (passwords, tokens, cookies, authorization) are redacted
 *    from both the request body/query and the logged response.
 *  - Large binary bodies (file uploads, PDF downloads) are summarised, not dumped.
 *  - Toggle the whole thing with LOG_REQUESTS=true/false (default: on unless
 *    NODE_ENV=production, where it is off unless explicitly enabled).
 *
 * Usage in server.js:
 *   app.use(requestLogger);
 */
const morgan = require('morgan');

// Keys whose values must never be written to the console.
const REDACT_KEYS = new Set([
  'password', 'newpassword', 'oldpassword', 'currentpassword', 'confirmpassword',
  'token', 'accesstoken', 'refreshtoken', 'idtoken', 'downloadtoken',
  'authorization', 'cookie', 'set-cookie', 'apikey', 'api_key', 'secret',
  'clientsecret', 'whatsappaccesstoken', 'smsapikey', 'smsapisecret',
  'sessionsecret', 'swaggerpassword', 'swaggerusername',
]);

function isRedactKey(key) {
  return REDACT_KEYS.has(String(key).toLowerCase().replace(/[-_ ]/g, ''));
}

/** Deep-redact an object's sensitive keys; keeps output short and safe. */
function redact(value, depth = 0) {
  if (depth > 4) return '[deep]';
  if (Array.isArray(value)) {
    return value.slice(0, 10).map((v) => redact(v, depth + 1));
  }
  if (value && typeof value === 'object') {
    // Never expand Buffers / big binary payloads.
    if (Buffer.isBuffer(value)) return `[buffer ${value.length} bytes]`;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isRedactKey(k) ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Trim a string so log lines stay readable. */
function clip(str, max = 2000) {
  const s = String(str);
  return s.length > max ? `${s.slice(0, max)}…(${s.length} chars)` : s;
}

/** Short, safe summary of a JSON response body. */
function summarizeBody(body) {
  if (body === undefined || body === null) return '(no body)';
  if (Buffer.isBuffer(body)) return `[buffer ${body.length} bytes]`;
  if (typeof body === 'object') {
    try {
      const safe = redact(body);
      const json = JSON.stringify(safe);
      return clip(json);
    } catch {
      return '(unserializable body)';
    }
  }
  return clip(body, 300);
}

function requestLogger(req, res, next) {
  // Config: on by default in dev, off in production unless LOG_REQUESTS=true.
  const isProd = process.env.NODE_ENV === 'production';
  const flag = (process.env.LOG_REQUESTS || '').trim().toLowerCase();
  const enabled = flag ? flag === 'true' || flag === '1' : !isProd;
  if (!enabled) return next();

  const started = Date.now();

  // Capture the response body by wrapping res.json / res.send.
  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);
  res.json = (body) => {
    res.locals.__loggedBody = body;
    return originalJson(body);
  };
  res.send = (body) => {
    // Express's res.json() stringifies the object then calls res.send(string).
    // Guard against that internal call clobbering the object we already
    // captured: overwriting it with a pre-stringified string would bypass the
    // object redaction in summarizeBody and leak secrets to the log.
    if (res.locals.__loggedBody === undefined && (typeof body === 'string' || (body && typeof body === 'object'))) {
      res.locals.__loggedBody = body;
    }
    return originalSend(body);
  };

  // Log the response once it is finished (status + timing + body).
  res.on('finish', () => {
    const ms = Date.now() - started;
    const status = res.statusCode;
    const isErr = status >= 500;
    const isWarn = status >= 400 && status < 500;

    // NOTE: the one-line request header (method/url/status/time) is printed by
    // morgan (wired in server.js) to avoid two duplicate request lines. Here we
    // only add the detail lines morgan can't show: request inputs + response body.

    // Request inputs (redacted) — helpful when debugging 4xx/5xx.
    if (isWarn || isErr || process.env.LOG_REQUEST_BODIES === 'true') {
      // Origin is the single most useful clue for a cross-origin deploy bug
      // (e.g. Vercel frontend -> Render backend), so always surface it here.
      if (req.headers?.origin) console.log(`       origin: ${req.headers.origin}`);
      const q = Object.keys(req.query || {}).length
        ? clip(JSON.stringify(redact(req.query)))
        : '';
      const body = req.body && Object.keys(req.body).length
        ? summarizeBody(req.body)
        : '';
      if (q) console.log(`       query: ${q}`);
      if (body) console.log(`       body : ${body}`);
    }

    // Response body (redacted), skipped for binary downloads.
    const ct = res.getHeader('Content-Type') || '';
    if (/application\/json/.test(ct) && res.locals.__loggedBody !== undefined) {
      console.log(`       resp : ${summarizeBody(res.locals.__loggedBody)}`);
    } else if (/pdf|octet-stream|image\//.test(ct)) {
      const len = res.getHeader('Content-Length');
      console.log(`       resp : [${ct}${len ? `, ${len} bytes` : ''}]`);
    }
  });

  return next();
}

// Also emit morgan's concise "combined"-style line for real HTTP visibility.
// The 'tiny' format keeps it to one short line; 'dev' adds color for terminals.
const morganMiddleware = morgan(
  process.env.NODE_ENV === 'production' ? 'tiny' : 'dev',
  {
    skip: (req) => {
      const flag = (process.env.LOG_REQUESTS || '').trim().toLowerCase();
      const enabled = flag ? flag === 'true' || flag === '1' : process.env.NODE_ENV !== 'production';
      return !enabled;
    },
  }
);

module.exports = requestLogger;
module.exports.morganMiddleware = morganMiddleware;
