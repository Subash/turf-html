import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import TurfSyntaxError from '../src/syntax-error.ts';
import compile from '../src/turf.ts';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

async function fixture(fileName: string) {
  const input = path.resolve(testDirectory, 'fixtures/input', fileName);
  const output = path.resolve(testDirectory, 'fixtures/output', fileName.replace(path.extname(fileName), '.html'));
  return {
    input,
    inputData: await fs.readFile(input, 'utf8'),
    outputData: await fs.readFile(output, 'utf8').catch(() => undefined)
  };
}

describe('compile', () => {
  test('compiler renders the basic fixture with the new pipeline', async () => {
    const file = await fixture('basic.kit');
    const result = await compile(file.inputData, { file: file.input });
    assert.equal(result, file.outputData);
  });

  test('compiler requires a compile delegate for compile directives', async () => {
    const file = await fixture('compile.kit');
    await assert.rejects(compile(file.inputData, { file: file.input }), (error) => {
      assert.ok(error instanceof TurfSyntaxError);
      assert.equal(error.code, 'TURF_MISSING_DELEGATE');
      assert.equal(error.message, 'No compile delegate is configured.');
      assert.equal(error.line, 10);
      return true;
    });
  });

  test('compiler resolves paths before invoking the compile delegate', async () => {
    const file = await fixture('basic.kit');
    const expectedPath = path.resolve(path.dirname(file.input), 'file.css');
    const output = await compile('<!-- @compile file.css -->', {
      file: file.input,
      compileDelegate: async (absolutePath) => {
        assert.equal(absolutePath, expectedPath);
        return 'compiled';
      }
    });

    assert.equal(output, 'compiled');
  });

  test('compiler resolves directory indexes', async () => {
    const file = await fixture('basic.kit');
    const directoryIndex = await compile('<!-- @include directory -->', { file: file.input });
    assert.equal(directoryIndex, 'directory index\n');
  });

  test('compiler prefers direct files over directory indexes', async () => {
    const file = await fixture('basic.kit');
    const directFile = await compile('<!-- @include precedence -->', { file: file.input });
    assert.equal(directFile, 'direct file\n');
  });

  test('resolves root-relative include paths against the root directory', async () => {
    const file = await fixture('basic.kit');
    const css = await compile('<!-- @include /file.css -->', { file: file.input });
    assert.equal(css, 'p {\n  color: red;\n}\n');
  });

  test('detects recursive includes', async () => {
    const file = await fixture('recursive.kit');
    await assert.rejects(compile(file.inputData, { file: file.input }), /Recursive include detected/);
  });

  test('reports a missing included file', async () => {
    const file = await fixture('basic.kit');
    await assert.rejects(
      compile('<!-- @include does-not-exist -->', { file: file.input }),
      /Failed to find the included file/
    );
  });

  test('includes non-template and compiled files as base64', async () => {
    const file = await fixture('basic.kit');
    const variables = { variable: 'V', another: 'A' };

    const rawCss = await fs.readFile(path.resolve(path.dirname(file.input), 'file.css'), 'utf8');
    const encodedCss = await compile('<!-- @include-base64 file.css -->', { file: file.input });
    assert.equal(Buffer.from(encodedCss, 'base64').toString('utf8'), rawCss);

    const plain = await compile('<!-- @include imported -->', { file: file.input, variables });
    const encoded = await compile('<!-- @include-base64 imported -->', { file: file.input, variables });
    assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), plain);
  });

  test('encodes compile delegate output as base64 and buffers', async () => {
    const file = await fixture('basic.kit');

    const encodedString = await compile('<!-- @compile-base64 file.css -->', {
      file: file.input,
      compileDelegate: async () => 'compiled'
    });
    assert.equal(Buffer.from(encodedString, 'base64').toString('utf8'), 'compiled');

    const encodedBuffer = await compile('<!-- @compile file.css -->', {
      file: file.input,
      compileDelegate: async () => Buffer.from('binary')
    });
    assert.equal(Buffer.from(encodedBuffer, 'base64').toString('utf8'), 'binary');
  });

  test('compiler requires an absolute file path', async () => {
    // @ts-expect-error Runtime validation must still reject omitted options.
    await assert.rejects(compile(''), {
      name: 'TypeError',
      message: 'file is required.'
    });

    await assert.rejects(compile('', { file: 'page.turf' }), {
      name: 'TypeError',
      message: 'file must be an absolute path.'
    });
  });
});
