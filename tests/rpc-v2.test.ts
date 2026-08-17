import { describe, expect, it } from 'vitest';
import {
  BoundedProcessedIds,
  isValidRpcRequestId,
  makeRpcBootNonce,
  makeRpcRequestPrefix,
  rpcResultPath,
} from '../src/engine/rpc-v2.js';

describe('file RPC v2 protocol primitives', () => {
  it('uses a time/random request prefix and a boot nonce', () => {
    expect(makeRpcRequestPrefix(() => 0.5, () => 1000)).toBe('rs-0zik0zk');
    expect(makeRpcBootNonce(() => 0.5, () => 1000)).toMatch(/^boot-rs-0zik0zk-/);
  });

  it('bounds processed IDs in FIFO order', () => {
    const ids = new BoundedProcessedIds(2);
    ids.add('a');
    ids.add('b');
    ids.add('c');
    expect(ids.has('a')).toBe(false);
    expect(ids.has('b')).toBe(true);
    expect(ids.has('c')).toBe(true);
  });

  it('rejects path traversal IDs and creates independent result paths', () => {
    expect(isValidRpcRequestId('../x')).toBe(false);
    expect(isValidRpcRequestId('page-abc-1')).toBe(true);
    expect(rpcResultPath('page-abc-1')).toBe('/result-page-abc-1.json');
  });
});
