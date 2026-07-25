import { BACKEND_BASE_URL } from '../constants';
import type { NodeFileResponse } from '../types';

export class BackendError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'BackendError';
  }
}

/** Decodes base64 into bytes (the payload may be binary). */
export const decodeBase64 = (b64: string): Uint8Array => {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

/**
 * Fetches a file from a node through the plugin backend.
 *
 * The request goes via the console's plugin proxy, which is declared with
 * `authorization: UserToken` so the backend receives the *caller's* OAuth
 * token and acts as them. A user who cannot already exec into the
 * file-integrity namespace gets a 403 from the API server, not from us.
 */
export const fetchNodeFile = async (
  node: string,
  filePath: string,
  fileIntegrity: string,
  signal?: AbortSignal,
): Promise<NodeFileResponse> => {
  const url =
    `${BACKEND_BASE_URL}/api/v1/nodes/${encodeURIComponent(node)}/file` +
    `?path=${encodeURIComponent(filePath)}` +
    `&fileIntegrity=${encodeURIComponent(fileIntegrity)}`;

  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal,
  });

  if (!response.ok) {
    let detail = response.statusText;
    try {
      // response.json() is `any`; narrow it before trusting the shape, since
      // an error body is exactly the case where the server may not have sent
      // what we expect.
      const body: unknown = await response.json();
      if (
        typeof body === 'object' &&
        body !== null &&
        'error' in body &&
        typeof body.error === 'string'
      ) {
        detail = body.error;
      }
    } catch {
      // Non-JSON error body; the status text will have to do.
    }
    throw new BackendError(detail, response.status);
  }

  return (await response.json()) as NodeFileResponse;
};

/** Renders bytes as a classic hex dump, for files that are not text. */
export const hexDump = (bytes: Uint8Array, maxBytes = 4096): string => {
  const slice = bytes.subarray(0, maxBytes);
  const lines: string[] = [];
  for (let offset = 0; offset < slice.length; offset += 16) {
    const row = slice.subarray(offset, offset + 16);
    const hex = Array.from(row)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ')
      .padEnd(47, ' ');
    const ascii = Array.from(row)
      .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.'))
      .join('');
    lines.push(`${offset.toString(16).padStart(8, '0')}  ${hex}  |${ascii}|`);
  }
  if (bytes.length > maxBytes) {
    lines.push(`... ${bytes.length - maxBytes} more bytes not shown`);
  }
  return lines.join('\n');
};
