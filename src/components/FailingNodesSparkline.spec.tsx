import { render, screen } from '@testing-library/react';
import { FailingNodesSparkline } from './FailingNodesSparkline';
import { stepMillis } from '../lib/series';
import type { Sample } from '../lib/series';

/*
 * As with the band next door, jsdom measures every element as zero-sized, so
 * where the line goes is not assertable here — that arithmetic is `stepPaths`'
 * and is tested against numbers in series.spec.ts. What is worth pinning is
 * what the panel *says*, and in particular that it only says a period was not
 * collected when one was not.
 */

const step = stepMillis('24h');

/** Samples one step apart, which is what an uninterrupted window looks like. */
const run = (...values: number[]): Sample[] =>
  values.map((value, i) => ({ t: i * step, value }));

describe('FailingNodesSparkline', () => {
  it('says so when there is nothing to draw', () => {
    render(<FailingNodesSparkline samples={[]} timespan="24h" />);

    expect(screen.getByText('No samples in this window yet.')).toBeVisible();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('renders its summary rather than only speaking it', () => {
    // The first version put this in the aria-label alone, which is backwards:
    // a chart that needs a sentence needs it on the screen.
    render(<FailingNodesSparkline samples={run(0, 2, 1)} timespan="24h" />);

    expect(
      screen.getByText(/^Between 0 and \{\{peak\}\} nodes were reporting/),
    ).toBeVisible();
  });

  it('stays quiet about collection when the window is continuous', () => {
    render(<FailingNodesSparkline samples={run(1, 1, 1)} timespan="24h" />);

    expect(screen.queryByText(/Nothing was collected/)).toBeNull();
    expect(screen.queryByText('Not collected')).toBeNull();
  });

  it('names the stretch it did not measure instead of drawing through it', () => {
    // Two samples either side of a hole, both saying two nodes were failing.
    // The step line used to hold that value straight across the hole, which is
    // a claim about hours nobody scraped.
    const samples: Sample[] = [
      { t: 0, value: 2 },
      { t: step, value: 2 },
      { t: 8 * step, value: 2 },
      { t: 9 * step, value: 2 },
    ];
    render(<FailingNodesSparkline samples={samples} timespan="24h" />);

    expect(screen.getByText(/Nothing was collected during/)).toBeVisible();
    expect(screen.getByText('Not collected')).toBeVisible();
    expect(screen.getByText(/^Not collected, /)).toBeInTheDocument();
  });

  it('states how much time one sample stands for', () => {
    // The translation mock returns the key, so the unit is what is assertable
    // here; the numbers are `resolution`'s and are checked in series.spec.ts.
    const { rerender } = render(
      <FailingNodesSparkline samples={run(0, 1)} timespan="24h" />,
    );
    expect(
      screen.getByText('One sample every {{count}} minute(s).'),
    ).toBeVisible();

    rerender(<FailingNodesSparkline samples={run(0, 1)} timespan="30d" />);
    expect(
      screen.getByText('One sample every {{count}} hour(s).'),
    ).toBeVisible();
  });

  it('states where the window begins without claiming why', () => {
    const { rerender } = render(
      <FailingNodesSparkline samples={run(0, 1)} timespan="30d" />,
    );
    expect(screen.queryByText(/This window begins at/)).toBeNull();

    rerender(
      <FailingNodesSparkline
        samples={run(0, 1)}
        beginsAt={3 * step}
        timespan="30d"
      />,
    );
    expect(screen.getByText(/This window begins at/)).toBeVisible();
  });

  it('says how much of the window came back, and only when some is missing', () => {
    // A band drawn from one point is exactly as wide as one drawn from a
    // hundred and twenty, and nothing about its shape says which it is. On the
    // lab the 30-day window returned a single sample.
    const { rerender } = render(
      <FailingNodesSparkline samples={run(0, 1)} timespan="30d" />,
    );
    expect(screen.queryByText(/points asked for came back/)).toBeNull();

    rerender(
      <FailingNodesSparkline
        samples={run(0, 1)}
        sparse={{ returned: 1, requested: 120 }}
        timespan="30d"
      />,
    );
    expect(screen.getByText(/points asked for came back/)).toBeVisible();
  });
});
