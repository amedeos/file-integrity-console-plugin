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
- **`@console/pluginAPI` is a closed range on a release branch, and both ends
  carry `-0`.** `>=4.16.0-0 <4.19.0-0`, not `>=4.16.0`. The floor keeps the
  plugin off consoles that predate it; the ceiling keeps it off newer ones,
  where the same build is equally wrong. The `-0` suffixes are what make the
  bound match a nightly or EC build, whose version is a prerelease.
- **Never widen the bound instead of branching.** What is underneath is not a
  question of degree. Observed on a real 4.16 console, told to load a 4.22
  build: `__load_plugin_entry__ is not defined`, then "loaded without entry
  callback" — the entry-registration contract between console and plugin changed
  at 4.22, so the plugin does not execute at all. Below that sit the PatternFly
  and react-router majors, which would produce their own failures if execution
  ever got that far. A build belongs to one generation; widening a bound does
  not make it belong to two.
- **Nothing outside `src/lib/k8s.ts`, `src/lib/router.ts` and `src/lib/styles.ts`
  may name a console-versioned API.** No component imports
  `@openshift-console/dynamic-plugin-sdk` or `react-router` directly, and none
  writes a `pf-v6-` class name or a `--pf-t--global--*` token inline. Those three
  files are where a console generation's differences live, and they are what
  keeps a release branch to three files plus dependency pins instead of twenty.
  See [Supporting more than one console generation](#supporting-more-than-one-console-generation).
- **`locales/en` and `locales/it` stay key-for-key aligned.** A string added to
  one and not the other renders as a raw key. CI checks this.
- **The version is written in four places** — `version` and
  `consolePlugin.version` in `package.json`, `appVersion` and `version` in the
  chart — and a git tag is what names the released image. Keep them in step.
- **A release branch's version carries its generation**: `0.1.1-ocp4.16`, not
  `0.1.1`. Valid semver, accepted by the manifest schema, and the console then
  displays which build is installed. Without it, the same `v0.1.1` cut on two
  branches produces two different images racing for one image tag — and with
  `IfNotPresent` the loser is invisible.

## Supporting more than one console generation

`main` targets OpenShift 4.22 and later. Older consoles are served by release
branches, because the frameworks the console shares with plugins change under
them. There are **three** generations between 4.16 and 4.22, not two:

| | 4.16 – 4.18 | 4.19 – 4.21 | 4.22+ (`main`) |
|---|---|---|---|
| PatternFly | 5.1 | 6.2 | 6.4 |
| React | 17 | 17 | 18 |
| router | `react-router-dom` 5.3 | `react-router-dom` 5.3 | `react-router` 7.13 |
| SDK | 1.2.0 (webpack 1.1.0) | `4.19-latest` | `4.22-latest` |
| `@console/pluginAPI` | `>=4.16.0-0 <4.19.0-0` | `>=4.19.0-0 <4.22.0-0` | `>=4.22.0-0` |

PatternFly breaks at 4.19; React and the router break at 4.22. The middle
generation is a subset of neither neighbour.

A release branch differs from `main` in the three shim modules, the dependency
pins in `package.json`, the `@console/pluginAPI` bound, and — for the PatternFly
5 branch only — the component markup.

### Test against another generation without another cluster

`quay.io/openshift/origin-console` publishes a tag per release, and a published
plugin image already serves the assets over plain HTTP. Two containers, no node
toolchain and no second cluster — `podman` and `oc` are the whole requirement:

```sh
podman run -d --rm --name fio-plugin --network=host \
  quay.io/asalvati/file-integrity-console-plugin:latest \
  --listen=:9001 --tls-cert-file= --tls-key-file=

podman run --rm --network=host \
  -e BRIDGE_USER_AUTH=disabled \
  -e BRIDGE_K8S_MODE=off-cluster \
  -e BRIDGE_K8S_AUTH=bearer-token \
  -e BRIDGE_K8S_MODE_OFF_CLUSTER_SKIP_VERIFY_TLS=true \
  -e BRIDGE_K8S_MODE_OFF_CLUSTER_ENDPOINT="$(oc whoami --show-server)" \
  -e BRIDGE_K8S_AUTH_BEARER_TOKEN="$(oc whoami --show-token)" \
  -e BRIDGE_USER_SETTINGS_LOCATION=localstorage \
  -e BRIDGE_I18N_NAMESPACES=plugin__file-integrity-console-plugin \
  -e BRIDGE_PLUGINS=file-integrity-console-plugin=http://localhost:9001 \
  -e BRIDGE_RELEASE_VERSION=4.16.55 \
  quay.io/openshift/origin-console:4.16
```

Console on http://localhost:9000; `podman rm -f fio-plugin` afterwards. Change
the console tag to test another generation, and the plugin image tag to test
another branch's build — Quay tags by branch, so `release-4.16` is there as soon
as the branch is pushed.

Two things this buys that a cluster does not:

- `BRIDGE_RELEASE_VERSION` is what makes the version gate evaluate at all. With
  it unset the console skips the check entirely, so a local run proves nothing
  about the bound unless it is set.
- The image tag and the declared version are **independent**. Declaring 4.22.5
  to a 4.16 console forces it past the gate and shows what the mismatch actually
  does — which is how the entry-callback failure above was found. Use a real
  z-stream from the `stable-4.x` channel rather than an invented one.

### Details worth not rediscovering

- **Do not downgrade TypeScript on a release branch**, whatever the template
  branch does. `src/lib/decode.ts` uses `Uint8Array<ArrayBuffer>` (generic only
  from the TS 5.7 lib) and the `DecompressionStream` type (5.2);
  `src/lib/backend.ts` relies on `in`-operator narrowing (4.9);
  `src/lib/aide-parser.ts` uses `Array.prototype.at` (ES2022 lib). Downgrading
  forces edits to `src/lib/`, which is exactly the code that must stay identical
  across branches. Nothing requires it: TypeScript never reaches the browser and
  the old SDK's peer range has no upper bound. Keep `tsconfig.json` identical
  everywhere.
- The SDK's function names differ, opposite to the obvious guess: **4.22 exports
  only `k8sGet` / `k8sPatch`**, while 4.16 and 4.19 export `k8sGetResource` /
  `k8sPatchResource`. `src/lib/k8s.ts` keeps the 4.22 spelling as this plugin's
  vocabulary; older branches alias to it.
- **On 4.16–4.18 PatternFly is a module the console *shares* with plugins**, with
  a fallback allowed; from 4.19 it is not shared and the plugin bundles its own.
  So on the oldest generation the components that actually render may come from
  the console's PatternFly build rather than the one in the lockfile — a
  component missing there fails at runtime, in the browser, with CI green.
  Check this against the real console image before designing around any
  particular PatternFly 5 API.

**Paths that must never diverge between branches:** `backend/`, `charts/`,
`Containerfile`, `.github/workflows/ci.yml`, `console-extensions.json`,
`locales/`, `tsconfig.json`, and all of `src/lib/` except the three shims.
Author changes to those on `main` and merge `main` forward into the release
branches — never rebase a pushed branch, and never author the change on the
branch. The first backend fix written directly on a release branch is where
three branches quietly become three products.

Discipline is not the mechanism. CI on a release branch should assert that
`git diff --name-only origin/main HEAD` contains nothing outside that branch's
declared delta, so a fix landing on `main` does not merely fail to arrive — it
turns the release branch red until someone merges it.

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
- **A control character in a source file makes the whole file invisible.** A raw
  NUL byte reached `src/components/FileContentModal.tsx` where an escape
  sequence was meant. Git then reported the file as binary and `grep` skipped it
  without a word, so a repository-wide search for PatternFly class names
  answered "none" while three sat in that file. Write control characters as
  escapes, and treat `Bin ... bytes` in a `git diff --stat` of a source file as
  a defect rather than a curiosity. CI checks this on every pull request; to
  check the tree by hand:

  ```sh
  for f in $(git ls-files); do
    LC_ALL=C tr -d '\0' < "$f" | cmp -s - "$f" || echo "$f"
  done
  ```

  Note what this does *not* use. `grep -P '\x00'` finds nothing, because grep
  refuses to search a file it has decided is binary — the same silence that let
  the byte through in the first place.

## Environment

`yarn` may not be on the PATH: the pinned release is committed, so
`node .yarn/releases/yarn-4.14.1.cjs <cmd>` always works. The Go toolchain and
`helm` are not always installed either — see the environment notes at the end of
`docs/STATUS.md`.
