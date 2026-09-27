/**
 * config.ts — Security-relevant runtime configuration. Documented in docs/SECURITY_MODEL.md
 * and docs/VALIDATION_POLICY.md. Every getter reads the environment it is given, so
 * tests can pass an explicit env.
 */

type Env = Record<string, string | undefined>;

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];
export const MAX_ISSUE_TEXT_LENGTH = 12_000;
export const JSON_BODY_LIMIT = '100kb';
export const DEFAULT_VALIDATION_TIMEOUT_MS = 180_000;

/** Interface to bind; loopback unless FORGEGUARD_HOST explicitly says otherwise. */
export function getServerHost(env: Env = process.env): string {
  const host = env['FORGEGUARD_HOST']?.trim();
  return host ? host : DEFAULT_HOST;
}

function normaliseOrigin(value: string): string | null {
  try {
    const u = new URL(value.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** Browser origins allowed to call the API and open the WebSocket. `*` is never accepted. */
export function getAllowedOrigins(env: Env = process.env): string[] {
  const raw = env['FORGEGUARD_ALLOWED_ORIGINS']?.trim();
  if (!raw) return [...DEFAULT_ALLOWED_ORIGINS];
  const origins: string[] = [];
  for (const entry of raw.split(',')) {
    if (!entry.trim()) continue;
    const o = entry.trim() === '*' ? null : normaliseOrigin(entry);
    if (o) origins.push(o);
    else console.warn(`[config] Ignoring invalid FORGEGUARD_ALLOWED_ORIGINS entry: ${JSON.stringify(entry.trim())}`);
  }
  return origins;
}

export function isOriginAllowed(origin: string, allowed: string[]): boolean {
  const o = normaliseOrigin(origin);
  return o !== null && allowed.includes(o);
}

export function getValidationTimeoutMs(env: Env = process.env): number {
  const raw = env['FORGEGUARD_VALIDATION_TIMEOUT_MS']?.trim();
  if (!raw) return DEFAULT_VALIDATION_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.warn(`[config] Invalid FORGEGUARD_VALIDATION_TIMEOUT_MS ${JSON.stringify(raw)}; using ${DEFAULT_VALIDATION_TIMEOUT_MS}`);
    return DEFAULT_VALIDATION_TIMEOUT_MS;
  }
  return n;
}
