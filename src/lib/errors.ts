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
