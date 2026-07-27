# Working on this repository

Notes for anyone — human or agent — making changes here. They are the things
that are not visible from the code, or that have already gone wrong once.

`docs/IMPLEMENTATION-PLAN.md` holds the design and the **verified facts about
the File Integrity Operator's data model — do not re-derive them**.
`docs/STATUS.md` holds the current state, the deliberate departures from the
plan, and what is left to do. Read both before starting.

## Branches and commits

- **Never push to `main`, and never to a release branch either.** Branch first,
  open a pull request, let CI run. This applies to a one-line documentation fix
  as much as to a feature. A release branch is not a working branch: Quay builds
  an image on every push to it, so pushing directly publishes the tag and *then*
  runs CI — by the time the build goes red, the broken image is already
  something a user can pull.
- **A pull request merging `main` forward into a release branch is merged with a
  merge commit — never squashed, never rebased.** Squashing flattens it into a
  new commit and git loses the record that `main`'s commits are ancestors, so
  the next merge-forward re-presents the same changes as conflicts, and keeps
  doing it. Squash stays fine for a pull request carrying the branch's own
  delta. Rebasing is worse: it rewrites commits that have already been pushed
  and leaves the remote and every clone divergent, which is how `release-4.16`
  first diverged.
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

- **The backend's ServiceAccount is granted no rule.** Everything it does
  against the API server runs as the calling user, through `SelfSubjectReview`
  and `SelfSubjectAccessReview`. If you find yourself needing a rule, something
  has started using the pod's identity instead of the caller's.
  The chart says this by rendering no Role or ClusterRole at all, and CI asserts
  that. The OLM bundle cannot say it the same way: OLM creates a
  ServiceAccount only from `permissions`, and turns every entry there into a
  Role and a RoleBinding regardless of its rules. So the bundle declares one
  entry with an **empty rule list**, and CI asserts the emptiness — a check on
  content, which is stronger than a check for an absent block. Running the pod
  as the namespace's `default` account instead would create no RBAC object at
  all and was rejected for it: `default` is shared, so a rule granted to it
  later for an unrelated reason would be inherited here in silence.

  **Under OLM the account does end up holding exactly one rule, and it is not
  ours.** Every CSV gets an `OperatorCondition`, and OLM creates a Role — named
  after the CSV, owned by that condition, labelled `olm.managed` — letting the
  operator `get`, `update` and `patch` **its own**, restricted by
  `resourceNames` to that single object. It cannot be declined and it reaches
  nothing else; this plugin never uses it. Observed on 4.22 by installing and
  looking, after the check in `hack/lab/bundle.sh` reported it. That check now
  tolerates that rule *by shape* — widen it, drop the `resourceNames`, or add a
  second rule, and it fails again. Do not relax it to "OLM-managed Roles are
  fine": the Role holding whatever the CSV's `permissions` declares carries the
  same label.
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
- **A tag is the version, with no `v` in front**: `0.1.1`, not `v0.1.1`. Quay's
  build trigger names the image after the git ref verbatim and cannot edit it,
  so a `v` reaches the image tag, and everything that references the release —
  the bundle's `containerImage`, the CI check on it, the README — says `0.1.1`.
  Dropping the prefix leaves one string rather than two that differ by one
  character, which is the shape a typo hides in. Observed: `v0.1.0` was cut,
  and Quay queued a build tagged `v0.1.0` while the bundle it was meant to
  serve pointed at `0.1.0`. Nothing would have failed until a user installed
  the operator and the pod could not pull.
- **A release branch's version carries its generation**: `0.1.1-ocp4.16`, not
  `0.1.1`. Valid semver, accepted by the manifest schema, and the console then
  displays which build is installed. Without it, the same `0.1.1` cut on two
  branches produces two different images racing for one image tag — and with
  `IfNotPresent` the loser is invisible. The OLM bundle reads that same suffix
  to decide which OpenShift catalogues it belongs in, so it is now load-bearing
  in a second place.
- **The OLM bundle is generated from the chart and never written beside it.**
  `hack/bundle/build-bundle.mjs` renders the chart and rearranges it; only what
  a chart has no opinion about — display name, icon, install modes, annotations
  — is hand-written, in `hack/bundle/csv-base.yaml`. Editing a manifest under
  `dist/bundle/` is editing a build artefact. A second hand-written copy of the
  Deployment and the ConsolePlugin is the same defect as a fix authored on a
  release branch: two descriptions of one thing, and nothing comparing them.
  The CSV declares **one `permissions` entry with an empty rule list and no
  `clusterPermissions`** — which is how the no-rules invariant survives into
  OLM, and not the same spelling the chart uses. See that invariant above
  before changing it: dropping the block altogether leaves the ServiceAccount
  uncreated and the pod unschedulable, and a bundle cannot ship the account
  itself.

## Supporting more than one console generation

`main` targets OpenShift 4.22 and later. Older consoles are served by release
branches, because the frameworks the console shares with plugins change under
them. There are **three** generations between 4.16 and 4.22, not two:

| | 4.16 – 4.18 | 4.19 – 4.21 | 4.22+ (`main`) |
|---|---|---|---|
| PatternFly | 5.2 | 6.2 | 6.4 |
| React | 17 | 17 | 18 |
| console's router | `react-router-dom` 5.3 | `react-router-dom` 5.3 | `react-router` 7.13 |
| **what the shim imports** | `react-router-dom-v5-compat` | `react-router-dom-v5-compat` | `react-router` |
| SDK | 1.2.0 (webpack 1.1.0) | `4.19-latest` | `4.22-latest` |
| `@console/pluginAPI` | `>=4.16.0-0 <4.19.0-0` | `>=4.19.0-0 <4.22.0-0` | `>=4.22.0-0` |

PatternFly breaks at 4.19; React and the router break at 4.22. The middle
generation is a subset of neither neighbour.

The two router rows are deliberately separate, because taking the console's own
dependency as the answer is wrong and wrong *quietly*. Before 4.22 the console
runs react-router-dom 5.3, but it builds plugin page routes in
`frontend/public/components/app-contents.tsx` with `Route` and `Routes`
imported from `react-router-dom-v5-compat`, so a plugin component is mounted in
the v6 context. Both contexts exist at once — `CompatRouter` is nested inside
the v5 router — so reading the wrong one returns an empty object rather than
throwing. Observed on 4.16: every node report claimed the node had been removed
from the cluster, naming it as the empty string. The compat package is a
singleton shared module with no fallback, so it belongs in `package.json` too;
that is what gives webpack a `requiredVersion` and makes the plugin use the
console's copy.

A release branch differs from `main` in the three shim modules, the dependency
pins in `package.json`, the `@console/pluginAPI` bound, and — for the PatternFly
5 branch only — the component markup. `release-4.19` is what that costs when the
markup is not involved: four files, one of them the lockfile, and `k8s.ts` and
`styles.ts` untouched. The middle generation is a subset of neither neighbour,
but it is the cheapest of the three branches, not the hardest.

### Test against another generation without another cluster

`quay.io/openshift/origin-console` publishes a tag per release, and a published
plugin image already serves the assets over plain HTTP. Two containers, no node
toolchain and no second cluster — `podman` and `oc` are the whole requirement.

```sh
hack/lab/console.sh 0.1.0 4.16 4.19
```

That runs a console per generation on its own port — 9016, 9019, 9022 — each
with the matching published image, and removes everything on exit. Underneath
it is two `podman run` calls per generation:

```sh
podman network create fio-lab-416

podman run -d --name fio-plugin-416 --network fio-lab-416 \
  quay.io/asalvati/file-integrity-console-plugin:0.1.0-ocp4.16 \
  --listen=:9001 --tls-cert-file= --tls-key-file=

podman run -d --name fio-console-416 --network fio-lab-416 -p 9016:9000 \
  -e BRIDGE_USER_AUTH=disabled \
  -e BRIDGE_K8S_MODE=off-cluster \
  -e BRIDGE_K8S_AUTH=bearer-token \
  -e BRIDGE_K8S_MODE_OFF_CLUSTER_SKIP_VERIFY_TLS=true \
  -e BRIDGE_K8S_MODE_OFF_CLUSTER_ENDPOINT="$(oc whoami --show-server)" \
  -e BRIDGE_K8S_AUTH_BEARER_TOKEN="$(oc whoami --show-token)" \
  -e BRIDGE_USER_SETTINGS_LOCATION=localstorage \
  -e BRIDGE_I18N_NAMESPACES=plugin__file-integrity-console-plugin \
  -e BRIDGE_PLUGINS=file-integrity-console-plugin=http://fio-plugin-416:9001 \
  -e BRIDGE_RELEASE_VERSION=4.16.55 \
  quay.io/openshift/origin-console:4.16
```

A network per generation rather than `--network=host`, so several run at once
and the console reaches the plugin by container name. The console proxies
plugin assets server-side, which is why an address only it can resolve works.

**This does not exercise OLM.** `BRIDGE_PLUGINS` bypasses the ConsolePlugin
resource, the CSV, the Subscription and the catalogue; it answers whether a
generation's *build* loads. `hack/lab/bundle.sh` answers the other question,
and only against a cluster of the matching generation. File retrieve cannot
work here either: the proxy alias is declared in the ConsolePlugin resource,
and the backend builds its client from `rest.InClusterConfig()`.

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
  only `k8sGet` / `k8sPatch`**. Older SDKs export `k8sGetResource` /
  `k8sPatchResource` *and* the short aliases — verified in 1.2.0 — so
  `src/lib/k8s.ts` is byte-identical on every branch even though it is one of
  the three files allowed to differ. Use the short spelling and leave it alone.
- **PatternFly pins to the floor of the branch's range, not to the template's
  caret.** The plugin ships no CSS of its own, so every class name it emits has
  to exist in the stylesheet the *console* loaded: `@patternfly/patternfly`
  5.2.1 on 4.16 and 4.17, 5.4.0 on 4.18. `^5.1.1` resolves to 5.4 and would
  emit names the two older consoles do not have.
- **Check the `provide shared module` lines in the build output.** A transitive
  dependency asking for a newer PatternFly gets its own nested copy, and that
  copy — not the top-level one — is what webpack publishes as the shared
  module. Nothing fails: the plugin simply advertises a version the console is
  not serving. A `resolutions` entry collapses it, and the build output is the
  only place the mismatch is visible.
- **A release branch needs one webpack, and a `resolutions` entry is what
  guarantees it.** The SDK's webpack plugin carries its own `webpack`
  dependency — `^5.75.0` in the 4.19 plugin — and installing on top of an
  existing lockfile resolves that descriptor separately from the workspace's
  own. Two copies then take part in one compilation and it fails outright:
  observed on 4.19 as `runtimeTemplate.optionalChaining is not a function`,
  the newer copy's `ConsumeSharedRuntimeModule` calling a method the older
  compiler driving the build does not have.
  `yarn dedupe webpack` also collapses it, but upwards, to whatever is newest —
  and on 4.19 that dropped `terser-webpack-plugin`, which `webpack.config.ts`
  requires while relying on webpack to supply it transitively. Pin instead, to
  the version `main` uses, so the branch is built by the same compiler.
- **`@types/react` needs a `resolutions` entry on the React 17 branches.**
  `@types/react-router` and `@types/react-router-dom` both depend on
  `@types/react: "*"`, so each pulls its own copy of 19, under which `Link`
  stops being usable as a JSX element.
- **Do not gate anything on `console.flag/model` before 4.22.** That extension
  is evaluated only when API discovery completes, and a plugin registering
  afterwards adds its model to the console's map without anything re-reading
  it — `frontend/public/reducers/features.ts` carries a `TODO(vojtech): change
  of 'CRDs' should trigger relevant detection logic` beside that code, and 4.22
  fixed it with an `UpdateModelFlags` action. Discovery does not run again
  either: for a caller allowed to watch CustomResourceDefinitions,
  `startAPIDiscovery` runs it once and then only when a CRD is added or
  removed; the 60-second poll is the fallback for callers without that
  permission. Losing the startup race therefore costs the whole navigation
  item until the page is reloaded — observed on 4.16, absent on first load and
  present afterwards. `src/flags.ts` sets the flag through a
  `console.flag/hookProvider` instead: the console mounts it via
  `useResolvedExtensions` whenever the plugin arrives, and `useK8sModel` is a
  live selector, so neither ordering matters.
- **PatternFly is a module the console *shares* with plugins on 4.16–4.18 and
  on 4.19–4.21 alike**, with a fallback allowed. It was predicted to stop being
  shared at 4.19; the 4.19 build's `provide shared module` lines say otherwise,
  so if it stops it is somewhere later. The consequence is that the components
  which actually render may come from the console's PatternFly build rather
  than the one in the lockfile — a component missing there fails at runtime, in
  the browser, with CI green. Check this against the real console image before
  designing around any particular PatternFly API.
- **What console 4.16 shares is PatternFly 4, and the table above is about the
  stylesheet.** Its `index.html` loads two PatternFly bundles, and the shared
  scope registers `@patternfly/react-core` out of the one named
  `vendor-patternfly-4-shared`: version **4.278.0**, with `react-table` 4.113.6
  beside it. The PatternFly 5 bundle is what the console renders *itself* with.
  So a plugin compiled against 5.2 is *offered* 4.278.0 at runtime. Read off a
  running console with `curl`, not inferred.

  **Offered is not used.** The plugin's own entry provides `react-core` 5.2.3
  and consumes it at `^5.2.3`; a singleton share would then have made the
  console's copy win anyway and logged `Unsatisfied version … of shared
  singleton module` in the browser. Reloading a 4.16 console with devtools open
  and filtering on `patternfly` produced nothing, so the plugin renders with its
  own copy and this is background, not a live hazard. It stops being background
  the moment anything relies on a component the plugin does not bundle.
- **The PatternFly floor can be two different numbers.** "Pin to the floor" is
  one rule but not one version: console 4.19 declares `@patternfly/patternfly`
  at `^6.2.3` and `react-core`, `react-icons` and `react-table` at `^6.2.2`,
  and **6.2.3 does not exist for `react-icons` at all**. Read the console's
  `frontend/package.json` per package rather than picking one number and
  applying it across the set. On `release-4.19` that is `~6.2.2` for the React
  packages and `~6.2.3` for the stylesheet — which is also the stylesheet CI
  checks `src/lib/styles.ts` against, so it has to be the one the console
  loads.

**Paths that must never diverge between branches:** `backend/`, `charts/`,
`Containerfile`, `.github/workflows/ci.yml`, `console-extensions.json`,
`hack/`, `locales/`, `tsconfig.json`, and all of `src/lib/` except the three
shims.

The single exception is `Chart.yaml`'s `version` and `appVersion`, which carry
the generation suffix on a release branch. They name the build the chart
installs, which is per-generation by definition, and CI requires them to agree
with `package.json`. Everything else under `charts/` is identical everywhere.
Author changes to those on `main` and merge `main` forward into the release
branches — never rebase a pushed branch, and never author the change on the
branch. The first backend fix written directly on a release branch is where
three branches quietly become three products.

Discipline is not the mechanism. CI enforces this: the `branch-delta` job
asserts that `git diff --name-only origin/main HEAD` contains nothing outside
the set declared for that branch in **`.github/branch-delta.json`**, so a fix
landing on `main` does not merely fail to arrive — it turns the release branch
red until someone merges it.

The declaration lives on `main` and is merged forward unchanged, which means
widening a branch's delta is a change reviewed where the rule is, not on the
branch it constrains. Two things follow:

- **A new release branch needs its entry added on `main` first.** Without one,
  the job fails rather than waving the branch through.
- **A path may be declared and identical.** `src/lib/k8s.ts` is one of the three
  shims and so permitted to differ, but nothing has needed to change it; the job
  reports that as information, not as a fault.

It also runs nightly across every release branch, because drift is invisible
from both sides: nothing touches a release branch when `main` moves, so its own
CI never runs and the gap simply sits there.

## Things that have already cost time

- **Quay builds one image at a time, and drops what it cannot queue.** Pushing
  two tags in one command produced one build: `0.1.0-ocp4.19` was queued and
  `0.1.0-ocp4.16` never appeared in the build history at all — not failed, not
  cancelled, absent. Two branch builds pushed while the queue was busy were
  recorded as `cancelled` in the same way. Push **one tag at a time, and check
  that a build exists for it** before treating the release as made. The failure
  is silent from both ends: git accepted the tag and reports success, and Quay
  has nothing to report because it never started. For a bundle naming an
  immutable image that is how a dead reference gets published — the tag is
  real, the manifest references it, and nothing resolves the image until a
  user installs the operator. Re-pushing the tag alone against an empty queue
  built it immediately, which is the whole fix; the git object is annotated, so
  deleting and re-pushing preserves its message.
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
