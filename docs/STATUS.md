# Stato dei lavori — aggiornato 25 luglio 2026

Il piano approvato è in [`IMPLEMENTATION-PLAN.md`](./IMPLEMENTATION-PLAN.md): contiene le
decisioni prese, i fatti verificati sul modello dati del File Integrity Operator (da **non**
riderivare) e la procedura di verifica. Leggerlo prima di riprendere.

## Fatto

1. **File Integrity Operator installato sul cluster di lab** — namespace
   `openshift-file-integrity`, CR `FileIntegrity` creato, `FileIntegrityNodeStatus` presenti.
2. **Scaffolding del console plugin** da `console-plugin-template@release-4.22` — `package.json`,
   `webpack.config.ts`, `tsconfig.json`, `console-extensions.json`, jest, yarn 4.
3. **Parser AIDE e decode** — `src/lib/aide-parser.ts` (grammatiche 0.16 `CONTENTEX` e 0.18
   `CONTENT_EX`, rilevamento troncamento), `src/lib/decode.ts` (base64 + gzip via
   `DecompressionStream`). Fixture in `src/lib/__fixtures__/`, spec accanto ai sorgenti.
4. **Frontend** — `NodeStatusOverviewPage`, `NodeReportPage`, `AideReportTable`,
   `FileContentModal`, `ReinitActions`, `ConditionLabel`, hook `useFileIntegrityData`,
   `models.ts`, `types.ts`. Locali `en` + `it` allineate (89 chiavi).
   `yarn test` → 3 suite, 39 test verdi. `yarn build` produce `dist/` con manifest e locali.
5. **Backend Go** (`backend/`) — `cmd/server/main.go`, `internal/authz` (client k8s dal token
   utente + `SelfSubjectReview`/`SelfSubjectAccessReview`), `internal/nodefile` (lookup del pod
   `aide-*` sul nodo + exec nel container `daemon`), `internal/policy` (deny-list path, limiti)
   con `policy_test.go`. **`go vet`, `go build` e `go test` passano tutti.**
6. **Helm chart** (`charts/file-integrity-console-plugin/`) — riscritto per il binario Go
   singolo: via il ConfigMap `nginx.conf`, ConfigMap di policy per le deny-list, Deployment con
   flag del binario + probe su `/healthz` + `readOnlyRootFilesystem`, Service con
   `service.beta.openshift.io/serving-cert-secret-name`, `ConsolePlugin` con
   `proxy[].alias: fio-backend` e `authorization: UserToken`, ServiceAccount **senza alcun
   ruolo**, Job `post-install`/`post-upgrade` che abilita il plugin e Job `pre-delete` che lo
   rimuove. `helm lint` e `helm template` puliti nelle varie combinazioni di values.
7. **Containerfile** multi-stage (asset node → build Go → runtime ubi-minimal, non-root, porta
   9443) e **`.containerignore`**.
8. **README** — architettura, modello di sicurezza, install, tabella dei values, dev loop.

## Scostamenti consapevoli dal piano

- **Niente ClusterRole `tokenreviews: create`** per il ServiceAccount del backend. Il piano lo
  prevedeva assumendo `TokenReview`; il codice usa `SelfSubjectReview`, che gira *come l'utente*
  e non richiede alcun privilegio. L'account resta quindi senza ruoli, il che è più stretto.
- **Il `proxy` nel `ConsolePlugin` è dichiarato sempre**, anche con
  `backend.features.fileRetrieve: false`. L'interruttore vero è il flag del backend, che
  risponde 501 con un messaggio che la modale già traduce in "funzione disabilitata"; togliendo
  il proxy la console risponderebbe 404 e la UI direbbe "nessun pod di scan sul nodo",
  cioè il motivo sbagliato.
- **Flag `--extra-deny-list-file` aggiunto** al backend, così i values possono *aggiungere*
  pattern alla deny-list senza ricopiare i default (una copia dei default invecchia e finisce
  per permettere ciò che un default più recente negherebbe).
- **Niente `Event` k8s per l'audit** (punto 5.8 del piano): resta il solo log strutturato.
  Crearlo col token del chiamante fallisce proprio per gli utenti che contano — chi non ha
  `pods/exec` di solito non ha nemmeno `create events`, e una richiesta senza token non ha
  utente; crearlo col SA del backend gli darebbe l'unico permesso di cui altrimenti non ha
  bisogno, e siccome il controllo della deny-list precede l'autenticazione aprirebbe la
  scrittura a chiamanti anonimi. Verificato sul lab che il registro autorevole esiste già:
  l'audit log del kube-apiserver registra il `pods/exec` con utente, pod, **comando completo
  (quindi il path)** e decisione RBAC. Gli `Event` su questo cluster hanno `event-ttl: 3h`,
  quindi come registro d'audit non servirebbero comunque. Il README documenta entrambe le
  fonti e il comando per estrarle.

## Verificato sul lab (25 luglio 2026)

Immagine costruita **in-cluster** con `oc new-build --binary --strategy=docker` +
`dockerfilePath: Containerfile`, perché in ambiente di sviluppo non c'è podman. Il registry
interno del cluster era `Removed`: riabilitato con `managementState: Managed` e storage
`emptyDir` (patch reversibile, immagini non persistenti — va bene per un lab). Dopo la patch
serve un riavvio dei pod di `openshift-controller-manager`, altrimenti le build falliscono con
`InvalidOutputReference` perché il controller ha in cache "registry non configurato".

- Containerfile: tutti e tre gli stage costruiscono, immagine 146 MB, push riuscito.
- `helm install` + Job di patch: il plugin viene aggiunto a `consoles.operator/cluster`
  **preservando** gli altri già presenti (`monitoring-plugin`, `odf-console`, …).
- La console registra il plugin e monta la rotta proxy
  `/api/proxy/plugin/file-integrity-console-plugin/fio-backend/`, cioè esattamente l'URL che il
  frontend costruisce da `BACKEND_BASE_URL`.
- Asset statici serviti in TLS dal binario Go, `plugin-manifest.json` con `cache-control:
  no-cache`, locali `en`/`it` raggiungibili, `/healthz` 200.
- Retrieve, tutti e otto i casi provati contro il Service:
  happy path 200 con contenuto reale del nodo; **401** senza `Authorization`; **403** su
  deny-list; **403** per un SA con solo `view` (niente `pods/exec`); **403** su `..`;
  **404** file inesistente; **404** nodo senza pod di scan; file da 50 MB → `size: 1048576`,
  `truncated: true`, `binary: true`, nessun OOM.
- Log di audit presenti per ogni tentativo, con l'utente giusto
  (`admin` e `system:serviceaccount:…:fio-viewer`) ed esito.

Due bug trovati dal cluster e corretti:

- `--max-file-bytes` veniva reso come `1.048576e+06` (Helm interpreta i numeri YAML come
  float64) e il binario rifiutava il flag → `| int64` nel template.
- il predicato di fallback dell'executor tornava `true` per qualunque errore, quindi a ogni
  lettura fallita il comando veniva rieseguito su SPDY e lo stderr compariva due volte → ora
  usa `httpstream.IsUpgradeFailure`/`IsHTTPSProxyError`, come kubectl.

## CI e qualità (25 luglio 2026)

- `yarn lint` **non era mai partito**: la config importava `eslint-plugin-playwright`, assente
  tra le dipendenze. Tolto insieme al blocco che copriva `integration-tests/`, che qui non
  esiste. Sotto ci stavano 143 violazioni, ora **zero**.
- `.prettierrc.yml` diceva `printWidth: 100` mentre il codice è scritto a 80: allineato a 80,
  altrimenti ogni `--fix` riformatta il repo intero.
- Correzioni sostanziali emerse dal linter: `errorMessage()` in `src/lib/errors.ts` al posto di
  cinque `(e as Error)?.message ?? String(e)` (che producevano `[object Object]`); narrowing
  vero della risposta JSON in `backend.ts`; quattro reset di stato spostati da `useEffect` alla
  fase di render, che evita anche un frame con i dati del nodo precedente.
- Due scelte di configurazione invece che di codice, documentate in `eslint.config.mjs`:
  numeri ammessi nei template literal, e `no-non-null-assertion` spento nei soli file `.spec`.
- `.github/workflows/ci.yml`: frontend (lint senza `--fix`, tsc, test, build, allineamento
  `en`/`it`), backend (vet, test, build), chart (`helm lint` + `helm template` con assert sui
  **default**, che è il caso che aveva prodotto `1.048576e+06`, e un assert che il SA del
  backend resti senza ruoli), immagine (`podman build` + smoke test del binario). Tutti i
  controlli sono stati provati a mano qui, tranne il job dell'immagine: manca podman.

## Da fare

9. **Verifica della UI nel browser** — fatta in parte: l'utente ha confermato che il toggle del
   report grezzo ora funziona. Restano overview, filtri, modale del contenuto, re-init, e il
   gating quando manca il CRD `FileIntegrity` (che sul lab non si può provare senza
   disinstallare l'operatore).

   Trappola trovata sul campo: la console legge il manifest del plugin **una volta e lo mette
   in cache**. Dopo una nuova build serve `oc rollout restart deployment/console -n
   openshift-console`, altrimenti il browser continua a caricare il bundle vecchio comunque lo
   si ricarichi. Documentata nel README.
10. **Pubblicazione su `quay.io/asalvati`** — deciso il 25 luglio 2026: **solo linux/amd64**, e
    la build la fa **Quay** con una regola automatica sul repository GitHub, non un workflow di
    release. Il Containerfile resta quindi senza `TARGETARCH`. Da configurare nel trigger Quay:
    percorso `/Containerfile` (il wizard cerca un `Dockerfile`, che qui non esiste di proposito)
    e contesto `/`. Il multi-arch, se servirà, costa poco: gli asset sono JavaScript e il
    binario è `CGO_ENABLED=0`, quindi entrambi gli stage restano nativi senza emulazione.

    Due trappole già verificate sul campo, entrambe nel README: con un tag mutabile come
    `:latest` serve `plugin.imagePullPolicy=Always`, altrimenti il kubelet riusa l'immagine in
    cache e il rollout riparte con il binario vecchio dichiarando successo; e dopo ogni nuova
    build va riavviata la console, che tiene il manifest del plugin in cache.

## Note d'ambiente

- Il toolchain Go **non è preinstallato** e `/tmp` è un tmpfs da 1 GB: troppo piccolo per il
  module cache. Installare Go in `/var/tmp` (46 GB) ed esportare:
  ```sh
  export PATH=/var/tmp/go/bin:$PATH GOPATH=/var/tmp/gopath \
         GOMODCACHE=/var/tmp/gomod GOCACHE=/var/tmp/gocache
  ```
  `/var/tmp` è un tmpfs: si svuota al riavvio del container, va rifatto ogni volta. Vale lo
  stesso per `helm`, anch'esso assente (`oc` e `kubectl` invece ci sono).
- `yarn` non è nel PATH: usare il binario committato, `node .yarn/releases/yarn-4.14.1.cjs <cmd>`.
- Il token del cluster di lab è fornito dall'utente in chat, non è salvato nel repo.
