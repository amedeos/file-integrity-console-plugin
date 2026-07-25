/**
 * Routing, in one place.
 *
 * The router comes from the console at runtime, and which package provides it
 * depends on the console generation: `react-router-dom` v5 up to 4.21,
 * `react-router` v7 from 4.22. Both export `Link` and `useParams` with
 * compatible enough shapes for what this plugin does, so a release branch only
 * has to change the import line below.
 *
 * Importing the package directly from a component is what makes that a
 * many-file change instead of a one-file change — and, worse, a silent one:
 * a component holding a different copy of the router than the console sees no
 * route context at all, so `useParams()` returns an empty object and the page
 * renders as though the node simply did not exist.
 */
export { Link, useParams } from 'react-router';
