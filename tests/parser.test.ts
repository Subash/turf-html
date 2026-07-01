import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { DirectiveSegment, GetOperation, PathOperation, SetOperation } from '../src/parser.ts';
import { TurfParser } from '../src/parser.ts';

function directive(source: string): DirectiveSegment {
  const segment = TurfParser.parse(source, { file: '/page.turf' }).segments.find(
    (candidate): candidate is DirectiveSegment => candidate.type === 'directive'
  );
  assert.ok(segment);
  return segment;
}

function setOperation(source: string): SetOperation {
  const operation = directive(source).operation;
  assert.equal(operation.type, 'set');
  return operation as SetOperation;
}

function getOperation(source: string): GetOperation {
  const operation = directive(source).operation;
  assert.equal(operation.type, 'get');
  return operation as GetOperation;
}

function pathOperation(source: string): PathOperation {
  const operation = directive(source).operation;
  assert.ok(operation.type === 'include' || operation.type === 'compile');
  return operation as PathOperation;
}

describe('TurfParser', () => {
  test('leaves ordinary comments ordinary', () => {
    const segment = TurfParser.parse('<!-- Example: @include header -->').segments[0];
    assert.ok(segment);
    assert.equal(segment.type, 'comment');
    assert.equal(segment.raw, '<!-- Example: @include header -->');
  });

  const assignments = [
    ['<!-- $Title Hello -->', 'Hello'],
    ['<!-- $Title = Hello -->', 'Hello'],
    ['<!-- $Title: Hello -->', 'Hello']
  ];

  for (const [source, value] of assignments) {
    test(`parses assignment form ${source}`, () => {
      assert.deepEqual(setOperation(source), {
        type: 'set',
        sigil: '$',
        name: 'title',
        originalName: 'Title',
        value,
        quoted: false
      });
    });
  }

  test('parses quoted values, escapes, padding, and literal nil', () => {
    assert.equal(setOperation('<!-- $value "  \\"nil\\"  " -->').value, '  "nil"  ');
    assert.equal(setOperation("<!-- $value 'it\\'s' -->").value, "it's");
    assert.equal(setOperation('<!-- $value `use \\`code\\`` -->').value, 'use `code`');
  });

  test('treats only unquoted lowercase nil as empty', () => {
    assert.equal(setOperation('<!-- $value nil -->').value, '');
    assert.equal(setOperation('<!-- $value "nil" -->').value, 'nil');
    assert.equal(setOperation('<!-- $value NIL -->').value, 'NIL');
  });

  test('parses required and optional reads case-insensitively', () => {
    assert.deepEqual(getOperation('<!-- @Page.Title -->'), {
      type: 'get',
      sigil: '@',
      name: 'page.title',
      originalName: 'Page.Title',
      optional: false
    });

    assert.equal(getOperation('<!-- $Subtitle? -->').optional, true);
    assert.equal(getOperation('<!-- $Τίτλος -->').name, 'τίτλος');
  });

  test('requires values after assignment syntax', () => {
    assert.throws(() => TurfParser.parse('<!-- $value = -->'), { code: 'TURF_MISSING_VARIABLE_VALUE' });
  });

  test('parses include aliases, modes, and quoted comma paths', () => {
    assert.deepEqual(pathOperation('<!-- @import-base64 "a,b.png", \'c d.png\', `e.png` -->'), {
      type: 'include',
      keyword: '@import-base64',
      base64: true,
      paths: ['a,b.png', 'c d.png', 'e.png']
    });
  });

  test('parses compile operations without selecting a delegate', () => {
    assert.deepEqual(pathOperation('<!-- @compile-base64 page.pug -->'), {
      type: 'compile',
      keyword: '@compile-base64',
      base64: true,
      paths: ['page.pug']
    });
  });

  test('does not prefix-match reserved keywords', () => {
    const operation = getOperation('<!-- @include-extra -->');
    assert.equal(operation.type, 'get');
    assert.equal(operation.name, 'include-extra');
  });

  test('allows wrapper newlines around a standalone instruction', () => {
    assert.deepEqual(pathOperation('<!--\n  @include header\n-->').paths, ['header']);
    assert.throws(() => TurfParser.parse('<!--\n@include\nheader\n-->'), { code: 'TURF_MULTILINE_DIRECTIVE' });
    assert.throws(() => TurfParser.parse('<p><!--\n$value\n--></p>'), { code: 'TURF_INLINE_MULTILINE_DIRECTIVE' });
  });

  test('rejects input that is not a scanner result', () => {
    assert.throws(() => new TurfParser(null), {
      name: 'TypeError',
      message: 'TurfParser expects the result of TurfScanner.scan().'
    });
  });

  test('keeps an unrecognized escape sequence verbatim', () => {
    assert.equal(setOperation('<!-- $value "a\\zb" -->').value, 'a\\zb');
  });

  test('rejects invalid variable names, markers, and trailing content', () => {
    assert.throws(() => TurfParser.parse('<!-- $9 -->'), { code: 'TURF_INVALID_VARIABLE_NAME' });
    assert.throws(() => TurfParser.parse('<!-- $name?x -->'), { code: 'TURF_INVALID_OPTIONAL_VARIABLE' });
    assert.throws(() => TurfParser.parse('<!-- $name!foo -->'), { code: 'TURF_INVALID_VARIABLE' });
  });

  test('rejects malformed quoted values', () => {
    assert.throws(() => TurfParser.parse('<!-- $value "abc"def -->'), { code: 'TURF_INVALID_QUOTED_VALUE' });
    assert.throws(() => TurfParser.parse('<!-- $value "abc -->'), { code: 'TURF_UNCLOSED_QUOTED_VALUE' });
    assert.throws(() => TurfParser.parse('<!-- $value "abc\\ -->'), { code: 'TURF_UNCLOSED_QUOTED_VALUE' });
  });

  test('treats an unkeywordable @ directive as a variable name', () => {
    assert.throws(() => TurfParser.parse('<!-- @=x -->'), { code: 'TURF_INVALID_VARIABLE_NAME' });
  });

  test('parses an escaped quote inside an include path', () => {
    assert.deepEqual(pathOperation('<!-- @include "a\\"b.png" -->').paths, ['a"b.png']);
  });

  test('rejects malformed include paths', () => {
    assert.throws(() => TurfParser.parse('<!-- @include -->'), { code: 'TURF_MISSING_PATH' });
    assert.throws(() => TurfParser.parse('<!-- @include a, -->'), { code: 'TURF_EMPTY_PATH' });
    assert.throws(() => TurfParser.parse('<!-- @include a"b"c -->'), { code: 'TURF_INVALID_QUOTED_PATH' });
    assert.throws(() => TurfParser.parse('<!-- @include "abc -->'), { code: 'TURF_UNCLOSED_QUOTED_PATH' });
  });

  test('retains directive token location and standalone envelope', () => {
    const parsed = directive('<main>\n  <!-- $Title Hello -->\n</main>');
    assert.deepEqual(parsed.location, { offset: 14, line: 2, column: 8 });
    assert.deepEqual(parsed.layout, {
      kind: 'standalone',
      indent: '  ',
      envelope: { start: 7, end: 31 }
    });
  });
});
