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

// The namespace the ConsolePlugin names as the Service's own. OLM templates
// nothing inside a cluster-scoped manifest, so this is literal in the shipped
// bundle rather than resolved at install time — which is why the CSV carries
// `operatorframework.io/suggested-namespace` and why the README says the
// operator has to be installed here. It is also where the File Integrity
// Operator itself runs.
const NAMESPACE = 'openshift-file-integrity';

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
const GENERATIONS = [
  {
    suffix: '-ocp4.16',
    ocpVersions: 'v4.16-v4.18',
    channel: 'stable-4.16',
    minKubeVersion: '1.29.0',
  },
  {
    suffix: '-ocp4.19',
    ocpVersions: 'v4.19-v4.21',
    channel: 'stable-4.19',
    minKubeVersion: '1.32.0',
  },
  {
    suffix: '',
    ocpVersions: 'v4.22',
    channel: 'stable-4.22',
    minKubeVersion: '1.35.0',
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

for (const o of objects) {
  for (const l of RENDER_TIME_LABELS) delete o.metadata?.labels?.[l];
}

const take = (kind) => {
  const i = objects.findIndex((o) => o.kind === kind);
  if (i < 0) throw new Error(`the chart rendered no ${kind}`);
  return objects.splice(i, 1)[0];
};

const deployment = take('Deployment');
const consolePlugin = take('ConsolePlugin');

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

if (consolePlugin.spec?.backend?.service?.namespace !== NAMESPACE) {
  throw new Error(
    `the rendered ConsolePlugin names ${consolePlugin.spec?.backend?.service?.namespace}, ` +
      `not ${NAMESPACE} — the bundle would install a plugin the console cannot reach`,
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
csv.spec.icon = [
  {
    base64data: fs.readFileSync(path.join(HERE, 'icon.svg')).toString('base64'),
    mediatype: 'image/svg+xml',
  },
];

// One `permissions` entry with no rules, and no `clusterPermissions` at all.
// The empty list is the invariant, not an omission waiting to be filled: every
// call the backend makes against the API server is made with the browsing
// user's token, so the pod's own identity is meant to be able to do nothing.
// This is the only way to say that in OLM and still get the ServiceAccount
// created — see the note above the ServiceAccount. CI asserts the list stays
// empty, as it asserts the chart renders no Role.
csv.spec.install = {
  strategy: 'deployment',
  spec: {
    permissions: [
      { serviceAccountName: serviceAccount.metadata.name, rules: [] },
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
for (const o of [consolePlugin, ...extras]) {
  fs.writeFileSync(path.join(OUT, 'manifests', manifestName(o)), dump(o));
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
console.log(`  namespace ${NAMESPACE}`);
console.log(`  written   ${relative}/`);
for (const f of fs.readdirSync(path.join(OUT, 'manifests')).sort()) {
  console.log(`            manifests/${f}`);
}
