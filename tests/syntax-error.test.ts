import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import TurfSyntaxError from '../src/syntax-error.ts';

describe('TurfSyntaxError', () => {
  test('defaults the code and omits an absent cause', () => {
    const error = new TurfSyntaxError('boom');
    assert.equal(error.name, 'TurfSyntaxError');
    assert.equal(error.code, 'TURF_INVALID_SYNTAX');
    assert.ok(!('cause' in error));
  });

  test('retains an explicit code and cause', () => {
    const cause = new Error('root');
    const error = new TurfSyntaxError('boom', { code: 'TURF_CUSTOM', cause });
    assert.equal(error.code, 'TURF_CUSTOM');
    assert.equal(error.cause, cause);
  });
});
