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
 *
 * `useParams` is wrapped rather than re-exported because the two generations
 * disagree about the return type: v7 types every parameter as possibly
 * undefined, v5 types them as present. A component written against v5's
 * promise would have its `?? ''` flagged as dead code here and be a latent
 * crash on 4.22, so this shim narrows both to the weaker of the two. The
 * runtime value is the same object either way; only the type differs.
 */
import { useParams as useRouterParams } from 'react-router-dom';

export { Link } from 'react-router-dom';

export const useParams = <T extends Record<string, string>>(): Partial<T> =>
  useRouterParams<Partial<T>>();
