# File Integrity Console Plugin — piano di implementazione

## Context

Il Red Hat File Integrity Operator (FIO) è un HIDS basato su AIDE: installarlo e configurarlo è
semplice, ma **consumare i risultati no**. Oggi per capire cosa è cambiato su un nodo bisogna
collegarsi al cluster, trovare il `FileIntegrityNodeStatus` giusto, risalire alla ConfigMap di
risultato e leggere a mano un log AIDE grezzo (a volte gzippato+base64). Non esiste una vista
di insieme nodo-per-nodo, né un modo per ispezionare il file che risulta modificato.

Obiettivo: una dashboard web per cluster-admin che dia (a) lo stato di integrità nodo per nodo,
(b) il report AIDE parsato e filtrabile invece del muro di testo, (c) azioni di triage
(re-init del baseline) e (d) un bottone per recuperare il contenuto attuale di un file segnalato
direttamente dal nodo.

Decisioni prese con l'utente:
- **Console plugin dinamico** (non rotta standalone).
- **Retrieve file via backend che agisce con il token dell'utente** (nessun SA privilegiato).
- **Helm chart ora, bundle OLM in una fase successiva.**
- Scope v1: overview nodo-per-nodo + report AIDE parsato + azioni di remediation.
  **Storico/trend esplicitamente fuori dalla v1.**

## Fatti verificati (base del design — non riderivarli)

Cluster di lab `https://api.ocp-lab.duckdns.org:6443`: OCP **4.22.5**, k8s 1.35.5, 3 nodi
compact (`control-plane-0/1/2`, ruoli master+worker), ingress `apps.ocp-lab.duckdns.org`.
**FIO NON è ancora installato** — è disponibile come `file-integrity-operator` nel CatalogSource
`redhat-operators` (bundle upstream corrente: v1.4.0). Il namespace `openshift-file-integrity`
non esiste ancora.

Modello dati FIO (da `github.com/openshift/file-integrity-operator`, verificato su master):
- CRD `fileintegrities` e `fileintegritynodestatuses`, gruppo `fileintegrity.openshift.io/v1alpha1`,
  namespace fisso `openshift-file-integrity` (`pkg/common/var.go`).
- `FileIntegrityNodeStatus`: `.nodeName`, `.results[]`, `.lastResult` →
  `condition` ∈ {`Succeeded`,`Failed`,`Errored`}, `lastProbeTime`, `errorMsg`,
  `resultConfigMapName`/`resultConfigMapNamespace`, `filesAdded`/`filesChanged`/`filesRemoved`.
- ConfigMap di risultato: nome `aide-<fileintegrity>-<node>-failed`, label
  `file-integrity.openshift.io/result-log`, `.../owner`, `.../node`; chiave dati **`integritylog`**.
  Se è presente l'annotation `file-integrity.openshift.io/compressed` il contenuto è
  **gzip → base64** (`cmd/manager/logcollector_util.go`). Sopra ~1 MB il log viene **sostituito**
  da un messaggio "fetch it from /etc/kubernetes/aide.log on node X".
- **La ConfigMap viene sovrascritta ad ogni nuovo fallimento** → esiste solo l'ultimo report per
  nodo. Gli scan `Succeeded` non lasciano ConfigMap (quella temporanea viene cancellata dal
  controller). Questo è il motivo per cui lo storico è fuori scope v1.
- **Non usare mai i nomi costruiti a mano**: leggere sempre `lastResult.resultConfigMapName`.
- Il DaemonSet `aide-<fileintegrity>` ha container **`daemon`**, `privileged: true`, che monta
  l'host `/` su **`/hostroot`**. Immagine basata su `rhel9-4-els/rhel-minimal` con `aide` e `tar`
  installati (`build/Dockerfile.openshift`) → binari per leggere un file presenti.
- Re-init del baseline: annotation **`file-integrity.openshift.io/re-init`** sul CR `FileIntegrity`
  (valore = lista di nodi separati da virgola; assente/vuoto = tutti) e
  **`file-integrity.openshift.io/re-init-on-failed`** (re-init di tutti i nodi falliti).
  `file-integrity.openshift.io/holdoff` è gestita dall'operatore durante il re-init → in v1 va
  mostrata in sola lettura, non pilotata.
- Formato report AIDE: il parser deve gestire **sia 0.16 (`CONTENTEX`) sia 0.18 (`CONTENT_EX`)**.
  ⚠️ Non impostare `report_format=json` in `aide.conf`: passerebbe indenne dal converter
  (`pkg/controller/fileintegrity/config.go`) ma romperebbe le regex di FIO
  (`Added entries:\s+(\d+)`) azzerando le annotation di summary.

Console 4.22:
- `ConsolePlugin` `console.openshift.io/v1` sul cluster supporta
  **`proxy[].authorization: UserToken`** (verificato sullo schema CRD live) → la console inoltra
  al backend il token OAuth **dell'utente loggato**. È il cardine della sicurezza del retrieve.
  Supporta anche `contentSecurityPolicy` e `i18n.loadType`.
- Stack obbligato (da `console-plugin-template@release-4.22`): SDK `4.22-latest`, **React 18.3**,
  **react-router 7.13**, **PatternFly 6.4**, webpack ≥5.107, TypeScript 5.9.3, yarn 4.
  Breaking rispetto a 4.19: niente `@openshift-console/plugin-shared`, niente
  `console.page/resource/tab`, `jsx: "react-jsx"`, `children` esplicito nelle props.

## Altre considerazioni emerse (da tenere presenti in implementazione)

1. **Nessun ServiceAccount cluster-wide per la lettura.** Il frontend legge CR e ConfigMap
   direttamente dal browser via SDK: RBAC applicata nativamente dall'API server. Il backend
   esiste *solo* per l'exec, perché il browser non parla SPDY.
2. **Il retrieve è la superficie di rischio.** `/hostroot` su un master contiene
   `static-pod-resources` (chiavi etcd), kubeconfig, chiavi TLS: leggerli = takeover. Mitigazioni
   obbligatorie, tutte insieme: token utente (non SA), deny-list di path, limite dimensione,
   sola lettura di un singolo path (mai comando arbitrario), audit di ogni lettura.
3. **Rumore operativo.** Update MCO e rotazione certificati generano centinaia di change legittimi:
   senza il bottone di re-init la dashboard diventa inutilizzabile dopo il primo update.
4. **Scala.** In lab sono 3 nodi, in produzione 100+: non fare watch su tutte le ConfigMap di
   risultato, caricarle on-demand per nodo.
5. **Il nav item deve sparire se FIO non è installato** — gating su `console.flag/model`.
6. **Licenza GPLv3** già nel repo: attenzione alle dipendenze (PatternFly MIT, SDK Apache-2.0 → ok).
7. **i18n**: il plugin è per un utente italiano; predisporre `locales/en` + `locales/it` da subito
   costa poco, aggiungerlo dopo è una riscrittura di tutte le stringhe.

## Approccio

Un **singolo binario Go** in **una sola immagine** che serve sia gli asset statici del plugin sia
l'API `/api/v1/...`. Un Deployment, un Service, un ConsolePlugin. Niente nginx separato: TLS dal
serving certificate del service (`service.beta.openshift.io/serving-cert-secret-name`).

```
Browser (sessione console, token utente)
  ├── K8s API diretta (SDK)   → FileIntegrity, FileIntegrityNodeStatus, ConfigMap risultato
  └── /api/proxy/plugin/.../fio-backend/api/v1/nodes/{node}/file?path=…
        └── console proxy (authorization: UserToken) → backend Go
              └── client k8s costruito CON IL TOKEN DELL'UTENTE
                    └── exec nel pod `aide-<fi>` sul nodo, container `daemon`
```

Il backend **non ha credenziali proprie** per l'exec: usa il bearer token ricevuto. Chi non ha già
`create pods/exec` in `openshift-file-integrity` riceve 403 dall'API server. Nessuna escalation.

## Struttura del repository

```
package.json                    # sezione consolePlugin: name/displayName/exposedModules
webpack.config.ts, tsconfig.json, console-extensions.json
locales/{en,it}/plugin__file-integrity-console-plugin.json
src/
  models.ts                     # K8sModel per FileIntegrity, FileIntegrityNodeStatus
  components/
    NodeStatusOverviewPage.tsx  # tabella nodo-per-nodo
    NodeReportPage.tsx          # report parsato di un nodo
    AideReportTable.tsx         # tabella filtrabile added/changed/removed
    FileContentModal.tsx        # retrieve + viewer
    actions/ReinitActions.tsx
  hooks/useFileIntegrities.ts, useNodeStatuses.ts, useResultConfigMap.ts
  lib/aide-parser.ts            # + __tests__/aide-parser.test.ts con fixture 0.16 e 0.18
  lib/decode.ts                 # gunzip via DecompressionStream('gzip')
backend/
  cmd/server/main.go            # static assets + API, TLS serving cert
  internal/authz/               # client k8s dal token utente, SelfSubjectAccessReview
  internal/nodefile/            # lookup pod aide + exec
  internal/policy/              # deny-list path, limiti
charts/file-integrity-console-plugin/
Dockerfile                      # multi-stage: node build → go build → runtime
```

## Implementazione

### 1. Scaffolding (base: `console-plugin-template@release-4.22`)

Partire da quel template, **non** da 4.19 o precedenti: cambia React, router e PatternFly.
In `package.json` → `consolePlugin.name: "file-integrity-console-plugin"`,
`dependencies: {"@console/pluginAPI": ">=4.22.0-0"}`.

`console-extensions.json`:
- `console.flag/model` su `FileIntegrity` → flag `FILE_INTEGRITY`; tutte le altre estensioni
  sono `required: ["FILE_INTEGRITY"]` così il menu sparisce se FIO non c'è.
- `console.navigation/href` sotto la sezione Compliance/Administration → `/file-integrity`.
- `console.page/route` per `/file-integrity` e `/file-integrity/:fiName/nodes/:nodeName`.

### 2. Overview nodo-per-nodo (`NodeStatusOverviewPage.tsx`)

`useK8sWatchResource` su `FileIntegrity` e `FileIntegrityNodeStatus` (namespace
`openshift-file-integrity`). Tabella PF6 con: nodo, condition con badge colorato
(Succeeded/Failed/Errored), files added/changed/removed da `lastResult`, `lastProbeTime`
relativo, `errorMsg` se Errored, indicatore di holdoff/re-init in corso.
Filtri per condition e ricerca per nodo. Riga cliccabile → pagina report.
Header con conteggi aggregati (n nodi ok / failed / errored / senza status).

**Non** fare watch sulle ConfigMap qui.

### 3. Report AIDE parsato (`NodeReportPage.tsx` + `lib/aide-parser.ts`)

Fetch on-demand della singola ConfigMap indicata da `lastResult.resultConfigMapName`
(`k8sGet`, non watch). Decodifica in `lib/decode.ts`: se l'annotation
`file-integrity.openshift.io/compressed` è presente → `atob` → `DecompressionStream('gzip')`
(nativo nei browser, nessuna dipendenza).

`aide-parser.ts` produce:
```ts
type AideReport = {
  summary: { added: number; changed: number; removed: number; totalEntries?: number };
  entries: Array<{
    path: string;
    kind: 'added' | 'changed' | 'removed';
    fileType?: string;
    attrs?: Array<{ name: string; old?: string; new?: string }>; // mtime, ctime, size, md5, sha256…
  }>;
  aideVersion?: string;
  truncated: boolean;     // riconosce il messaggio "too large for a configMap"
  raw: string;
};
```
Deve gestire entrambe le grammatiche (0.16 `CONTENTEX` / 0.18 `CONTENT_EX`), le sezioni
`Added entries:` / `Removed entries:` / `Changed entries:` e
`Detailed information about changes`. **Se il parse fallisce o il report è troncato → fallback
al testo raw in un `CodeEditor` read-only**, mai una pagina vuota. Test unitari con fixture
di entrambe le versioni (generarle dal lab, vedi Verifica).

`AideReportTable.tsx`: tabella filtrabile per kind e per path, colonne espandibili con il diff
degli attributi vecchio→nuovo. Le annotation di summary della ConfigMap
(`files-added`/`-changed`/`-removed`) servono da cross-check di quanto parsato: se divergono,
mostrare un warning inline (segnala un parse incompleto).

### 4. Azioni di remediation (`actions/ReinitActions.tsx`)

Patch del CR `FileIntegrity` via `k8sPatch`:
- **Re-init baseline su un nodo** → aggiunge il nodo alla lista in
  `metadata.annotations["file-integrity.openshift.io/re-init"]`.
- **Re-init su tutti i nodi falliti** → `file-integrity.openshift.io/re-init-on-failed: ""`.
- **Re-init cluster-wide** → `file-integrity.openshift.io/re-init: ""`.

Tutte dietro modale di conferma che spieghi esplicitamente che **il baseline viene ricostruito e
le modifiche attualmente segnalate smettono di essere segnalate**. L'holdoff resta in sola lettura.

### 5. Backend Go — retrieve del file

`GET /api/v1/nodes/{node}/file?path=<abs>&fileIntegrity=<name>`

1. Estrae il bearer token dall'header `Authorization` (inoltrato dal proxy console con
   `authorization: UserToken`). **Se manca → 401, mai fallback su token del pod.**
2. Costruisce un `rest.Config` con `BearerToken` = token utente.
3. `SelfSubjectAccessReview` per `create` su `pods/exec` in `openshift-file-integrity`
   → 403 con messaggio parlante se negato (l'enforcement vero resta comunque dell'API server).
4. `internal/policy`: rifiuta path non assoluti, `..`, symlink fuori radice, e una **deny-list**:
   `/etc/kubernetes/static-pod-resources/**`, `**/*.key`, `**/*.pem`, `**/kubeconfig*`,
   `/etc/kubernetes/kubelet.conf`, `**/.ssh/**`. Deny-list configurabile via Helm values.
5. Trova il pod: pod in `openshift-file-integrity` con label
   `file-integrity.openshift.io/pod` e `spec.nodeName == node` (o via ownerRef del DaemonSet
   `aide-<fi>`), stato Running.
6. Exec nel container `daemon`, comando fisso — **mai stringa costruita dall'utente**:
   `["/usr/bin/head", "-c", "<maxBytes>", "/hostroot"+path]`, argv separato, niente shell.
   Default `maxBytes` 1 MiB, configurabile.
7. Risposta JSON: `{path, node, size, truncated, contentBase64, sha256, binary: bool}`.
   Rilevare contenuto binario (byte NUL) e in quel caso mostrare hex/download invece del testo.
8. **Audit**: log strutturato con user (dal `TokenReview`), nodo, path, esito — più un
   `Event` k8s sul `FileIntegrityNodeStatus` del nodo. Il log è parte del deliverable, non
   un extra.

`FileContentModal.tsx` chiama l'endpoint, mostra il contenuto in `CodeEditor` read-only con
metadati e bottone download. Errori 403/404/413 con messaggi distinti.

### 6. Helm chart (`charts/file-integrity-console-plugin/`)

- `Deployment` (1 replica, `restricted-v2` SCC, readOnlyRootFilesystem, no privilegi),
  `Service` con annotation `service.beta.openshift.io/serving-cert-secret-name`,
  `ServiceAccount` **senza permessi sui nodi/pod** (serve solo per il `TokenReview`:
  ClusterRole minima `authentication.k8s.io/tokenreviews: create`).
- `ConsolePlugin`:
  ```yaml
  backend: { type: Service, service: { name, namespace, port: 9443, basePath: / } }
  proxy:
    - alias: fio-backend
      authorization: UserToken
      endpoint: { type: Service, service: { name, namespace, port: 9443 } }
  i18n: { loadType: Preload }
  ```
- **Hook `post-install`/`post-upgrade`**: Job che fa il patch di
  `consoles.operator.openshift.io/cluster` `.spec.plugins` aggiungendo il plugin (idempotente),
  con hook `pre-delete` che lo rimuove. Serve una ClusterRole dedicata al Job.
  È il punto in cui Helm è più debole di OLM — documentarlo nel README insieme al comando
  manuale equivalente (`oc patch consoles.operator.openshift.io cluster --type=json ...`).
- Values: immagine, deny-list path, maxBytes, abilitazione/disabilitazione del retrieve
  (`features.fileRetrieve: false` di default → chi non lo vuole non espone l'endpoint).

### 7. Fase 2 (fuori v1, da non implementare ora)

Bundle OLM con `console.openshift.io/plugins: '["file-integrity-console-plugin"]'` sulla CSV
(abilita il plugin automaticamente, risolvendo il punto debole dell'hook Helm) e storico/trend
via metriche `file_integrity_operator_*` da Thanos + Event.

## Verifica

Prerequisito: installare FIO sul lab e generare dati reali.

```bash
export OC="oc --server=https://api.ocp-lab.duckdns.org:6443 --token=… --insecure-skip-tls-verify"
# 1. installare FIO: Namespace openshift-file-integrity + OperatorGroup + Subscription
#    (channel stable, source redhat-operators) e attendere CSV Succeeded
# 2. creare un CR FileIntegrity minimale (es. name: example-fileintegrity, nodeSelector vuoto)
# 3. attendere PhaseActive e i FileIntegrityNodeStatus (init AIDE: diversi minuti)
```

1. **Generare un failure reale** — su un nodo, creare un file sotto un path monitorato
   (es. `/etc/testfile-fio`) via `oc debug node/control-plane-0`, attendere il grace period.
   Verificare `oc get fileintegritynodestatuses -n openshift-file-integrity` → `Failed`.
2. **Fixture del parser** — estrarre il report reale e salvarlo come fixture di test:
   `$OC get cm <resultConfigMapName> -n openshift-file-integrity -o jsonpath='{.data.integritylog}'`
   (se annotato `compressed`: `| base64 -d | gunzip`). Verificare **quale versione di AIDE**
   produce il report sul cluster e coprire l'altra con una fixture sintetica.
   `yarn test` deve passare su entrambe.
3. **Dev loop frontend** — `yarn start` + `yarn start-console` (console in container che punta
   al lab): verificare overview, click sul nodo, report parsato, filtri, fallback raw.
4. **Deploy sul lab** — build immagine, push su registry raggiungibile dal cluster,
   `helm install`, verificare che il Job abiliti il plugin
   (`$OC get consoles.operator.openshift.io cluster -o jsonpath='{.spec.plugins}'` contiene il
   nome) e che la voce di menu compaia nella console.
5. **Retrieve — happy path**: come cluster-admin, bottone su un file segnalato → contenuto giusto.
6. **Retrieve — negativi, tutti e quattro obbligatori**:
   - path in deny-list (`/etc/kubernetes/static-pod-resources/...`) → 403 lato backend;
   - richiesta **senza** header Authorization → 401 (nessun fallback su SA del pod);
   - richiesta con il token di un utente **senza** `pods/exec` in `openshift-file-integrity`
     (creare un utente/SA di prova con solo `view`) → 403;
   - file > maxBytes → risposta `truncated: true`, non OOM.
7. **Gating**: disinstallare (o simulare l'assenza del) CRD `FileIntegrity` → la voce di menu
   deve sparire, non andare in errore.
8. **Re-init**: premere il bottone su un nodo failed → verificare l'annotation sul CR, il
   DaemonSet `aide-ini-*` che parte, e il ritorno a `Succeeded`.
