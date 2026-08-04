import { render, screen } from '@testing-library/react';
import { StatusTimeline } from './StatusTimeline';
import type { Segment } from '../lib/series';

/*
 * What this can and cannot check.
 *
 * jsdom measures every element as zero-sized, so the band's geometry — where a
 * rectangle starts, how wide it is, whether a one-sample failure survived being
 * scaled down — is not assertable here and a test claiming otherwise would be
 * decoration. That arithmetic lives in `src/lib/series.ts` and is tested there
 * against numbers.
 *
 * What is left, and is worth pinning, is what the band *says*: its accessible
 * label, the sentence beneath it, and whether the warning about a short range
 * appears only when the range is short.
 */

const hour = 60 * 60 * 1000;

const segments = (...states: Segment['state'][]): Segment[] =>
  states.map((state, i) => ({ from: i * hour, to: (i + 1) * hour, state }));

describe('StatusTimeline', () => {
  it('says so when there is nothing to draw', () => {
    render(<StatusTimeline segments={[]} failures={0} timespan="24h" />);

    expect(screen.getByText('No samples in this window yet.')).toBeVisible();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('describes a quiet window in its accessible label', () => {
    render(
      <StatusTimeline
        segments={segments('ok', 'ok')}
        failures={0}
        timespan="24h"
      />,
    );

    expect(
      screen.getByRole('img', {
        name: /No changes detected on this node during/,
      }),
    ).toBeInTheDocument();
  });

  it('stops naming the window when the data does not cover it', () => {
    // The 30-day band on the lab: one sample, drawn full width, saying "no
    // changes detected on this node during the last 30 days" — a month
    // asserted from one observation taken that afternoon. The head of the
    // window is grey now, and the sentence has to match it.
    render(
      <StatusTimeline
        segments={segments('gap', 'ok')}
        failures={0}
        timespan="30d"
      />,
    );

    expect(
      screen.getByRole('img', {
        name: /No changes detected on this node in what was collected\./,
      }),
    ).toBeInTheDocument();
  });

  it('describes the periods when changes were being reported', () => {
    render(
      <StatusTimeline
        segments={segments('ok', 'failed', 'ok')}
        failures={1}
        timespan="7d"
      />,
    );

    expect(
      screen.getByRole('img', { name: /Changes were being reported/ }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Entered the failed state/)).toBeVisible();
  });

  it('says what the three colours mean, so the band does not rely on colour', () => {
    // A node failing all window draws one red bar and nothing else. Without
    // these words there is no way to know what red was — nor what grey is,
    // which is the one a reader has never seen before.
    render(
      <StatusTimeline
        segments={segments('failed')}
        failures={1}
        timespan="24h"
      />,
    );

    expect(screen.getByText('Changes reported')).toBeVisible();
    expect(screen.getByText('No changes')).toBeVisible();
    expect(screen.getByText('Not collected')).toBeVisible();
  });

  it('says a period was not collected rather than colouring it in', () => {
    // The defect: a gap between two failing runs used to be painted red, so
    // the band asserted a node had been failing through hours nobody scraped.
    render(
      <StatusTimeline
        segments={segments('failed', 'gap', 'failed')}
        failures={2}
        timespan="7d"
      />,
    );

    expect(
      screen.getByRole('img', { name: /Nothing was collected during/ }),
    ).toBeInTheDocument();
    expect(screen.getByText(/^Not collected, /)).toBeInTheDocument();
  });

  it('stays quiet about collection when nothing is missing', () => {
    render(
      <StatusTimeline
        segments={segments('ok', 'failed')}
        failures={1}
        timespan="24h"
      />,
    );

    expect(screen.queryByText(/Nothing was collected/)).toBeNull();
  });

  it('states how much time one sample stands for, which the window changes', () => {
    // Twelve minutes and six hours draw the same rectangle. Without this the
    // 30-day band reads as if it had the 24-hour band's resolution, and a
    // single sample looks like a six-hour incident.
    const { rerender } = render(
      <StatusTimeline segments={segments('ok')} failures={0} timespan="24h" />,
    );
    expect(screen.getByText('One sample every 12 minute(s).')).toBeVisible();

    rerender(
      <StatusTimeline segments={segments('ok')} failures={0} timespan="30d" />,
    );
    expect(screen.getByText('One sample every 6 hour(s).')).toBeVisible();
  });

  it('names the period each run covers, for the browser to show on hover', () => {
    render(
      <StatusTimeline
        segments={segments('ok', 'failed')}
        failures={1}
        timespan="24h"
      />,
    );

    // An SVG <title> is what a browser turns into a tooltip. Testing Library
    // exposes it by its own role, which is the one thing here jsdom can judge.
    expect(screen.getByText(/^Changes reported, /)).toBeInTheDocument();
    expect(screen.getByText(/^No changes, /)).toBeInTheDocument();
  });

  it('does not claim a failure count of zero', () => {
    render(
      <StatusTimeline segments={segments('ok')} failures={0} timespan="24h" />,
    );

    expect(screen.queryByText(/Entered the failed state/)).toBeNull();
  });

  it('says where the data begins without claiming why', () => {
    const { rerender } = render(
      <StatusTimeline segments={segments('ok')} failures={0} timespan="30d" />,
    );
    expect(screen.queryByText(/Data begins at/)).toBeNull();

    rerender(
      <StatusTimeline
        segments={segments('ok')}
        beginsAt={3 * hour}
        failures={0}
        timespan="30d"
      />,
    );
    // "This window begins at" was the old wording. The window now begins where
    // the band does, grey; what begins late is the data.
    expect(screen.getByText(/Data begins at/)).toBeVisible();
  });

  it('says how much of the window came back, and only when some is missing', () => {
    // A band drawn from one point is exactly as wide as one drawn from a
    // hundred and twenty, and nothing about its shape says which it is. On the
    // lab the 30-day window returned a single sample.
    const { rerender } = render(
      <StatusTimeline segments={segments('ok')} failures={0} timespan="30d" />,
    );
    expect(screen.queryByText(/points asked for came back/)).toBeNull();

    rerender(
      <StatusTimeline
        segments={segments('ok')}
        sparse={{ returned: 1, requested: 120 }}
        failures={0}
        timespan="30d"
      />,
    );
    expect(screen.getByText(/points asked for came back/)).toBeVisible();
  });
});
