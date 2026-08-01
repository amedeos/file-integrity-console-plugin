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

const segments = (...failed: boolean[]): Segment[] =>
  failed.map((f, i) => ({ from: i * hour, to: (i + 1) * hour, failed: f }));

describe('StatusTimeline', () => {
  it('says so when there is nothing to draw', () => {
    render(<StatusTimeline segments={[]} failures={0} timespan="24h" />);

    expect(screen.getByText('No samples in this window yet.')).toBeVisible();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('describes a quiet window in its accessible label', () => {
    render(
      <StatusTimeline
        segments={segments(false, false)}
        failures={0}
        timespan="24h"
      />,
    );

    expect(
      screen.getByRole('img', { name: /No changes detected on this node/ }),
    ).toBeInTheDocument();
  });

  it('describes the periods when changes were being reported', () => {
    render(
      <StatusTimeline
        segments={segments(false, true, false)}
        failures={1}
        timespan="7d"
      />,
    );

    expect(
      screen.getByRole('img', { name: /Changes were being reported/ }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Entered the failed state/)).toBeVisible();
  });

  it('says what the two colours mean, so the band does not rely on colour', () => {
    // A node failing all window draws one red bar and nothing else. Without
    // these two words there is no way to know what red was.
    render(
      <StatusTimeline segments={segments(true)} failures={1} timespan="24h" />,
    );

    expect(screen.getByText('Changes reported')).toBeVisible();
    expect(screen.getByText('No changes')).toBeVisible();
  });

  it('names the period each run covers, for the browser to show on hover', () => {
    render(
      <StatusTimeline
        segments={segments(false, true)}
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
      <StatusTimeline segments={segments(false)} failures={0} timespan="24h" />,
    );

    expect(screen.queryByText(/Entered the failed state/)).toBeNull();
  });

  it('warns only when the data starts later than the window asked for', () => {
    const { rerender } = render(
      <StatusTimeline segments={segments(false)} failures={0} timespan="30d" />,
    );
    expect(screen.queryByText(/Data begins at/)).toBeNull();

    rerender(
      <StatusTimeline
        segments={segments(false)}
        beginsAt={3 * hour}
        failures={0}
        timespan="30d"
      />,
    );
    expect(screen.getByText(/Data begins at/)).toBeVisible();
  });
});
