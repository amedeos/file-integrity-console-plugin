# Working on this repository

Notes for anyone — human or agent — making changes here. They are the things
that are not visible from the code, or that have already gone wrong once.

`docs/IMPLEMENTATION-PLAN.md` holds the design and the **verified facts about
the File Integrity Operator's data model — do not re-derive them**.
`docs/STATUS.md` holds the current state, the deliberate departures from the
plan, and what is left to do. Read both before starting.

## Branches and commits

- **Never commit to `main`.** Branch first, open a pull request, let CI run.
  This applies to a one-line documentation fix as much as to a feature.
- One branch per concern. Two unrelated changes are two branches, so that each
  can be reviewed, reverted or held back on its own.
- **English** everywhere in the repository: code, comments, documents, commit
  messages. (Commits before 25 July 2026 are in Italian; they stay as they are,
  history is not rewritten to tidy it up.)
- Commit messages explain **why**, not what — the diff already says what. Six of
  the commits on this repository are the only place a particular decision is
  written down, and `git blame` is where the next person will look for it.
- Do not squash a branch into a single commit if its commits carry distinct
  decisions.

## Before you commit

```sh
yarn eslint src --max-warnings 0     # NOT `yarn lint`, which passes --fix
yarn tsc --noEmit
yarn test
( cd backend && go vet ./... && go test ./... && go build ./... )
helm lint charts/file-integrity-console-plugin --set plugin.image=example:1
```

`yarn lint` repairs instead of reporting, which hides a violation rather than
showing it. CI runs the form above.

Formatting is Prettier at `printWidth: 80`, which is how the whole codebase is
written. Do not raise it: a wider setting makes the next `--fix` reflow every
file it touches and buries real changes.

## Invariants — breaking one of these is a design change, not a tweak

- **The backend's ServiceAccount has no Role or ClusterRole.** Everything it
  does against the API server runs as the calling user, through
  `SelfSubjectReview` and `SelfSubjectAccessReview`. CI asserts that the chart
  renders no RBAC for it. If you find yourself needing a rule, something has
  started using the pod's identity instead of the caller's.
- **No service-account fallback.** A request without a bearer token is a 401.
  Never let it be served with the plugin's own credentials.
- **The deny list is checked before the caller is authenticated**, so probing
  costs nothing and is never attributed to a session. Keep that order.
- **`PLUGIN_NAME` in `src/constants.ts` must equal the ConsolePlugin name** the
  chart creates: the frontend builds its proxy URL from it. Changing one without
  the other breaks file retrieve with no visible error.
- **Do not lower `@console/pluginAPI` in `package.json`.** It is what makes an
  older console skip the plugin cleanly. Underneath it sit PatternFly and
  react-router majors that do not match; widening the bound alone turns a clean
  refusal into a page that renders unstyled and reads its route parameters as
  empty. Older consoles get their own branch — see `docs/STATUS.md`.
- **`locales/en` and `locales/it` stay key-for-key aligned.** A string added to
  one and not the other renders as a raw key. CI checks this.
- **The version is written in four places** — `version` and
  `consolePlugin.version` in `package.json`, `appVersion` and `version` in the
  chart — and a git tag is what names the released image. Keep them in step.

## Things that have already cost time

- **Helm parses YAML numbers as float64.** A default of `1048576` renders as
  `1.048576e+06` and crash-loops the pod. Numeric values passed as flags need
  `| int64`, and `helm template` must be exercised with the **defaults**, not
  only with `--set`, which passes strings.
- **The console caches a plugin's manifest at startup.** After deploying a new
  image, `oc rollout restart deployment/console -n openshift-console`, or the
  browser keeps loading the previous bundle however hard it is reloaded. The
  console-operator reverts the restart annotation, so check the pods actually
  got replaced.
- **`imagePullPolicy: IfNotPresent` with a mutable tag** lets the kubelet reuse
  the cached image: the rollout reports success while running the old binary.
  Use `Always` with `:latest`.
- **jsdom measures every element as zero-sized.** Layout and popper placement
  cannot be asserted in a unit test; do not write one that pretends otherwise.
  Test the interaction underneath and verify the appearance in a browser.

## Environment

`yarn` may not be on the PATH: the pinned release is committed, so
`node .yarn/releases/yarn-4.14.1.cjs <cmd>` always works. The Go toolchain and
`helm` are not always installed either — see the environment notes at the end of
`docs/STATUS.md`.
