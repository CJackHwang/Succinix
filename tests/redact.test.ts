// v0.7 redaction: command logs and Cordis events must never expose
// tokens/passwords/npm auth/env secrets/URL query secrets.
import { describe, expect, it } from 'vitest';
import { isSecretKey, redactCommand } from '../src/redact.js';

describe('redactCommand', () => {
  it('redacts env secret assignments', () => {
    expect(redactCommand('NPM_TOKEN=abc123 npm publish')).toBe('NPM_TOKEN=[REDACTED] npm publish');
    expect(redactCommand('export GITHUB_TOKEN=ghp_xyz && ./deploy.sh')).toBe('export GITHUB_TOKEN=[REDACTED] && ./deploy.sh');
    expect(redactCommand('DATABASE_URL=postgres://u:p@h/db')).toBe('DATABASE_URL=[REDACTED]');
    expect(redactCommand('API_KEY="a b c" curl https://x')).toBe('API_KEY=[REDACTED] curl https://x');
  });

  it('redacts flag values with = and space separators', () => {
    expect(redactCommand('succinix pkg lock --token=abc')).toBe('succinix pkg lock --token=[REDACTED]');
    expect(redactCommand('curl --password secret --url https://x')).toBe('curl --password [REDACTED] --url https://x');
    expect(redactCommand('node app.js --api-key k123')).toBe('node app.js --api-key [REDACTED]');
  });

  it('redacts npm auth keys', () => {
    expect(redactCommand('npm config set //registry.npmjs.org/:_authToken=abc123')).toBe('npm config set //registry.npmjs.org/:_authToken=[REDACTED]');
    expect(redactCommand('echo _auth=base64stuff')).toBe('echo _auth=[REDACTED]');
  });

  it('redacts URL userinfo and secret query parameters', () => {
    expect(redactCommand('git clone https://user:pass@github.com/org/repo.git')).toBe('git clone https://[REDACTED]@github.com/org/repo.git');
    expect(redactCommand('curl "https://api.example.com/v1?token=abc&q=hello"')).toBe('curl "https://api.example.com/v1?token=[REDACTED]&q=hello"');
    expect(redactCommand('curl "https://api.example.com/?api_key=xyz&page=2"')).toBe('curl "https://api.example.com/?api_key=[REDACTED]&page=2"');
  });

  it('redacts Authorization headers and Bearer tokens', () => {
    expect(redactCommand(`curl -H 'Authorization: Bearer eyJhbGci' https://x`)).toBe(`curl -H 'Authorization: [REDACTED]' https://x`);
    expect(redactCommand('curl -H "authorization: token ghp_xxx" https://x')).toBe('curl -H "authorization: [REDACTED]" https://x');
    expect(redactCommand('curl -H "X-Key: abc" -H "Bearer def" https://x')).toBe('curl -H "X-Key: abc" -H "Bearer [REDACTED]" https://x');
  });

  it('leaves non-secret commands unchanged', () => {
    const plain = [
      'ls -la /workspace',
      'echo hello world',
      'git commit -m "fix: token handling in docs"',
      'npm run build && npm test',
      'ps | grep node',
      'curl https://api.example.com/v1?q=hello',
      'node -e "console.log(1)"',
      'grep -r password= docs/',
    ];
    for (const command of plain) expect(redactCommand(command)).toBe(command);
  });

  it('keeps structure for quoted and empty values', () => {
    expect(redactCommand("TOKEN=''")).toBe("TOKEN=''");
    expect(redactCommand('--password=  ')).toBe('--password=  ');
  });

  it('handles empty input', () => {
    expect(redactCommand('')).toBe('');
  });
});

describe('isSecretKey', () => {
  it('detects secret-shaped keys', () => {
    expect(isSecretKey('NPM_TOKEN')).toBe(true);
    expect(isSecretKey('accessToken')).toBe(true);
    expect(isSecretKey('api-key')).toBe(true);
    expect(isSecretKey('_auth')).toBe(true);
    expect(isSecretKey('password')).toBe(true);
    expect(isSecretKey('--token')).toBe(true);
  });

  it('does not over-match ordinary keys', () => {
    expect(isSecretKey('foo')).toBe(false);
    expect(isSecretKey('message')).toBe(false);
    expect(isSecretKey('timeout')).toBe(false);
  });
});
