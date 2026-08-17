// Command-log redaction: tokens, passwords, npm auth, env secrets, and URL
// query secrets never reach command logs, Cordis events, or derived snapshots.
// Pure string transform -- no WebContainer, DOM, or node APIs, so both the
// app logging layer and the plugin telemetry layer can share it.
const REDACTED = '[REDACTED]';

const SECRET_WORDS = new Set([
  'token', 'password', 'passwd', 'secret', 'auth', 'credential',
  'key', 'apikey', 'api_key', 'access_token',
]);

// camelCase/PascalCase/snake/kebab segments: `accessToken` -> access token,
// `NPM_TOKEN` -> npm token, `api-key` -> api key.
function splitWords(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function isSecretKey(key: string): boolean {
  return splitWords(key).some((word) => SECRET_WORDS.has(word));
}

// key=value assignments (env, CLI flags, npm _authToken / _auth).
const ASSIGNMENT = /([A-Za-z0-9_.!-]+)=("(?:[^"]*)"|'(?:[^']*)'|[^\s&|;]*)/g;
// npm-style auth keys such as //registry.npmjs.org/:_authToken=xxx.
const NPM_AUTH = /([^=\s]*_auth(?:Token)?)=("(?:[^"]*)"|'(?:[^']*)'|[^\s&|;]*)/gi;
// --flag value pairs.
const FLAG_VALUE = /(--[A-Za-z0-9_-]+)(\s+)(\S+)/g;
// URL userinfo (https://user:pass@host/...) and secret query parameters.
const URL_USERINFO = /(https?:\/\/)([^/\s"'<>]+@)/gi;
const URL_QUERY = /([?&])([A-Za-z0-9_.~-]+)=([^&\s"'<>]*)/g;
// Authorization header values (curl -H 'Authorization: Bearer <token>').
const AUTH_HEADER = /(authorization\s*:\s*)(?:(?:bearer|token)\s+)?[^\s"';]+/gi;
// Credential-bearing value, e.g. postgres://user:pass@host/db.
const VALUE_WITH_CREDENTIALS = /:\/\/[^\s]*@/;
// Standalone Bearer tokens.
const BEARER = /(\bbearer\s+)[A-Za-z0-9._~+/-]+/gi;

export function redactCommand(command: string): string {
  if (!command) return command;
  let out = command;
  // URLs first: their `=`/`?` would otherwise be consumed by the assignment
  // matcher as a bogus key.
  out = out.replace(URL_USERINFO, `$1${REDACTED}@`);
  out = out.replace(URL_QUERY, (match, sep: string, key: string, value: string) =>
    isSecretKey(key) && value.length > 0 ? `${sep}${key}=${REDACTED}` : match,
  );
  out = out.replace(ASSIGNMENT, (match, key: string, value: string) => {
    const raw = value.replace(/^["']|["']$/g, '');
    return isSecretKey(key) && raw.length > 0 ? `${key}=${REDACTED}` :
      VALUE_WITH_CREDENTIALS.test(raw) ? `${key}=${REDACTED}` : match;
  });
  out = out.replace(NPM_AUTH, (match, key: string) => `${key}=${REDACTED}`);
  out = out.replace(FLAG_VALUE, (match, flag: string, space: string) =>
    isSecretKey(flag) ? `${flag}${space}${REDACTED}` : match,
  );
  out = out.replace(AUTH_HEADER, (match, prefix: string) => `${prefix}${REDACTED}`);
  out = out.replace(BEARER, (match, prefix: string) => `${prefix}${REDACTED}`);
  return out;
}
