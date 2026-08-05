// src/engine/tokenize.ts 单元测试：shlex 语义转义引号 + 元字符检测。
import { describe, it, expect } from 'vitest';
import { tokenize, hasShellMetaToken } from '../src/engine/tokenize.js';

describe('tokenize — shlex escape semantics', () => {
  it('preserves inner double quotes inside a quoted -e code (no boundary confusion)', () => {
    expect(tokenize('node -e "console.log(\\"hi\\")"')).toEqual(['node', '-e', 'console.log("hi")']);
  });

  it('keeps whitespace inside a quoted token as one unit', () => {
    expect(tokenize('echo "a b"')).toEqual(['echo', 'a b']);
  });

  it('turns an escaped quote inside quotes into a literal quote', () => {
    expect(tokenize('echo "a\\"b"')).toEqual(['echo', 'a"b']);
  });

  it('supports escaped single quote inside single quotes', () => {
    expect(tokenize("echo 'it\\'s'")).toEqual(['echo', "it's"]);
  });

  it('collapses double backslash to a single backslash inside quotes', () => {
    expect(tokenize('echo "a\\\\b"')).toEqual(['echo', 'a\\b']);
  });

  it('keeps \\n inside a quoted -e code intact (does not eat the backslash)', () => {
    expect(tokenize("node -e \"console.log('a\\nb')\"")).toEqual(['node', '-e', "console.log('a\\nb')"]);
  });

  it('keeps a pipe inside quotes as part of the token', () => {
    expect(tokenize("node -e \"console.log('a|b')\"")).toEqual(['node', '-e', "console.log('a|b')"]);
  });

  it('escapes a space outside quotes via backslash', () => {
    expect(tokenize('echo a\\ b')).toEqual(['echo', 'a b']);
  });
});

describe('tokenize — unterminated quote', () => {
  it('throws a clear error instead of silently truncating', () => {
    expect(() => tokenize('echo "unterminated')).toThrow('unterminated quote in command');
  });

  it('throws for an unterminated single quote too', () => {
    expect(() => tokenize("echo 'abc")).toThrow('unterminated quote in command');
  });
});

describe('hasShellMetaToken — node command shell-meta fallback detection', () => {
  it('detects a standalone pipe token', () => {
    expect(hasShellMetaToken(tokenize('node -e "console.log(1)" | grep 1'))).toBe(true);
  });

  it('detects && and ; chains and background &', () => {
    expect(hasShellMetaToken(tokenize('node --version && npm --version'))).toBe(true);
    expect(hasShellMetaToken(tokenize('node a.js ; node b.js'))).toBe(true);
    expect(hasShellMetaToken(tokenize('node server.js &'))).toBe(true);
  });

  it('detects redirect forms including glued filenames and 2>&1', () => {
    expect(hasShellMetaToken(tokenize('node -e "x" > out.txt'))).toBe(true);
    expect(hasShellMetaToken(tokenize('node -e "x" >> log'))).toBe(true);
    expect(hasShellMetaToken(tokenize('node -e "x" 2> err'))).toBe(true);
    expect(hasShellMetaToken(tokenize('npm i -g x 2>&1 | tail -20'))).toBe(true);
  });

  it('detects fd-number and & redirect glued forms (1> / 1>> / 2>> / &> / &>>)', () => {
    expect(hasShellMetaToken(tokenize('node -e "x" 1> out.txt'))).toBe(true);
    expect(hasShellMetaToken(tokenize('node -e "x" 1>> log'))).toBe(true);
    expect(hasShellMetaToken(tokenize('node -e "x" 2>> err'))).toBe(true);
    expect(hasShellMetaToken(tokenize('node -e "x" &> all.log'))).toBe(true);
    expect(hasShellMetaToken(tokenize('node -e "x" &>> all.log'))).toBe(true);
  });

  it('detects fd-number input redirect forms (0< / 2<</ 1<&2) — TASK24 follow-up', () => {
    expect(hasShellMetaToken(tokenize('node -e "x" 0< input.txt'))).toBe(true);
    expect(hasShellMetaToken(tokenize('node -e "x" 2<<EOF'))).toBe(true);
    expect(hasShellMetaToken(tokenize('node -e "x" 1<&2'))).toBe(true);
  });

  it('does NOT flag bare numbers or a redirect glued to a plain word (a>file)', () => {
    expect(hasShellMetaToken(tokenize('node x.js 42'))).toBe(false);
    expect(hasShellMetaToken(tokenize('node x.js a>file'))).toBe(false);
  });

  it('detects command substitution', () => {
    expect(hasShellMetaToken(tokenize('node -e "$(echo x)"'))).toBe(true);
  });

  it('does NOT flag a pipe inside quotes (single token)', () => {
    expect(hasShellMetaToken(tokenize("node -e \"console.log('a|b')\""))).toBe(false);
  });

  it('does NOT flag a plain node command without metachars', () => {
    expect(hasShellMetaToken(tokenize('node -e "console.log(1)"'))).toBe(false);
    expect(hasShellMetaToken(tokenize('npm --version'))).toBe(false);
  });
});
