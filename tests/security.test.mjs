import test from "node:test";
import assert from "node:assert/strict";
import {
  contentSecurityPolicy,
  createApiAccessMiddleware,
  createCorsMiddleware,
  createRateLimiter,
  decideApiAccess,
  isLoopbackAddress,
  normalizeAddress,
  parseBooleanEnv,
  parseIntegerEnv,
  parseListEnv,
  safeCompare,
  sanitizeJson,
  securityHeaders,
} from "../src/security.mjs";

function mockRes() {
  const headers = {};
  let statusCode = 200;
  let ended = false;
  let body;
  return {
    headers,
    get statusCode() { return statusCode; },
    get ended() { return ended; },
    get body() { return body; },
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    status(code) { statusCode = code; return this; },
    json(payload) { body = payload; return this; },
    end() { ended = true; return this; },
  };
}

function mockReq(overrides = {}) {
  return {
    method: "GET",
    path: "/api/threads",
    headers: {},
    ip: "127.0.0.1",
    socket: { remoteAddress: "127.0.0.1" },
    ...overrides,
  };
}

// --- address helpers -------------------------------------------------------

test("isLoopbackAddress accepts loopback forms and rejects peers", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("127.5.6.7"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("192.168.1.10"), false);
  assert.equal(isLoopbackAddress("::ffff:192.168.1.10"), false);
  assert.equal(isLoopbackAddress(""), false);
  assert.equal(isLoopbackAddress(undefined), false);
});

test("normalizeAddress strips IPv4-mapped prefix and zone ids", () => {
  assert.equal(normalizeAddress("::ffff:10.0.0.1"), "10.0.0.1");
  assert.equal(normalizeAddress("fe80::1%eth0"), "fe80::1");
  assert.equal(normalizeAddress(null), "");
});

// --- env parsing -----------------------------------------------------------

test("parseBooleanEnv only accepts explicit truthy spellings", () => {
  for (const value of ["1", "true", "TRUE", "yes", "on"]) {
    assert.equal(parseBooleanEnv(value), true, value);
  }
  for (const value of ["", "0", "false", "no", "maybe", undefined, null]) {
    assert.equal(parseBooleanEnv(value), false, String(value));
  }
});

test("parseListEnv splits comma-separated origins", () => {
  assert.deepEqual(parseListEnv(" https://a.example , https://b.example ,, "), [
    "https://a.example",
    "https://b.example",
  ]);
  assert.deepEqual(parseListEnv(undefined), []);
});

test("parseIntegerEnv falls back on invalid or out-of-range values", () => {
  assert.equal(parseIntegerEnv("3000", { fallback: 3000, min: 0, max: 65535 }), 3000);
  assert.equal(parseIntegerEnv("0", { fallback: 3000, min: 0, max: 65535 }), 0);
  assert.equal(parseIntegerEnv("70000", { fallback: 3000, min: 0, max: 65535 }), 3000);
  assert.equal(parseIntegerEnv("abc", { fallback: 3000, min: 0, max: 65535 }), 3000);
  assert.equal(parseIntegerEnv(undefined, { fallback: 300, min: 0 }), 300);
  assert.equal(parseIntegerEnv("-5", { fallback: 300, min: 0 }), 300);
});

// --- token comparison ------------------------------------------------------

test("safeCompare is exact and length-safe", () => {
  assert.equal(safeCompare("secret", "secret"), true);
  assert.equal(safeCompare("secret", "secreT"), false);
  assert.equal(safeCompare("secret", "secret-extra"), false);
  assert.equal(safeCompare("", ""), true);
  assert.equal(safeCompare(undefined, ""), true);
});

// --- sanitizeJson ----------------------------------------------------------

test("sanitizeJson drops prototype-pollution keys at any depth", () => {
  const malicious = JSON.parse('{"thread":{"id":"a"},"__proto__":{"polluted":true},"nested":{"constructor":{"bad":1},"keep":"yes"}}');
  const clean = sanitizeJson(malicious);
  assert.equal(clean.thread.id, "a");
  assert.equal(clean.nested.keep, "yes");
  assert.equal(Object.prototype.hasOwnProperty.call(clean, "__proto__"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(clean.nested, "constructor"), false);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(sanitizeJson([{ __proto__: { x: 1 }, ok: 2 }])[0].ok, 2);
});

test("sanitizeJson caps depth instead of recursing forever", () => {
  let deep = "leaf";
  for (let i = 0; i < 60; i += 1) deep = { deeper: deep };
  const clean = sanitizeJson(deep);
  let node = clean;
  let depth = 0;
  while (node && typeof node === "object") {
    node = node.deeper;
    depth += 1;
    assert.ok(depth <= 60);
  }
  assert.ok(depth < 60, "depth beyond the cap must be truncated");
});

// --- CORS ------------------------------------------------------------------

test("createCorsMiddleware only reflects explicitly allowed origins", () => {
  const middleware = createCorsMiddleware(["https://trusted.example"]);

  const allowed = mockRes();
  middleware(mockReq({ method: "OPTIONS", headers: { origin: "https://trusted.example" } }), allowed, () => {
    throw new Error("preflight should not fall through");
  });
  assert.equal(allowed.headers["access-control-allow-origin"], "https://trusted.example");
  assert.equal(allowed.headers.vary, "Origin");
  assert.equal(allowed.statusCode, 204);

  const allowedSimple = mockRes();
  let allowedPassed = false;
  middleware(mockReq({ headers: { origin: "https://trusted.example" } }), allowedSimple, () => { allowedPassed = true; });
  assert.equal(allowedSimple.headers["access-control-allow-origin"], "https://trusted.example");
  assert.equal(allowedPassed, true, "allowed origins proceed to the route with the grant header");

  const denied = mockRes();
  let passed = false;
  middleware(mockReq({ headers: { origin: "https://evil.example" } }), denied, () => { passed = true; });
  assert.equal(denied.headers["access-control-allow-origin"], undefined);
  assert.equal(passed, true, "simple requests still reach the route; the browser blocks reading the response");

  const noConfig = mockRes();
  middleware(mockReq({ headers: { origin: "https://any.example" } }), noConfig, () => {});
  assert.equal(noConfig.headers["access-control-allow-origin"], undefined, "no configuration means no CORS grant");
});

// --- headers ---------------------------------------------------------------

test("securityHeaders and contentSecurityPolicy set hardening headers", () => {
  const res = mockRes();
  securityHeaders(mockReq(), res, () => {});
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.equal(res.headers["x-frame-options"], "DENY");
  assert.equal(res.headers["referrer-policy"], "no-referrer");
  assert.equal(res.headers["cross-origin-opener-policy"], "same-origin");

  const cspRes = mockRes();
  contentSecurityPolicy(mockReq(), cspRes, () => {});
  const csp = cspRes.headers["content-security-policy"];
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
});

// --- API access decision ---------------------------------------------------

test("decideApiAccess allows loopback without a token in every mode", () => {
  assert.deepEqual(decideApiAccess({ isLoopback: true, isProduction: true }), { allowed: true });
  assert.deepEqual(decideApiAccess({ isLoopback: true, isProduction: false }), { allowed: true });
});

test("decideApiAccess fails closed for non-loopback production without a token", () => {
  const decision = decideApiAccess({ isLoopback: false, isProduction: true, configuredToken: "" });
  assert.equal(decision.allowed, false);
  assert.equal(decision.status, 403);
  assert.equal(decision.code, "not-exposed-without-auth");
});

test("decideApiAccess allows non-loopback development with a warning flag", () => {
  const decision = decideApiAccess({ isLoopback: false, isProduction: false, configuredToken: "" });
  assert.equal(decision.allowed, true);
  assert.equal(decision.warn, true);
});

test("decideApiAccess requires and validates the bearer token for network peers", () => {
  const required = decideApiAccess({ isLoopback: false, isProduction: true, configuredToken: "tok" });
  assert.equal(required.allowed, false);
  assert.equal(required.status, 401);
  assert.equal(required.code, "token-required");

  const wrong = decideApiAccess({ isLoopback: false, isProduction: true, configuredToken: "tok", hasAuthHeader: true, presentedToken: "nope" });
  assert.equal(wrong.allowed, false);
  assert.equal(wrong.code, "invalid-token");

  const right = decideApiAccess({ isLoopback: false, isProduction: true, configuredToken: "tok", hasAuthHeader: true, presentedToken: "tok" });
  assert.equal(right.allowed, true);

  // A valid token is also accepted from loopback.
  const loopbackWithToken = decideApiAccess({ isLoopback: true, isProduction: true, configuredToken: "tok", hasAuthHeader: true, presentedToken: "tok" });
  assert.equal(loopbackWithToken.allowed, true);
});

test("decideApiAccess rejects a presented header when no token is configured", () => {
  const decision = decideApiAccess({ isLoopback: true, isProduction: true, configuredToken: "", hasAuthHeader: true, presentedToken: "anything" });
  assert.equal(decision.allowed, false);
  assert.equal(decision.status, 401);
  assert.equal(decision.code, "auth-token-not-configured");
});

test("createApiAccessMiddleware guards /api/* but exempts health and static paths", () => {
  const middleware = createApiAccessMiddleware({ isProduction: true, configuredToken: "tok", warn: () => {} });

  let healthPassed = false;
  middleware(mockReq({ path: "/api/health", socket: { remoteAddress: "8.8.8.8" } }), mockRes(), () => { healthPassed = true; });
  assert.equal(healthPassed, true, "health stays open for monitoring");

  let staticPassed = false;
  middleware(mockReq({ path: "/assets/app.js", socket: { remoteAddress: "8.8.8.8" } }), mockRes(), () => { staticPassed = true; });
  assert.equal(staticPassed, true, "static SPA assets are not API routes");

  const denied = mockRes();
  let apiPassed = false;
  middleware(
    mockReq({ path: "/api/threads", socket: { remoteAddress: "8.8.8.8" } }),
    denied,
    () => { apiPassed = true; }
  );
  assert.equal(apiPassed, false);
  assert.equal(denied.statusCode, 401, "with a token configured, a peer without one must authenticate");
  assert.equal(denied.body.ok, false);
  assert.equal(denied.headers["www-authenticate"], "Bearer");

  // Without any configured token, a production network peer is refused outright.
  const noTokenMiddleware = createApiAccessMiddleware({ isProduction: true, configuredToken: "", warn: () => {} });
  const refused = mockRes();
  noTokenMiddleware(mockReq({ path: "/api/threads", socket: { remoteAddress: "8.8.8.8" } }), refused, () => {
    throw new Error("should not pass");
  });
  assert.equal(refused.statusCode, 403);
  assert.equal(refused.body.code, "not-exposed-without-auth");
});

test("createApiAccessMiddleware validates a wrong bearer token even from loopback", () => {
  const middleware = createApiAccessMiddleware({ isProduction: true, configuredToken: "tok", warn: () => {} });
  const res = mockRes();
  let passed = false;
  middleware(
    mockReq({ path: "/api/threads", headers: { authorization: "Bearer wrong" }, socket: { remoteAddress: "127.0.0.1" } }),
    res,
    () => { passed = true; }
  );
  assert.equal(passed, false);
  assert.equal(res.statusCode, 401);

  const okRes = mockRes();
  let okPassed = false;
  middleware(
    mockReq({ path: "/api/threads", headers: { authorization: "Bearer tok" }, socket: { remoteAddress: "127.0.0.1" } }),
    okRes,
    () => { okPassed = true; }
  );
  assert.equal(okPassed, true);
});

// --- rate limiting ---------------------------------------------------------

test("createRateLimiter rejects requests over the window limit and recovers", () => {
  let clock = 1_000_000;
  const limiter = createRateLimiter({ max: 3, windowMs: 60_000, now: () => clock });

  for (let i = 0; i < 3; i += 1) {
    const res = mockRes();
    let passed = false;
    limiter(mockReq(), res, () => { passed = true; });
    assert.equal(passed, true, `request ${i + 1} should pass`);
  }

  const rejected = mockRes();
  let rejectedPassed = false;
  limiter(mockReq(), rejected, () => { rejectedPassed = true; });
  assert.equal(rejectedPassed, false);
  assert.equal(rejected.statusCode, 429);
  assert.ok(Number(rejected.headers["retry-after"]) > 0);

  clock += 61_000;
  const afterWindow = mockRes();
  let afterPassed = false;
  limiter(mockReq(), afterWindow, () => { afterPassed = true; });
  assert.equal(afterPassed, true, "window reset allows requests again");
});

test("createRateLimiter ignores non-API paths and disabled limits", () => {
  const counting = createRateLimiter({ max: 1 });
  for (let i = 0; i < 5; i += 1) {
    const res = mockRes();
    let passed = false;
    counting(mockReq({ path: "/assets/app.js" }), res, () => { passed = true; });
    assert.equal(passed, true, "static assets are never rate limited here");
  }

  const disabled = createRateLimiter({ max: 0 });
  for (let i = 0; i < 10; i += 1) {
    const res = mockRes();
    let passed = false;
    disabled(mockReq(), res, () => { passed = true; });
    assert.equal(passed, true);
  }
});
