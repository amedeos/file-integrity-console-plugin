// Build the OLM bundle out of the Helm chart.
//
// The chart is the only description of what an installation creates. Writing
// the bundle by hand would make a second one, and this repository already knows
// what happens then: two copies of the same configuration that nothing
// compares, quietly disagreeing the first time one of them is edited. So the
// Deployment, Service, ServiceAccount and ConsolePlugin are rendered by `helm
// template` and rearranged into the shape OLM wants, and only the things a
// chart has no opinion about — the display name, the icon, the install modes —
// are written by hand, in hack/bundle/csv-base.yaml.
//
// Output goes to dist/bundle/ and is not committed. To see the bundle, build
// it.
//
// Usage:  node hack/bundle/build-bundle.mjs
// Env:    HELM               path to the helm binary (default: helm)
//         BUNDLE_IMAGE       override the plugin image reference
//         BUNDLE_CREATED_AT  override the createdAt annotation (RFC 3339)

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const OUT = path.join(ROOT, 'dist', 'bundle');

const PACKAGE = 'file-integrity-console-plugin';
const CHART = path.join(ROOT, 'charts', PACKAGE);
const IMAGE_REPO = 'quay.io/asalvati/file-integrity-console-plugin';

// The namespace `helm template` is pointed at, which is where the ConfigMap
// lands and what the ConsolePlugin inside it says before the init container
// overwrites it with the pod's own. So it is a default now, not a requirement:
// nothing in the shipped bundle has to name the namespace it will be installed
// into, which is what 0.2.0 changed.
//
// The plugin's own, not the File Integrity Operator's. It has no need to sit
// beside the operator — it reaches FileIntegrity objects through the browsing
// user's token, and where to look for them is a separate setting
// (`fio-namespace`, defaulting to openshift-file-integrity). And it may not
// take an `openshift-` name: that prefix and `kube-` are reserved for the
// cluster's own, refused to anyone who is not cluster-admin, and this is a
// community operator.
const NAMESPACE = 'file-integrity-console-plugin';

// Which console generation this branch builds for, keyed by the suffix its
// version carries. This table is the only place the three branches differ, and
// it lives here — on `main`, merged forward unchanged — for the same reason
// .github/branch-delta.json does: what separates the branches is decided where
// the rule is written, not on the branch it describes.
//
// The range annotation is what keeps the three bundles apart once published.
// Each per-OpenShift catalog is built from the bundles whose range covers it,
// so a 4.16 cluster's catalog contains only the 4.16 bundle and can never be
// offered the 4.22 one. A channel per generation says the same thing a second
// way: in semver `0.1.0-ocp4.16` is a *prerelease* of `0.1.0` and sorts before
// it, so a single shared channel would describe an upgrade from the 4.16 build
// to the 4.22 build. Nothing would act on it — but nothing should be able to.
//
// minKubeVersion is the Kubernetes release the floor of each range ships, read
// from openshift/kubernetes's go.mod on the matching branch: 4.16 is 1.29, 4.19
// is 1.32, 4.22 is 1.35. It is a weaker statement than the range annotation and
// gates nothing the annotation does not already gate — the validator asks for
// it, and answering with a number that was looked up beats answering with one
// that was guessed.
//
// `replaces` names the bundle **already published in that channel upstream**,
// and it is the one field here that is about the catalogue rather than about
// the generation. A channel must have exactly one head — a bundle nothing else
// replaces or skips — and `opm validate` refuses a catalogue where it does not:
//
//     multiple channel heads found in graph:
//       file-integrity-console-plugin.v0.3.1,
//       file-integrity-console-plugin.v0.4.0
//
// Checked both ways against a hand-written declarative config rather than
// assumed: two entries with no edge between them fail, the same pair with this
// field passes. Nothing in this repository can be derived into it, because it
// is a fact about what is in `community-operators-prod`, not about what has
// been tagged here — so it is stated, and it has to be updated when a release
// is submitted. `updateGraph: replaces-mode` in the operator's `ci.yaml` is
// what makes it the only thing consulted; a semver-ordered graph is refused
// there for the reason in the paragraph above.
//
// No channel is empty any more. All three held nothing until 4 August 2026 and
// all three hold 0.4.0 since that evening, so every row names a predecessor and
// the `— (first in channel)` the build can print is now a state this package
// has left behind rather than one it is in.
//
// That couples two things on a release branch that used to be independent, and
// the coupling has no order that works — **they have to land in the same pull
// request**, closed with a merge commit. Neither half is green alone:
//
//   - the merge-forward alone brings a row naming 0.4.0-ocp4.16 to a branch
//     whose version is still 0.4.0-ocp4.16, which is a bundle that replaces
//     itself: the check below refuses it and CI refuses it again;
//   - the bump alone leaves the branch behind `main`, and what `main` moved are
//     files no branch declares in .github/branch-delta.json — this one among
//     them — so `branch-delta` fails on paths that have nothing to do with the
//     release.
//
// Checked rather than reasoned about, on 5 August 2026: with `main` at 0.4.1
// the two branches differ from it in README.md, docs/STATUS.md and this file,
// none of which either branch declares. An earlier version of this comment said
// to bump first and merge afterwards, which is the half that fails second.
const GENERATIONS = [
  {
    suffix: '-ocp4.16',
    ocpVersions: 'v4.16-v4.18',
    channel: 'stable-4.16',
    minKubeVersion: '1.29.0',
    replaces: `${PACKAGE}.v0.4.0-ocp4.16`,
  },
  {
    suffix: '-ocp4.19',
    ocpVersions: 'v4.19-v4.21',
    channel: 'stable-4.19',
    minKubeVersion: '1.32.0',
    replaces: `${PACKAGE}.v0.4.0-ocp4.19`,
  },
  {
    suffix: '',
    ocpVersions: 'v4.22',
    channel: 'stable-4.22',
    minKubeVersion: '1.35.0',
    replaces: `${PACKAGE}.v0.4.0`,
  },
];

const read = (p) => fs.readFileSync(p, 'utf8');

const pkg = JSON.parse(read(path.join(ROOT, 'package.json')));
const version = pkg.version;

const generation =
  GENERATIONS.find((g) => g.suffix !== '' && version.endsWith(g.suffix)) ??
  GENERATIONS.find((g) => g.suffix === '');

if (generation.suffix === '' && /-/.test(version)) {
  throw new Error(
    `package.json version ${version} carries a suffix no generation claims. ` +
      'Add it to GENERATIONS, on `main`, with the OpenShift range it covers.',
  );
}

const releaseImage = `${IMAGE_REPO}:${version}`;
const image = process.env.BUNDLE_IMAGE ?? releaseImage;

// A released bundle names the image built from the git tag, which never moves,
// and `IfNotPresent` is right for it. BUNDLE_IMAGE exists so the bundle can be
// tried before any tag is cut — pointed at `:latest` or a branch tag — and
// those do move. With `IfNotPresent` the kubelet then reuses the layer it
// already has and the rollout reports success while running the previous
// binary, which this repository has already lost time to once.
//
// Derived rather than asked for, because it is a property of the reference:
// only a digest or the release tag itself is immutable.
const immutable = image.includes('@sha256:') || image === releaseImage;
const pullPolicy = immutable ? 'IfNotPresent' : 'Always';

const createdAt =
  process.env.BUNDLE_CREATED_AT ??
  new Date().toISOString().replace(/\.\d+Z$/, 'Z');

// ---------------------------------------------------------------------------
// Render the chart

const helm = process.env.HELM ?? 'helm';

// The release name is the chart name on purpose. `app.kubernetes.io/instance`
// is a *selector* label (see the chart's _helpers.tpl), so a release name of
// "fio" would bake "fio" into the Deployment's matchLabels and the Service's
// selector. Naming the release after the chart makes those labels stable and
// meaningful in a bundle, where there is no release.
//
// The console-patching jobs are off: `Job` is not a kind OLM accepts in a
// bundle, and it is not needed — OLM's own install form is what registers the
// plugin with the console. Turning them off also removes the patcher's
// ClusterRole and its ServiceAccount, which are the only privileged objects the
// chart ever creates.
const rendered = execFileSync(
  helm,
  [
    'template',
    PACKAGE,
    CHART,
    '--namespace',
    NAMESPACE,
    '--set',
    `plugin.image=${image}`,
    '--set',
    `plugin.imagePullPolicy=${pullPolicy}`,
    '--set',
    'plugin.jobs.patchConsoles.enabled=false',
    // The ConsolePlugin is created by an init container instead of shipped.
    // `operator-sdk bundle validate` rejects the kind as a bundle manifest —
    // "unsupported media type registry+v1 for bundle object" — in every
    // release up to 1.39.2, and the community pipeline runs one of those. OLM
    // accepts it, which is why installing on a cluster never showed this.
    //
    // It is also the better answer regardless: OLM templates nothing inside a
    // cluster-scoped manifest, so a shipped ConsolePlugin has to name a
    // namespace it cannot know, and an install anywhere else produces a plugin
    // the console cannot reach. The init container reads the pod's own.
    '--set',
    'plugin.consolePlugin.mode=initContainer',
  ],
  { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
);

const objects = yaml.loadAll(rendered).filter(Boolean);

// Labels that answer a question the bundle does not get to ask. The first two
// describe the Helm release: nothing here is managed by Helm and there is no
// chart. The third echoes the namespace `helm template` was pointed at, and OLM
// is what decides that at install time — leaving it would state, wrongly and in
// writing, where the workload runs.
const RENDER_TIME_LABELS = [
  'helm.sh/chart',
  'app.kubernetes.io/managed-by',
  'app.openshift.io/runtime-namespace',
];

// Every `metadata.labels` in the tree, not only the one at the top: the CSV
// carries the Deployment, and the Deployment carries a pod template with a
// labels block of its own. Scrubbing only the outer one left every pod OLM
// creates claiming to be managed by Helm and stamped with a chart version —
// shipped that way in 0.1.0. The selector is built from `selectorLabels`, which
// none of these appear in, so removing them changes nothing that matches.
const scrub = (node) => {
  if (Array.isArray(node)) return node.forEach(scrub);
  if (!node || typeof node !== 'object') return;
  if (node.metadata?.labels) {
    for (const l of RENDER_TIME_LABELS) delete node.metadata.labels[l];
  }
  for (const v of Object.values(node)) scrub(v);
};
objects.forEach(scrub);

const take = (kind) => {
  const i = objects.findIndex((o) => o.kind === kind);
  if (i < 0) throw new Error(`the chart rendered no ${kind}`);
  return objects.splice(i, 1)[0];
};

const deployment = take('Deployment');

// The ClusterRole and its binding are lifted into the CSV rather than shipped.
// OLM creates cluster RBAC from `clusterPermissions` and takes ownership of it,
// so the objects go when the CSV goes; a shipped ClusterRoleBinding would name
// a ServiceAccount OLM has not created yet, and would outlive the uninstall.
const clusterRole = take('ClusterRole');
take('ClusterRoleBinding');

// The chart's ServiceAccount does not ship, and cannot: `operator-sdk bundle
// validate` rejects any ServiceAccount in a bundle whose name matches one a
// deployment runs as — categorically, whatever else the CSV says. OLM is meant
// to create it, and OLM creates it from `permissions`, from nothing else. A
// bundle with a dedicated account and no permissions block therefore installs a
// deployment that can never schedule: "error looking up service account ...
// not found". Observed; the CSV sat in Installing until it was noticed.
//
// So the account is declared through `permissions` with an empty rule list, and
// the emptiness is the invariant rather than a placeholder. OLM materialises
// each entry as a ServiceAccount, a Role carrying exactly those rules, and a
// RoleBinding (resolver/rbac.go, unconditionally). An empty Role grants
// nothing, which is what "granted nothing" looks like in OLM's vocabulary — the
// chart says the same thing by creating no Role at all.
//
// The alternative was to drop `serviceAccountName` and let the pod run as the
// namespace's `default`, which creates no RBAC object whatsoever. Rejected, and
// not on aesthetics: `default` is shared with everything else in the namespace,
// so a rule granted to it later for some unrelated reason would be inherited by
// this pod in silence. A dedicated account nobody binds anything to is the
// safer of the two, which is the whole point of the invariant.
const serviceAccount = take('ServiceAccount');
if (
  serviceAccount.metadata.name !==
  deployment.spec.template.spec.serviceAccountName
) {
  throw new Error(
    `the chart's ServiceAccount is ${serviceAccount.metadata.name} but the Deployment runs as ` +
      `${deployment.spec.template.spec.serviceAccountName}; the bundle would declare one account ` +
      'and schedule the pod against another',
  );
}

// Whatever else the chart produced — today the Service alone, tomorrow the
// deny-list ConfigMap if one is ever configured by default — rides along
// unchanged. Anything OLM does not accept fails validation loudly rather than
// being dropped here in silence.
const extras = objects;

// OLM sets the namespace of a namespaced bundle resource to whichever namespace
// the operator is installed into. Leaving one written down would either be
// ignored or, worse, disagree with the install.
for (const o of [...extras, deployment]) delete o.metadata.namespace;

// The ConsolePlugin now travels as data, in a ConfigMap the init container
// applies after replacing the namespace with the pod's own. Checked here
// because a bundle that shipped the ConfigMap without the init container, or
// the other way round, would install an operator that registers nothing — and
// nothing else in the pipeline looks at the pair.
const consolePluginConfigMap = extras.find(
  (o) => o.kind === 'ConfigMap' && o.data?.['consoleplugin.yaml'],
);
if (!consolePluginConfigMap) {
  throw new Error(
    'the chart rendered no ConfigMap carrying consoleplugin.yaml; the init ' +
      'container would have nothing to apply',
  );
}
const initContainers = deployment.spec.template.spec.initContainers ?? [];
if (!initContainers.some((c) => c.args?.includes('ensure-consoleplugin'))) {
  throw new Error(
    'the Deployment has no init container running `ensure-consoleplugin`; the ' +
      'ConsolePlugin would never be created',
  );
}
if (objects.some((o) => o.kind === 'ConsolePlugin')) {
  throw new Error(
    'the chart rendered a ConsolePlugin manifest; `operator-sdk bundle ' +
      'validate` rejects that kind in a bundle up to 1.39.2, which is what the ' +
      'community pipeline runs',
  );
}

// ---------------------------------------------------------------------------
// Assemble the ClusterServiceVersion

const csv = yaml.load(read(path.join(HERE, 'csv-base.yaml')));

csv.metadata.name = `${PACKAGE}.v${version}`;
csv.metadata.annotations = {
  ...csv.metadata.annotations,
  containerImage: image,
  createdAt,
  'alm-examples': '[]',
};

csv.spec.version = version;
csv.spec.minKubeVersion = generation.minKubeVersion;

// Absent for a generation whose channel holds nothing yet. No row is in that
// state today, and the branch stays because the next generation branched will
// be — see GENERATIONS.
//
// A bundle that replaces itself is what a stale table looks like after a
// release goes out and nobody updates it, and it is not a shape OLM has a
// sensible reading of, so it stops here rather than in someone else's pipeline.
if (generation.replaces) {
  if (generation.replaces === csv.metadata.name) {
    throw new Error(
      `${csv.metadata.name} would replace itself. The replaces entry for ` +
        `${generation.channel} still names this version; it should name the ` +
        'bundle already published in that channel.',
    );
  }
  csv.spec.replaces = generation.replaces;
}
csv.spec.icon = [
  {
    base64data: fs.readFileSync(path.join(HERE, 'icon.svg')).toString('base64'),
    mediatype: 'image/svg+xml',
  },
];

// One `permissions` entry with no rules, and `clusterPermissions` carrying
// exactly what the chart's ClusterRole grants: the right to create this
// plugin's own ConsolePlugin object and to keep it up to date, narrowed by
// `resourceNames` everywhere `resourceNames` is allowed to narrow.
//
// The namespaced list stays empty, and its emptiness is still the invariant:
// every call the backend makes on behalf of a browsing user is made with that
// user's token. The cluster-scoped rules are not that path — they register the
// plugin with the console and reach no data belonging to anyone. The entry also
// has to exist at all, because OLM creates the ServiceAccount from
// `permissions` and from nothing else; see the note above the ServiceAccount.
//
// CI asserts both halves: the namespaced rules stay empty, and the cluster
// rules stay these two and nothing more.
csv.spec.install = {
  strategy: 'deployment',
  spec: {
    permissions: [
      { serviceAccountName: serviceAccount.metadata.name, rules: [] },
    ],
    clusterPermissions: [
      {
        serviceAccountName: serviceAccount.metadata.name,
        rules: clusterRole.rules,
      },
    ],
    deployments: [
      {
        name: deployment.metadata.name,
        label: deployment.metadata.labels,
        spec: deployment.spec,
      },
    ],
  },
};

csv.spec.relatedImages = [{ name: 'plugin', image }];

// ---------------------------------------------------------------------------
// Write it out

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'manifests'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'metadata'), { recursive: true });

const dump = (o) => yaml.dump(o, { lineWidth: 100, noRefs: true });

const manifestName = (o) => {
  const [group, apiVersion] = o.apiVersion.includes('/')
    ? o.apiVersion.split('/')
    : ['core', o.apiVersion];
  return `${o.metadata.name}_${group}_${apiVersion}_${o.kind.toLowerCase()}.yaml`;
};

fs.writeFileSync(
  path.join(
    OUT,
    'manifests',
    `${PACKAGE}.v${version}.clusterserviceversion.yaml`,
  ),
  dump(csv),
);
for (const o of extras) {
  fs.writeFileSync(path.join(OUT, 'manifests', manifestName(o)), dump(o));
}

// The scrubbing above walks parsed objects, and one object is no longer
// reachable that way: the ConsolePlugin travels as an opaque string inside a
// ConfigMap, so it kept `helm.sh/chart` and `managed-by: Helm` and the init
// container applied them to a cluster. The chart is where that was fixed —
// this reads the bytes back and says so, because the next kind carried as data
// will be just as invisible to a walk over `metadata.labels`.
for (const f of fs.readdirSync(path.join(OUT, 'manifests'))) {
  const text = fs.readFileSync(path.join(OUT, 'manifests', f), 'utf8');
  for (const l of RENDER_TIME_LABELS) {
    if (text.includes(`${l}:`)) {
      throw new Error(
        `${f} still carries ${l}. It describes how this was rendered, not ` +
          'what OLM installs. If it is inside embedded data rather than on a ' +
          'manifest, fix it in the chart: nothing here can reach it.',
      );
    }
  }
}

const annotations = {
  'operators.operatorframework.io.bundle.mediatype.v1': 'registry+v1',
  'operators.operatorframework.io.bundle.manifests.v1': 'manifests/',
  'operators.operatorframework.io.bundle.metadata.v1': 'metadata/',
  'operators.operatorframework.io.bundle.package.v1': PACKAGE,
  'operators.operatorframework.io.bundle.channels.v1': generation.channel,
  'operators.operatorframework.io.bundle.channel.default.v1':
    generation.channel,
  'com.redhat.openshift.versions': generation.ocpVersions,
};

fs.writeFileSync(
  path.join(OUT, 'metadata', 'annotations.yaml'),
  dump({ annotations }),
);

// Only needed to build a bundle image for a local catalog; the community
// submission is the manifests and metadata directories alone.
fs.writeFileSync(
  path.join(OUT, 'bundle.Dockerfile'),
  [
    'FROM scratch',
    '',
    ...Object.entries(annotations).map(
      ([k, v]) => `LABEL ${k}=${JSON.stringify(v)}`,
    ),
    '',
    'COPY manifests /manifests/',
    'COPY metadata /metadata/',
    '',
  ].join('\n'),
);

const relative = path.relative(ROOT, OUT);
console.log(`${PACKAGE} ${version}`);
console.log(`  image     ${image} (pull ${pullPolicy})`);
console.log(`  console   ${generation.ocpVersions}`);
console.log(`  channel   ${generation.channel}`);
// Printed either way, because the interesting case is the empty one: a channel
// that already holds a bundle and a build that says `replaces  —` is the
// catalogue rejection in advance, and it is not visible anywhere else.
console.log(`  replaces  ${csv.spec.replaces ?? '— (first in channel)'}`);
console.log(`  namespace ${NAMESPACE}`);
console.log(`  written   ${relative}/`);
for (const f of fs.readdirSync(path.join(OUT, 'manifests')).sort()) {
  console.log(`            manifests/${f}`);
}
