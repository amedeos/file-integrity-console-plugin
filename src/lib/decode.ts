import { ANNOTATIONS, INTEGRITY_LOG_CONTENT_KEY } from '../constants';

/** Minimal shape of the result ConfigMap we care about. */
export interface ResultConfigMap {
  metadata?: {
    name?: string;
    namespace?: string;
    annotations?: Record<string, string>;
  };
  data?: Record<string, string>;
}

/** Decodes a base64 string into bytes without pulling in a Buffer polyfill. */
const base64ToBytes = (b64: string): Uint8Array<ArrayBuffer> => {
  // The operator base64-encodes with standard alphabet and no line wrapping,
  // but be forgiving about stray whitespace.
  const binary = atob(b64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

/**
 * Gunzips bytes using the platform DecompressionStream.
 *
 * Available in every browser the OpenShift console supports, so no dependency
 * is needed. The source stream is built by hand rather than via `Blob.stream()`
 * and drained with a plain reader rather than via `Response`, so the only
 * platform APIs required are ReadableStream and DecompressionStream.
 */
const gunzip = async (bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> => {
  const DS = (
    globalThis as { DecompressionStream?: typeof DecompressionStream }
  ).DecompressionStream;
  if (!DS) {
    throw new Error('DecompressionStream is unavailable in this environment');
  }

  // Typed as BufferSource to line up with DecompressionStream's writable side.
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

  const reader = source.pipeThrough(new DS('gzip')).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    total += value.length;
  }

  const out = new Uint8Array(total);
  let offset = 0;
  chunks.forEach((chunk) => {
    out.set(chunk, offset);
    offset += chunk.length;
  });
  return out;
};

/**
 * Extracts the AIDE report text out of a File Integrity Operator result
 * ConfigMap.
 *
 * The operator stores the report under `data.integritylog`. When the raw report
 * exceeds the etcd object limit it is gzipped and then base64-encoded, which is
 * signalled by the `file-integrity.openshift.io/compressed` annotation being
 * present (its value is the empty string, so test for presence, not truth).
 */
export const extractIntegrityLog = async (
  cm: ResultConfigMap,
): Promise<string> => {
  const content = cm.data?.[INTEGRITY_LOG_CONTENT_KEY];
  if (content === undefined) {
    throw new Error(
      `ConfigMap ${cm.metadata?.name ?? '<unknown>'} has no "${INTEGRITY_LOG_CONTENT_KEY}" key`,
    );
  }

  const annotations = cm.metadata?.annotations ?? {};
  if (!(ANNOTATIONS.compressed in annotations)) {
    return content;
  }

  const plain = await gunzip(base64ToBytes(content));
  return new TextDecoder().decode(plain);
};

/** Reads one of the operator's numeric summary annotations. */
export const readCountAnnotation = (
  cm: ResultConfigMap,
  key: string,
): number | undefined => {
  const raw = cm.metadata?.annotations?.[key];
  if (raw === undefined) {
    return undefined;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? undefined : n;
};
