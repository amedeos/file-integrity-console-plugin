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

## In corso

5. **Backend Go** (`backend/`) — codice scritto per intero: `cmd/server/main.go`,
   `internal/authz` (client k8s dal token utente + `SelfSubjectAccessReview`),
   `internal/nodefile` (lookup del pod `aide-*` sul nodo + exec nel container `daemon`),
   `internal/policy` (deny-list path, limiti) con `policy_test.go`.

   `go vet ./...` passa pulito. **`go build` e `go test` non sono ancora stati eseguiti** —
   erano il passo successivo quando la sessione si è chiusa.

## Da fare

6. **Helm chart** — `charts/file-integrity-console-plugin/` è ancora il **template upstream
   intatto** (basato su nginx, nome `openshift-console-plugin`). Va riscritto per il binario Go
   singolo: rimuovere il ConfigMap `nginx.conf`, Service con
   `service.beta.openshift.io/serving-cert-secret-name`, `ConsolePlugin` con
   `proxy[].alias: fio-backend` e `authorization: UserToken`, ConfigMap di policy (deny-list,
   `maxBytes`, `features.fileRetrieve: false` di default), ServiceAccount con ClusterRole
   minima (`tokenreviews: create`). Gli hook `patch-consoles` del template si possono tenere.
7. **Dockerfile multi-stage** (build asset node → build Go → runtime) e **README**.
8. **Verifica end-to-end sul lab** — i sette punti elencati in fondo al piano, inclusi i
   **quattro casi negativi obbligatori** del retrieve (deny-list, assenza di `Authorization`,
   utente senza `pods/exec`, file oltre `maxBytes`).

## Note d'ambiente

- Il toolchain Go **non è preinstallato** e `/tmp` è un tmpfs da 1 GB: troppo piccolo per il
  module cache. Installare Go in `/var/tmp` (46 GB) ed esportare:
  ```sh
  export PATH=/var/tmp/go/bin:$PATH GOPATH=/var/tmp/gopath \
         GOMODCACHE=/var/tmp/gomod GOCACHE=/var/tmp/gocache
  ```
  `/var/tmp` è un tmpfs: si svuota al riavvio del container, va rifatto ogni volta.
- Il token del cluster di lab è fornito dall'utente in chat, non è salvato nel repo.
