import { describe, expect, it } from 'vitest';
import { mergeExecutionEnvironment } from '../src/engine/host/config.js';

describe('mergeExecutionEnvironment', () => {
  it('keeps persisted PATH order while retaining host executable directories', () => {
    expect(mergeExecutionEnvironment(
      { PATH: '/usr/local/bin:/usr/bin', HOST_ONLY: '1', SHARED: 'host' },
      { PATH: '/bin:/usr/bin', USER_ONLY: '1', SHARED: 'user' },
    )).toEqual({
      PATH: '/bin:/usr/bin:/usr/local/bin',
      HOST_ONLY: '1',
      USER_ONLY: '1',
      SHARED: 'user',
    });
  });

  it('does not invent PATH when neither environment defines one', () => {
    expect(mergeExecutionEnvironment({ A: '1' }, { B: '2' })).toEqual({ A: '1', B: '2' });
  });
});
