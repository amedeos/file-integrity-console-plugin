import { errorMessage, httpStatus } from './errors';

describe('errorMessage', () => {
  it('reads an Error', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('reads a bare object carrying a message, which is what the SDK rejects with', () => {
    expect(errorMessage({ message: 'forbidden' })).toBe('forbidden');
  });

  it('says something rather than [object Object]', () => {
    expect(errorMessage({})).toBe('unknown error');
    expect(errorMessage(undefined)).toBe('unknown error');
  });
});

describe('httpStatus', () => {
  // Read off the field rather than the class: only src/lib/k8s.ts may import
  // from the SDK, and a rejection that did not come from its fetch still
  // carries the same field with the same meaning.
  it('finds the code the SDK and a Kubernetes Status both use', () => {
    expect(
      httpStatus(Object.assign(new Error('Forbidden'), { code: 403 })),
    ).toBe(403);
    expect(httpStatus({ code: 404 })).toBe(404);
  });

  it('says nothing when there is no status to report', () => {
    expect(httpStatus(new Error('network down'))).toBeUndefined();
    expect(httpStatus({ code: '403' })).toBeUndefined();
    expect(httpStatus(undefined)).toBeUndefined();
  });
});
