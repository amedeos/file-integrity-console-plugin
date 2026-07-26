/**
 * Routing, in one place.
 *
 * The router comes from the console at runtime, and which package provides it
 * depends on the console generation: `react-router` v7 from 4.22,
 * `react-router-dom-v5-compat` before it. Both export `Link` and `useParams`
 * with compatible enough shapes for what this plugin does, so a release branch
 * only has to change the import line below.
 *
 * The compat package rather than `react-router-dom`, even though this console
 * generation runs v5: `frontend/public/components/app-contents.tsx` builds the
 * plugin page routes with `Route` and `Routes` imported from the compat
 * package, so a plugin component is mounted inside the v6 context, not the v5
 * one. Both contexts exist — the console nests `CompatRouter` inside the v5
 * router — which is what makes the wrong choice fail silently rather than
 * throw. It is also a singleton shared module with no fallback, so the copy
 * used is the console's own.
 *
 * Importing the package directly from a component is what makes that a
 * many-file change instead of a one-file change — and, worse, a silent one.
 * Observed on 4.16 with `react-router-dom` here: `useParams()` returned an
 * empty object, and the node report page reported the node as missing from the
 * cluster, naming it as the empty string. Nothing failed; the page was simply
 * answering a question about a node called "".
 */
export { Link, useParams } from 'react-router-dom-v5-compat';
