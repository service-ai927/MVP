/**
 * Security helpers for the API server.
 *
 * Everything in this module is pure or factory-based so it can be unit tested
 * without binding ports. The server composes these pieces; nothing here talks
 * to the network or the filesystem directly.
 *
 * Design notes (single-operator MVP, local JSON persistence):
 * - CORS is opt-in per origin. There is no wildcard mode.
 * - The server binds loopback by default. Binding to a network interface in
 *   production requires an explicit API token (fail closed at startup).
 * - /api/health stays unauthenticated: it exposes operational metadata only
 *   (service name, version, thread count, whether a Gemini key is configured),
 *   never conversation content or secret values.
 * - There is no user accounts system. `API_AUTH_TOKEN` is a shared bearer
 *   token for API clients; browser access from other machines should go
 *   through an authenticating reverse proxy (see README).
 */
import crypto from "node:crypto";

const BEARER_PREFIX = /^Bearer\s+/i;
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

/** Keys that must never survive a JSON round-trip into application state. */
const FORBIDDEN_JSON_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Maximum nesting depth accepted by sanitizeJson (guards against deep-input DoS). */
const MAX_SANITIZE_DEPTH = 50;

/** Normalize a socket address for comparison (strip IPv4-mapped IPv6, zone ids). */
export function normalizeAddress(address) {
  if (typeof address !== "string") return "";
  return address.trim().replace(/^::ffff:/i, "").replace(/%.*$/, "");
}

/** True for loopback peers (127.0.0.0/8, ::1, and IPv4-mapped loopback). */
export function isLoopbackAddress(address) {
  const normalized = normalizeAddress(address);
  if (normalized === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}

/** Parse a "1"/"true"/"yes"/"on" style environment flag. */
export function parseBooleanEnv(value) {
  return TRUE_VALUES.has(String(value ?? "").trim().toLowerCase());
}

/** Split a comma-separated environment list into trimmed, non-empty entries. */
export function parseListEnv(value) {
  return String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Parse an integer environment value with bounds checking.
 * Returns `fallback` for missing/invalid values so a typo in the environment
 * never crashes the server with an unusable port or a negative limit.
 */
export function parseIntegerEnv(value, { fallback, min, max }) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number(String(value).trim());
  if (!Number.isInteger(parsed)) return fallback;
  if (min !== undefined && parsed < min) return fallback;
  if (max !== undefined && parsed > max) return fallback;
  return parsed;
}

/**
 * Constant-time string comparison. Hashing first equalizes the input lengths,
 * so timingSafeEqual can be used directly and length itself leaks nothing.
 */
export function safeCompare(a, b) {
  const digestA = crypto.createHash("sha256").update(String(a ?? ""), "utf8").digest();
  const digestB = crypto.createHash("sha256").update(String(b ?? ""), "utf8").digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

/**
 * Deep-copy a JSON value while dropping prototype-pollution keys and capping
 * nesting depth. Returns plain objects/arrays/primitives only; anything below
 * the depth cap is discarded (null) rather than kept at unknown shape.
 */
export function sanitizeJson(value, depth = 0) {
  if (depth > MAX_SANITIZE_DEPTH) return null;
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeJson(entry, depth + 1));
  }
  if (value && typeof value === "object") {
    const clean = {};
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_JSON_KEYS.has(key)) continue;
      clean[key] = sanitizeJson(entry, depth + 1);
    }
    return clean;
  }
  return value;
}

/**
 * CORS middleware restricted to explicitly configured origins.
 * No configuration means no CORS headers at all: the browser then refuses
 * cross-origin reads of API responses, which is the fail-closed default for
 * same-origin deployments (the UI is served by this same server).
 */
export function createCorsMiddleware(allowedOrigins = []) {
  const allowed = new Set(allowedOrigins.filter(Boolean));
  return function corsMiddleware(req, res, next) {
    const origin = req.headers?.origin;
    if (origin && allowed.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
      res.setHeader("Access-Control-Max-Age", "600");
    }
    if (req.method === "OPTIONS") {
      // Answer preflight without granting access; the browser enforces the
      // missing Allow-Origin for origins that are not on the list.
      res.status(204).end();
      return;
    }
    next();
  };
}

/** Baseline response-hardening headers for every response. */
export function securityHeaders(_req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  next();
}

/**
 * Content-Security-Policy for the built SPA. Applied in production only:
 * the Vite dev server needs inline scripts for HMR. The app renders inline
 * style attributes throughout, so style-src keeps 'unsafe-inline'; scripts
 * are external bundle files only.
 */
export function contentSecurityPolicy(_req, res, next) {
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; ")
  );
  next();
}

/**
 * Decide whether an API request may proceed.
 *
 * Rules:
 * - A presented Authorization header must always be valid (even from loopback)
 *   so a wrong token is never silently ignored.
 * - Loopback peers are allowed without a token: that is the local operator.
 * - Non-loopback peers need the configured token; without one, production
 *   denies the request (fail closed) and development allows it with a warning.
 */
export function decideApiAccess({ isLoopback = false, isProduction = false, configuredToken = "", hasAuthHeader = false, presentedToken = null } = {}) {
  if (hasAuthHeader) {
    if (!configuredToken) {
      return {
        allowed: false,
        status: 401,
        code: "auth-token-not-configured",
        message: "An Authorization header was sent but API_AUTH_TOKEN is not configured on the server.",
      };
    }
    if (!safeCompare(presentedToken, configuredToken)) {
      return {
        allowed: false,
        status: 401,
        code: "invalid-token",
        message: "Invalid or expired API token.",
      };
    }
    return { allowed: true };
  }

  if (isLoopback) return { allowed: true };

  if (configuredToken) {
    return {
      allowed: false,
      status: 401,
      code: "token-required",
      message: "This endpoint requires authentication. Send Authorization: Bearer <API_AUTH_TOKEN>.",
    };
  }

  if (isProduction) {
    return {
      allowed: false,
      status: 403,
      code: "not-exposed-without-auth",
      message: "API access from a non-loopback address is disabled because API_AUTH_TOKEN is not configured. Set API_AUTH_TOKEN, use an authenticating reverse proxy, or keep the server on 127.0.0.1.",
    };
  }

  return { allowed: true, warn: true };
}

/**
 * Middleware enforcing decideApiAccess for /api/* routes.
 * /api/health is exempt (operational metadata only). All other paths
 * (static SPA assets) are untouched.
 */
export function createApiAccessMiddleware({ isProduction = false, configuredToken = "", warn = (...args) => console.warn(...args) } = {}) {
  return function apiAccess(req, res, next) {
    if (!req.path.startsWith("/api/")) return next();
    if (req.path === "/api/health") return next();

    const header = req.headers?.authorization;
    const hasAuthHeader = typeof header === "string" && BEARER_PREFIX.test(header);
    const presentedToken = hasAuthHeader ? header.replace(BEARER_PREFIX, "").trim() : null;

    const decision = decideApiAccess({
      isLoopback: isLoopbackAddress(req.socket?.remoteAddress || req.ip),
      isProduction,
      configuredToken,
      hasAuthHeader,
      presentedToken,
    });

    if (decision.warn) {
      warn(
        `[security] ${req.method} ${req.path} accepted from a non-loopback address without API_AUTH_TOKEN (development mode). Set API_AUTH_TOKEN before exposing this server beyond localhost.`
      );
    }

    if (!decision.allowed) {
      res.setHeader("WWW-Authenticate", "Bearer");
      return res.status(decision.status).json({ ok: false, error: decision.message, code: decision.code });
    }
    next();
  };
}

/**
 * Simple fixed-window in-memory rate limiter for /api/* routes, keyed by
 * socket peer address. `max <= 0` disables counting entirely. Buckets are
 * pruned lazily so an address-spoofing flood cannot grow the map forever.
 */
export function createRateLimiter({ max, windowMs = 60_000, now = Date.now } = {}) {
  const buckets = new Map();

  return function rateLimit(req, res, next) {
    if (!req.path.startsWith("/api/")) return next();
    if (!Number.isFinite(max) || max <= 0) return next();

    const key = normalizeAddress(req.socket?.remoteAddress || req.ip || "unknown") || "unknown";
    const time = now();

    if (buckets.size > 5_000) {
      for (const [entryKey, bucket] of buckets) {
        if (time >= bucket.resetAt) buckets.delete(entryKey);
      }
    }

    let bucket = buckets.get(key);
    if (!bucket || time >= bucket.resetAt) {
      bucket = { count: 0, resetAt: time + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    if (bucket.count > max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - time) / 1000));
      res.setHeader("Retry-After", String(retryAfterSeconds));
      return res.status(429).json({ ok: false, error: "Too many requests. Retry later." });
    }
    next();
  };
}
