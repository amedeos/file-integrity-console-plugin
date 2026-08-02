import { render, screen } from '@testing-library/react';
import { HistoryError } from './HistoryError';

/*
 * The panel's error state, which until a browser was pointed at a console with
 * no Prometheus proxy had never been seen by anybody. It printed the single
 * word "Not Found".
 */

/** What the SDK's `HttpError` looks like from outside: a message and a code. */
const httpError = (code: number, message: string) =>
  Object.assign(new Error(message), { code });

describe('HistoryError', () => {
  it('says the monitoring could not be reached, not what the transport said', () => {
    render(<HistoryError error={httpError(404, 'Not Found')} />);

    expect(screen.getByText('Could not read the history')).toBeVisible();
    expect(
      screen.getByText(/^The console could not reach the cluster/),
    ).toBeVisible();
  });

  it('keeps the underlying message as detail rather than as the explanation', () => {
    // An administrator wants it; a reader should not have to interpret it.
    render(<HistoryError error={httpError(503, 'Service Unavailable')} />);

    expect(screen.getByText(/^The query failed with:/)).toBeVisible();
  });

  it('says a refusal is a refusal, since it is about this user alone', () => {
    // What the console's tenancy proxy answers to somebody who may not query
    // monitoring for the namespace. Reported as "could not reach", it would
    // read as a broken cluster rather than as a permission they lack.
    render(<HistoryError error={httpError(403, 'Forbidden')} />);

    expect(screen.getByText('Not allowed to read the history')).toBeVisible();
    expect(
      screen.getByText(/^You are not allowed to query monitoring data/),
    ).toBeVisible();
  });

  it('treats an unauthenticated session the same way', () => {
    render(<HistoryError error={httpError(401, 'Unauthorized')} />);

    expect(screen.getByText('Not allowed to read the history')).toBeVisible();
  });

  it('falls back to the general wording when there is no status at all', () => {
    render(<HistoryError error={new Error('network down')} />);

    expect(screen.getByText('Could not read the history')).toBeVisible();
  });
});
