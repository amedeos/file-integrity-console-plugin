import { BackendError, fetchNodeFile } from './backend';

/*
 * Only the discriminator is tested here, because only the discriminator can be
 * got wrong in a way nothing else notices.
 *
 * The plugin's backend writes `{"error": …}` for every failure it produces. An
 * error body that is not that shape therefore did not come from it — it came
 * from the console's plugin proxy in front, whose refusals carry the same
 * status codes. Reading a 404 as "the file is gone" made the dialog blame a
 * node for a request that never left the console, and no status code could
 * have told it otherwise.
 */

const respondWith = (status: number, body: string) => {
  global.fetch = jest.fn().mockResolvedValue({
    ok: false,
    status,
    statusText: 'Not Found',
    json: () => Promise.resolve(JSON.parse(body) as unknown),
  });
};

const read = () => fetchNodeFile('control-plane-0', '/etc/hosts', 'example');

describe('fetchNodeFile', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('takes the backend at its word when the backend is what answered', async () => {
    respondWith(404, '{"error":"no scan pod on this node"}');

    await expect(read()).rejects.toMatchObject({
      status: 404,
      message: 'no scan pod on this node',
      fromBackend: true,
    });
  });

  it('does not attribute a reply the backend did not send', async () => {
    // What a proxy 404 looks like: an HTML page, or nothing at all.
    respondWith(404, '<html>404 page not found</html>');

    const error = await read().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BackendError);
    expect(error).toMatchObject({
      status: 404,
      message: 'Not Found',
      fromBackend: false,
    });
  });

  it('does not attribute a JSON body of some other shape either', async () => {
    // An ingress or a gateway may well answer JSON; that does not make it ours.
    respondWith(503, '{"message":"no healthy upstream"}');

    await expect(read()).rejects.toMatchObject({
      status: 503,
      fromBackend: false,
    });
  });
});
