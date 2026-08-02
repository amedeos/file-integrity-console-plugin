/**
 * Renders an unknown thrown value as something worth showing a user.
 *
 * `catch` and rejected promises hand back `unknown`, and casting that to Error
 * is a lie: the console SDK rejects with plain objects, and `String()` on one
 * of those produces "[object Object]", which tells the reader nothing about
 * what went wrong.
 */
export const errorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  // Kubernetes API rejections are frequently a bare object carrying a message.
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message;
  }
  if (typeof error === 'number' || typeof error === 'boolean') {
    return String(error);
  }
  return 'unknown error';
};

/**
 * The HTTP status a rejection carries, when it carries one.
 *
 * The console SDK's `HttpError` puts it in `code`, and so does a Kubernetes
 * `Status` object — the same number meaning the same thing, which is why this
 * reads the field rather than the class. Reading the class would mean importing
 * from `@openshift-console/dynamic-plugin-sdk`, and only `src/lib/k8s.ts` may
 * do that; it would also make the check fail silently against any rejection
 * that did not come from the SDK's own fetch.
 *
 * It exists because a status text is not an explanation. "Not Found" was shown
 * to a reader whose console simply had no Prometheus proxy configured, and the
 * number is what separates that from "you may not query this", which is the
 * same panel refusing for an entirely different reason.
 */
export const httpStatus = (error: unknown): number | undefined =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  typeof error.code === 'number'
    ? error.code
    : undefined;
