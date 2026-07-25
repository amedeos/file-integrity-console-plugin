import * as zlib from 'zlib';
import { ANNOTATIONS, INTEGRITY_LOG_CONTENT_KEY } from '../constants';
import { extractIntegrityLog, readCountAnnotation } from './decode';

// jsdom ships neither DecompressionStream nor ReadableStream, both of which
// exist in every browser the console supports. Polyfill from Node's web streams
// so the production code path is what gets exercised.
beforeAll(() => {
  const webStreams = require('node:stream/web');
  (globalThis as Record<string, unknown>).DecompressionStream =
    webStreams.DecompressionStream;
  (globalThis as Record<string, unknown>).ReadableStream =
    webStreams.ReadableStream;
  (globalThis as Record<string, unknown>).TextDecoder =
    require('node:util').TextDecoder;
});

const cm = (
  content: string,
  annotations: Record<string, string> = {},
): Parameters<typeof extractIntegrityLog>[0] => ({
  metadata: { name: 'aide-fi-node-failed', annotations },
  data: { [INTEGRITY_LOG_CONTENT_KEY]: content },
});

describe('extractIntegrityLog', () => {
  it('returns plain content unchanged', async () => {
    await expect(extractIntegrityLog(cm('hello report'))).resolves.toBe(
      'hello report',
    );
  });

  it('gunzips content marked with the compressed annotation', async () => {
    // Mirrors the operator: gzip, then base64 (cmd/manager/logcollector_util.go).
    const original = 'AIDE found differences\n'.repeat(500);
    const encoded = zlib.gzipSync(Buffer.from(original)).toString('base64');
    const result = await extractIntegrityLog(
      cm(encoded, { [ANNOTATIONS.compressed]: '' }),
    );
    expect(result).toBe(original);
  });

  it('treats the annotation as a flag, not a boolean value', async () => {
    // The operator sets it to the empty string, so a truthiness check on the
    // value would decompress nothing and show the user base64 noise.
    const original = 'compressed body';
    const encoded = zlib.gzipSync(Buffer.from(original)).toString('base64');
    await expect(
      extractIntegrityLog(cm(encoded, { [ANNOTATIONS.compressed]: '' })),
    ).resolves.toBe(original);
  });

  it('tolerates whitespace inside the base64 payload', async () => {
    const original = 'wrapped base64';
    const raw = zlib.gzipSync(Buffer.from(original)).toString('base64');
    const wrapped = raw.replace(/(.{10})/g, '$1\n');
    await expect(
      extractIntegrityLog(cm(wrapped, { [ANNOTATIONS.compressed]: '' })),
    ).resolves.toBe(original);
  });

  it('throws a useful error when the key is missing', async () => {
    await expect(
      extractIntegrityLog({ metadata: { name: 'broken-cm' }, data: {} }),
    ).rejects.toThrow(/broken-cm.*integritylog/);
  });
});

describe('readCountAnnotation', () => {
  it('parses numeric annotations', () => {
    const c = cm('x', { [ANNOTATIONS.filesAdded]: '12' });
    expect(readCountAnnotation(c, ANNOTATIONS.filesAdded)).toBe(12);
  });

  it('returns undefined for absent or non-numeric values', () => {
    const c = cm('x', { [ANNOTATIONS.filesAdded]: 'lots' });
    expect(readCountAnnotation(c, ANNOTATIONS.filesAdded)).toBeUndefined();
    expect(readCountAnnotation(c, ANNOTATIONS.filesRemoved)).toBeUndefined();
  });
});
