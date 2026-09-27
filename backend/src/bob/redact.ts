/**
 * redact.ts — Secret redaction for anything ForgeGuard persists or broadcasts.
 *
 * Bob output, stderr, and diagnostic records are stored as evidence and sent to
 * the browser. Any environment value that looks like a credential is replaced
 * with a placeholder before that happens.
 */

const SECRET_NAME_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;
const MIN_SECRET_LENGTH = 6;

export const REDACTED = '[REDACTED]';

/** Collect the values of secret-looking environment variables (longest first). */
export function collectSecretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < MIN_SECRET_LENGTH) continue;
    if (SECRET_NAME_PATTERN.test(name)) values.add(value);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

/** Replace every occurrence of a known secret value in `text`. */
export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let result = text;
  for (const secret of collectSecretValues(env)) {
    result = result.split(secret).join(REDACTED);
  }
  return result;
}
