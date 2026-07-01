import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { CommentSegment } from '../src/scanner.ts';
import { TurfScanner } from '../src/scanner.ts';

function commentSegments(source: string): CommentSegment[] {
  return TurfScanner.scan(source).segments.filter((segment): segment is CommentSegment => segment.type === 'comment');
}

describe('TurfScanner', () => {
  test('does not default an omitted file', () => {
    assert.equal(TurfScanner.scan('').file, undefined);
  });

  test('normalizes CRLF without removing standalone carriage returns', () => {
    assert.equal(TurfScanner.normalizeSource('one\r\ntwo\rthree'), 'one\ntwo\rthree');
  });

  test('scans lossless text and comment segments', () => {
    const result = TurfScanner.scan('before<!-- ordinary -->after', { file: '/page.turf' });
    const segments = result.segments.map((segment) => `${segment.type}:${segment.raw}`);
    assert.deepEqual(segments, ['text:before', 'comment:<!-- ordinary -->', 'text:after']);
  });

  test('rejects non-string sources', () => {
    assert.throws(() => TurfScanner.scan(42 as never), { name: 'TypeError', message: 'Turf source must be a string.' });
  });

  test('classifies standalone, inline, and adjacent comments', () => {
    const standalone = commentSegments('  <!-- $value -->\n')[0];
    assert.ok(standalone);
    assert.deepEqual(standalone.layout, {
      kind: 'standalone',
      indent: '  ',
      envelope: { start: 0, end: 18 }
    });

    const trailing = commentSegments('  <!-- $value -->')[0];
    assert.ok(trailing);
    assert.deepEqual(trailing.layout, {
      kind: 'standalone',
      indent: '  ',
      envelope: { start: 0, end: 17 }
    });

    const inline = commentSegments('<p><!-- $value --></p>')[0];
    assert.ok(inline);
    assert.equal(inline.layout.kind, 'inline');

    const adjacent = commentSegments('<!-- $a --><!-- $b -->');
    assert.ok(adjacent[0]);
    assert.ok(adjacent[1]);
    assert.equal(adjacent[0].layout.kind, 'inline');
    assert.equal(adjacent[1].layout.kind, 'inline');
  });

  test('counts Unicode code points in columns', () => {
    assert.deepEqual(TurfScanner.getSourcePosition('😀<!-- $value -->', 2), {
      offset: 2,
      line: 1,
      column: 2
    });
  });

  test('rejects unclosed comments', () => {
    assert.throws(() => TurfScanner.scan('before <!-- unfinished', { file: '/page.turf' }), {
      code: 'TURF_UNCLOSED_COMMENT',
      file: '/page.turf',
      line: 1,
      column: 8
    });
  });

  test('rejects nested ordinary comments', () => {
    assert.throws(() => TurfScanner.scan('<!-- outer <!-- inner --> -->'), { code: 'TURF_NESTED_COMMENT' });
  });
});
