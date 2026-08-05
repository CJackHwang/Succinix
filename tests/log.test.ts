// src/log.ts 单元测试：行格式 / tail / rotate / clear（mock FS）。
import { describe, it, expect, beforeEach } from 'vitest';
import { FakeFS } from './helpers/fakes.js';
import type { FileSystemAPI } from '@webcontainer/api';
import { initLogger, log, flushLogs, readLog, clearLog, readBootLog, LOG_FILE } from '../src/log.js';

const fs = () => new FakeFS() as unknown as FileSystemAPI;

describe('log', () => {
  beforeEach(async () => {
    await flushLogs();
  });

  it('writes a formatted journal line with ISO timestamp and level', async () => {
    const f = fs();
    initLogger(f);
    await log('INFO', 'hello world');
    await flushLogs();
    const text = await readLog(f, 0);
    expect(text).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z \[INFO\] hello world$/);
  });

  it('folds embedded newlines into a single space (one line per entry)', async () => {
    const f = fs();
    initLogger(f);
    await log('WARN', 'line1\nline2\r\nline3');
    await flushLogs();
    const text = await readLog(f, 0);
    expect(text).toContain('[WARN] line1 line2 line3');
    expect(text.split('\n').length).toBe(1);
  });

  it('readLog tail: n returns only the last n lines', async () => {
    const f = fs();
    initLogger(f);
    await log('INFO', 'one');
    await log('INFO', 'two');
    await log('INFO', 'three');
    const tail2 = await readLog(f, 2);
    const lines = tail2.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('two');
    expect(lines[1]).toContain('three');
  });

  it('readLog n<=0 returns all lines', async () => {
    const f = fs();
    initLogger(f);
    await log('INFO', 'a');
    await log('INFO', 'b');
    const all = await readLog(f, 0);
    expect(all.split('\n')).toHaveLength(2);
  });

  it('readBootLog filters only BOOT-level lines by line prefix', async () => {
    const f = fs();
    initLogger(f);
    await log('INFO', 'not boot');
    await log('BOOT', 'first boot');
    await log('WARN', 'still not boot');
    await log('BOOT', 'second boot');
    const boots = await readBootLog(f, 0);
    const lines = boots.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('[BOOT] first boot');
    expect(lines[1]).toContain('[BOOT] second boot');
    expect(boots).not.toContain('not boot');
  });

  it('readBootLog n limits count', async () => {
    const f = fs();
    initLogger(f);
    await log('BOOT', 'one');
    await log('BOOT', 'two');
    const last1 = await readBootLog(f, 1);
    expect(last1).toContain('[BOOT] two');
    expect(last1).not.toContain('one');
  });

  it('clearLog empties the file', async () => {
    const f = fs();
    initLogger(f);
    await log('INFO', 'to be cleared');
    await clearLog(f);
    expect(await readLog(f, 0)).toBe('');
  });

  it('log is a no-op before initLogger (no crash)', async () => {
    await expect(log('ERROR', 'before init')).resolves.toBeUndefined();
    await flushLogs();
  });

  it('rotates oversize files keeping the tail intact (line not split)', async () => {
    const f = fs();
    initLogger(f);
    // 超大单条：触发 >200KB 截断，文件有界保留尾部。
    await log('INFO', 'x'.repeat(250 * 1024));
    await flushLogs();
    const big = await readLog(f, 0);
    expect(big.length).toBeLessThanOrEqual(200 * 1024);
    expect(big.length).toBeGreaterThan(190 * 1024);
    // 后续小条消息落在尾部，旋转后仍保留（不把整条日志清空）。
    await log('INFO', 'tail-anchor');
    await flushLogs();
    const text = await readLog(f, 0);
    expect(text.length).toBeLessThanOrEqual(200 * 1024);
    expect(text).toContain('tail-anchor');
  });

  it('readLog on a fresh filesystem returns empty string', async () => {
    const f = fs();
    initLogger(f);
    expect(await readLog(f, 10)).toBe('');
  });

  it('creates /var/log directory on first write', async () => {
    const f = new FakeFS();
    initLogger(f as unknown as FileSystemAPI);
    await log('INFO', 'dirs');
    await flushLogs();
    expect(f.has('/var/log')).toBe(true);
    expect(f.has(LOG_FILE)).toBe(true);
  });
});
