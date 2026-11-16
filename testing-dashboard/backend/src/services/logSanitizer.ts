/**
 * Redacts sensitive environment values, tokens, JWTs, and auth/cookie headers from log output.
 */
export function sanitizeLogText(input: string, secrets: string[] = []): string {
  let output = input;

  for (const secret of secrets) {
    if (secret && secret.length >= 6) {
      output = output.split(secret).join('[REDACTED_SECRET]');
    }
  }

  // Redact JWT-like three-segment base64url strings
  output = output.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]');

  // Redact Authorization / Cookie / Set-Cookie header values if logged
  output = output.replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi, '$1[REDACTED]');
  output = output.replace(/(cookie\s*[:=]\s*token=)[^;\s"']+/gi, '$1[REDACTED]');

  // Credentials embedded in URLs: https://user:pass@host
  output = output.replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@');

  // Well-known token formats (GitHub, npm, AWS, Slack)
  output = output.replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, '[REDACTED_TOKEN]');
  output = output.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED_TOKEN]');
  output = output.replace(/\bnpm_[A-Za-z0-9]{30,}\b/g, '[REDACTED_TOKEN]');
  output = output.replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]');
  output = output.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED_TOKEN]');

  return output;
}

const SECRET_NAME = /(SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|SESSION|COOKIE|JWT)/i;

/** Values of the dashboard's own environment that look like secrets (used purely for log redaction). */
export function collectProcessSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value && value.length >= 8 && SECRET_NAME.test(key)) out.push(value);
  }
  return out;
}
