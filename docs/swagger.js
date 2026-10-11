/**
 * swagger.js
 * ==========
 * Serves the hand-written OpenAPI 3 specification in `docs/swagger.json`:
 *
 *   GET /api-docs       - interactive Swagger UI (try every endpoint)
 *   GET /api-docs.json  - the same specification as raw JSON
 *
 * The JSON file is the single source of truth: it can be imported straight
 * into Postman / Insomnia, and the UI is fed from the very same object, so
 * they can never drift apart.
 */

const fs = require('fs');
const path = require('path');
const swaggerUi = require('swagger-ui-express');

const specPath = path.join(__dirname, 'swagger.json');
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));

const SWAGGER_OPTIONS = {
  customSiteTitle: 'Smart Polling Booth Officer Allocation API',
  customCss: '.swagger-ui .topbar { display: none }',
  swaggerOptions: {
    // Feed the UI from the JSON endpoint so the raw spec and the UI match.
    url: '/api-docs.json',
    // Keeps the JWT in the Authorize dialog across page reloads.
    persistAuthorization: true,
    displayRequestDuration: true,
    docExpansion: 'list',
    filter: true,
    tryItOutEnabled: true,
  },
};

/**
 * Mounts the docs endpoints on the given Express app.
 * `guard` (optional) is a middleware or array of middlewares (e.g. Basic-Auth
 * login + rate limiter) applied to EVERY doc route - the UI, the spec JSON
 * and the /swagger.json alias - so there is no unprotected backdoor.
 */
function mountSwagger(app, { basePath = '/api-docs', guard = null } = {}) {
  const guards = guard ? [].concat(guard) : [];
  const withGuard = (handler) => [...guards, handler];

  // Raw JSON specification (also what Swagger UI loads).
  app.get(
    `${basePath}.json`,
    withGuard((req, res) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.send(JSON.stringify(spec, null, 2));
    })
  );

  // Convenience alias for tools that expect /swagger.json.
  app.get(
    '/swagger.json',
    withGuard((req, res) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.send(JSON.stringify(spec, null, 2));
    })
  );

  // Interactive UI. `swaggerUi.setup` also gets the object so the very first
  // render works even before the JSON request completes.
  if (guards.length > 0) {
    app.use(basePath, ...guards, swaggerUi.serve, swaggerUi.setup(spec, SWAGGER_OPTIONS));
  } else {
    app.use(basePath, swaggerUi.serve, swaggerUi.setup(spec, SWAGGER_OPTIONS));
  }

  return spec;
}

module.exports = { mountSwagger, spec, specPath };
