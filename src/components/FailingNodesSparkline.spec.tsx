import { render, screen } from '@testing-library/react';
import { FailingNodesSparkline } from './FailingNodesSparkline';
import { SAMPLES, stepMillis } from '../lib/series';
import type { Sample } from '../lib/series';

/*
 * As with the band next door, jsdom measures every element as zero-sized, so
 * where the line goes is not assertable here — that arithmetic is `stepPaths`'
 * and is tested against numbers in series.spec.ts. What is worth pinning is
 * what the panel *says*, and in particular that it only says a period was not
 * collected when one was not.
 */

const step = stepMillis('24h');

/** Samples one step apart: a run of collection, not necessarily a full window. */
const run = (...values: number[]): Sample[] =>
  values.map((value, i) => ({ t: i * step, value }));

/**
 * A window that came back as full as it was asked for.
 *
 * A handful of samples is *not* that, and the difference is now visible: the
 * panel draws the window rather than the data, so three points in a 24-hour
 * window are three points and a great deal of grey. Anything asserting that
 * nothing is missing has to hand it a whole window.
 */
const fullWindow = (value: number): Sample[] =>
  Array.from({ length: SAMPLES }, (_, i) => ({ t: i * step, value }));

describe('FailingNodesSparkline', () => {
  it('says so when there is nothing to draw', () => {
    render(<FailingNodesSparkline samples={[]} timespan="24h" />);

    expect(screen.getByText('No samples in this window yet.')).toBeVisible();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('renders its summary rather than only speaking it', () => {
    // The first version put this in the aria-label alone, which is backwards:
    // a chart that needs a sentence needs it on the screen.
    render(<FailingNodesSparkline samples={fullWindow(2)} timespan="24h" />);

    expect(
      screen.getByText(/^Between 0 and \{\{peak\}\} nodes were reporting/),
    ).toBeVisible();
  });

  it('stays quiet about collection when the window is continuous', () => {
    render(<FailingNodesSparkline samples={fullWindow(1)} timespan="24h" />);

    expect(screen.queryByText(/Nothing was collected/)).toBeNull();
    expect(screen.queryByText('Not collected')).toBeNull();
  });

  it('draws a single sample instead of reporting an empty window', () => {
    // Exactly what the 30-day window returned on the lab. `stepPaths` gave up
    // on a span of zero, so the panel said there was nothing where there was
    // one point — while the band beside it drew that same point over a month.
    render(
      <FailingNodesSparkline samples={[{ t: 0, value: 2 }]} timespan="30d" />,
    );

    expect(screen.queryByText('No samples in this window yet.')).toBeNull();
    expect(screen.getByRole('img')).toBeInTheDocument();
  });

  it('marks the head of a window whose data begins late', () => {
    // Three samples in a 24-hour window are three samples, not a day of them.
    // Nothing but the window's own length can say that, which is why the panel
    // now knows it.
    render(<FailingNodesSparkline samples={run(1, 1, 1)} timespan="24h" />);

    expect(screen.getByText(/Nothing was collected during/)).toBeVisible();
    expect(screen.getByText('Not collected')).toBeVisible();
  });

  it('stops naming the window in the summary when the data does not cover it', () => {
    // "during the last 30 days" from four points is a claim about the
    // twenty-nine days nobody looked at.
    render(<FailingNodesSparkline samples={run(1, 1, 1)} timespan="30d" />);

    expect(
      screen.getByText(/nodes were reporting changes in what was collected/),
    ).toBeVisible();
  });

  it('names the stretch it did not measure instead of drawing through it', () => {
    // Two samples either side of a hole, both saying two nodes were failing.
    // The step line used to hold that value straight across the hole, which is
    // a claim about hours nobody scraped.
    //
    // A whole window with a hole punched in it, rather than four samples: the
    // head of a short window is a gap too now, and this test is about the one
    // in the middle.
    const samples: Sample[] = fullWindow(2).filter((_, i) => i < 40 || i > 60);
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

  it('says where the data begins without claiming why', () => {
    const { rerender } = render(
      <FailingNodesSparkline samples={run(0, 1)} timespan="30d" />,
    );
    expect(screen.queryByText(/Data begins at/)).toBeNull();

    rerender(
      <FailingNodesSparkline
        samples={run(0, 1)}
        beginsAt={3 * step}
        timespan="30d"
      />,
    );
    // "This window begins at" was the old wording, and it is now the axis that
    // says where the window begins — the sentence is about the data.
    expect(screen.getByText(/Data begins at/)).toBeVisible();
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
