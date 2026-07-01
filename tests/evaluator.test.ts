import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { EvaluatorOptions, RenderContext } from '../src/evaluator.ts';
import { TurfEvaluator } from '../src/evaluator.ts';
import { TurfParser } from '../src/parser.ts';

function render(source: string, options?: EvaluatorOptions): Promise<string> {
  return TurfEvaluator.evaluate(TurfParser.parse(source, { file: '/page.turf' }), options);
}

describe('TurfEvaluator', () => {
  test('evaluates assignments and reads in source order', async () => {
    const source = ['<!-- $name first -->', '<!-- $name -->', '<!-- $name second -->', '<!-- $name -->'].join('');
    assert.equal(await render(source), 'firstsecond');
  });

  test('reads initial variables case-insensitively with the last write winning', async () => {
    assert.equal(await render('<!-- $name -->', { variables: { Name: 'first', NAME: 'second' } }), 'second');
  });

  test('normalizes null and numeric initial variables to strings', async () => {
    assert.equal(await render('<!-- $empty -->:<!-- $count -->', { variables: { empty: null, count: 42 } }), ':42');
  });

  test('skips initial variables with an undefined value', async () => {
    assert.equal(await render('<p><!-- $skip? --></p>', { variables: { skip: undefined } }), '<p></p>');
  });

  test('does not mutate the caller variables object', async () => {
    const variables = { Name: 'value', empty: null, count: 42 };
    await render('<!-- $name -->', { variables });
    assert.deepEqual(variables, { Name: 'value', empty: null, count: 42 });
  });

  test('rejects missing required variables and allows optional reads', async () => {
    await assert.rejects(render('<!-- $missing -->'), {
      code: 'TURF_MISSING_VARIABLE',
      file: '/page.turf',
      line: 1,
      column: 6
    });
    assert.equal(await render('<p><!-- $missing? --></p>'), '<p></p>');
  });

  test('removes a standalone silent directive envelope', async () => {
    const source = '<body>\n  <!-- $title Hello -->\n  <h1><!-- $title --></h1>\n</body>';
    assert.equal(await render(source), '<body>\n  <h1>Hello</h1>\n</body>');
  });

  test('indents every non-empty standalone output line', async () => {
    const source = '<div>\n  <!-- @include card -->\n</div>';
    assert.equal(
      await render(source, { renderInclude: async () => '<section>\n  <p>Card</p>\n</section>\n' }),
      '<div>\n  <section>\n    <p>Card</p>\n  </section>\n</div>'
    );
  });

  test('joins multiple path outputs with one newline', async () => {
    const outputs: Record<string, string> = { first: 'A\n\n', second: '\n\nB' };
    assert.equal(
      await render('<!-- @include first, second -->', { renderInclude: async (path) => outputs[path] }),
      'A\nB'
    );
  });

  test('uses the configured compile delegate', async () => {
    assert.equal(
      await render('<!-- @compile page.pug -->', { compileDelegate: async (path) => `compiled:${path}` }),
      'compiled:page.pug'
    );
  });

  test('coalesces whitespace around inline silent directives', async () => {
    assert.equal(await render('<p>before <!-- $tmp value --> after</p>'), '<p>before after</p>');
    assert.equal(await render('<p>before<!-- $tmp value --> after</p>'), '<p>before after</p>');
    assert.equal(await render('<p>before\t<!-- $tmp value -->\tafter</p>'), '<p>before\tafter</p>');
  });

  test('does not coalesce empty output-producing directives', async () => {
    assert.equal(await render('<p>before <!-- $missing? --> after</p>'), '<p>before  after</p>');
  });

  test('rejects input that is not a parsed source', () => {
    assert.throws(() => TurfEvaluator.evaluate(null as never), {
      name: 'TypeError',
      message: 'TurfEvaluator expects the result of TurfParser.parse().'
    });
  });

  test('rejects invalid initial variables', () => {
    assert.throws(() => render('', { variables: [] as never }), {
      name: 'TypeError',
      message: 'variables must be a plain object.'
    });
    assert.throws(() => render('', { variables: { bad: true } as never }), { code: 'TURF_INVALID_VARIABLE_VALUE' });
  });

  test('rejects an unknown operation type', async () => {
    const parsed = { source: '', segments: [{ type: 'directive', operation: { type: 'mystery' } }] };
    await assert.rejects(TurfEvaluator.evaluate(parsed as never), {
      name: 'TypeError',
      message: 'Unknown operation type.'
    });
  });

  test('rejects includes without a renderer and non-string renderer output', async () => {
    await assert.rejects(render('<!-- @include header -->'), { code: 'TURF_MISSING_INCLUDE' });
    await assert.rejects(render('<!-- @include header -->', { renderInclude: (() => 42) as never }), {
      name: 'TypeError',
      message: 'include renderer must return a string.'
    });
  });

  test('adds a trailing newline to standalone output that lacks one', async () => {
    assert.equal(
      await render('<div>\n  <!-- @include card -->\n</div>', { renderInclude: async () => 'X' }),
      '<div>\n  X\n</div>'
    );
  });

  test('gives each rendered path an isolated variable snapshot', async () => {
    const snapshots: Array<Record<string, string>> = [];
    await render('<!-- $value parent --><!-- @include first, second -->', {
      renderInclude: async (_path: string, context: RenderContext) => {
        snapshots.push({ ...context.variables });
        context.variables.value = 'changed';
        return '';
      }
    });
    assert.deepEqual(snapshots, [{ value: 'parent' }, { value: 'parent' }]);
  });
});
