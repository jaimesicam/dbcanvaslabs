# LABORATORY.md — CloudNativePG Lab Roadmap

This file tracks the **CloudNativePG (CNPG)** labs planned for DBCanvas Labs, now the
app's only content — the earlier Patroni / PXC / Valkey labs were dropped so the whole
platform could focus on running these against a real cluster instead of a simulation.
Content and scenarios are based on the [CNPG end-to-end test suite](https://cloudnative-pg.io/docs/1.30/e2e/),
adapted into progressively-revealed, graded hands-on labs.

Every lab here targets a **3-node k3d cluster with the CloudNativePG operator**, backed
by **SeaweedFS** (S3-compatible) for backup/restore scenarios, mirroring how `dbcanvas`
itself deploys a real K3D + CNPG + SeaweedFS frame. Content is authored by mining real
behavior from that stack (`docker exec`/`kubectl` output, real timings, real failure
modes) — never invented shell transcripts.

Checked labs (`[x]`) are playable end to end in this app today. Everything else is
roadmap — browsable eventually, not yet built.

## Basic

- [x] Installation of the operator
- [x] Creation of a Cluster
- [x] Usage of a persistent volume for data storage

## Service connectivity

- [x] Connection via services, including read-only
- [x] Connection via user-provided server and/or client certificates — built as two labs, one
      per half. *Connecting with Client Certificates* issues a client certificate from the
      cluster's own CA with the cnpg plugin, enables `cert` authentication declaratively and
      connects with `verify-full` and no password. *Serving Your Own Server Certificate*
      creates a CA with openssl, issues a server certificate for the Service names, and hands
      both to the operator through `spec.certificates`.
- [x] PgBouncer

## Self-healing

- [x] Failover
- [x] Switchover
- [x] Primary endpoint switch in case of failover in less than 10 seconds
- [x] Primary endpoint switch in case of switchover in less than 20 seconds
- [x] Recover from a degraded state in less than 60 seconds
- [x] PVC Deletion
- [x] Corrupted PVC

## Backup and Restore

- [x] Backup and restore from Volume Snapshots — needs a snapshot-capable CSI driver, which
      k3s does not ship (`local-path` cannot snapshot). Built on `csi-driver-host-path`, the
      driver the Kubernetes project tests snapshots against, because it is the only class that
      works here: this Docker VM exposes no loadable kernel modules, so Ceph (`rbd`), Longhorn
      (`iscsi_tcp`) and OpenEBS (`device-mapper`/`zfs`) cannot mount volumes at all. Two
      consequences are baked into `server/csi.go`: its sidecar ClusterRoles are **vendored**
      (upstream assembles them from five separate repos at versions derived by parsing image
      tags), and the driver is a single-replica StatefulSet, so it and the lab's cluster are
      both pinned to the server node and the cluster is single-instance.
- [x] Backup and ScheduledBackups execution using Barman Cloud on SeaweedFS — built with the
      **Barman Cloud Plugin**, not the in-tree `spec.backup.barmanObjectStore`: the in-tree
      field still exists in 1.30 but every use of it returns a deprecation warning and it is
      removed in 1.31.
- [x] Restore from backup using Barman Cloud on S3 SeaweedFS
- [x] Point-in-time recovery (PITR) on S3 SeaweedFS
- [x] Wal-Restore (sequential / parallel) — the environment writes ~700k rows after the base
      backup so the archive is ~100+ segments and replaying it dominates the recovery, which
      is what makes the comparison measurable: three sequential recoveries took 81, 72 and 91
      seconds against 61, 56 and 60 with `wal.maxParallel: 8`.

## Operator

- [x] Operator Deployment — built as an audit of an installed operator (namespace inventory,
      RBAC, both admission webhook configurations, the leader-election Lease), ending by
      scaling the operator to zero and watching the API server refuse a Cluster because the
      webhook has no endpoints.
- [x] Operator configuration via ConfigMap
- [x] Operator pod deletion
- [x] Operator pod eviction — built around the Eviction API itself rather than a node drain:
      permitted with no budget, refused with `TooManyRequests` under a `minAvailable: 1`
      PodDisruptionBudget over a single replica (the trap that hangs a drain), permitted again
      once a second replica exists.
- [x] Operator upgrade — the environment installs the **previous** minor release (1.29.2) and
      stages 1.30.0, so the upgrade is real: the CRD count goes 10 → 11 (`failoverquorums`
      appears) and the instance Pods are never restarted — ages keep climbing, restart counts
      stay at 0.
- [x] Operator High Availability — three replicas, one Lease; deleting the holder saw a
      standby take over in 2 seconds, because a clean shutdown releases the Lease rather than
      letting it expire.

## Observability

- [x] Metrics collection — instances serve 463 `cnpg_` series on port 9187 with no monitoring
      stack installed; scraped with curl from the `toolbox` tab, which routes to Pod
      addresses like a node does but carries the tools the k3s image lacks. Ends by adding a
      custom query via ConfigMap and watching `cnpg_lab_rows_total` go from 0 to 1 as a table
      is created.
- [x] PgBouncer Metrics — a different port (9127) and 51 `cnpg_pgbouncer_` series, including
      the detail that a `database="app"` pool series only exists once traffic has used it.
- [x] JSON log format — structured by default with no plain-text mode; PostgreSQL's CSV log
      fields arrive nested under `record`, so a failed statement is found by
      `sql_state_code` 22012 rather than by grepping its message. Worked from the `toolbox`
      tab with jq: 500 instance log lines parsed without a single failure, which is the
      property that makes a parser safe to use here instead of a regex.

## Replication

- [x] Replication Slots — high-availability slots are **on by default** in 1.30, so the lab is
      about reading them rather than enabling them: a healthy cluster already carries
      `_cnpg_pg_cluster_2` and `_cnpg_pg_cluster_3`. Fencing a standby leaves its slot
      `active = f` with `restart_lsn` retained and `wal_status = reserved`; unfencing sees it
      catch up from that WAL with the Pod never restarted. Ends by disabling the feature and
      finding replication still healthy — a slot carries no data, only the guarantee.
- [x] Synchronous replication — `spec.postgresql.synchronous` (method/number), not the older
      `minSyncReplicas`. The generated `synchronous_standby_names` includes the primary in its
      own list. With `number: 2` and one standby fenced, a write parks in `wait_event` **SyncRep**
      and `statement_timeout` does **not** interrupt it — the statement has finished; the commit
      acknowledgement has not. Switching `dataDurability` to `preferred` rewrote the setting to
      `ANY 1 ("pg-cluster-2")` and released the blocked write instantly.
- [x] Scale-up and scale-down of a Cluster — patching `spec.instances` 3 → 4 produces a
      short-lived `pg-cluster-4-join-*` Pod (the operator running `pg_basebackup`), then an
      instance carrying rows written before it existed. Scaling back to 3 removes the instance,
      its PVC **and** its replication slot together — the last of which is the one worth
      checking, since an orphaned slot makes the primary reserve WAL forever.
- [x] Logical replication via declarative Publication / Subscription — needs **two** clusters,
      so the recipe builds a 3-instance publisher and a single-instance subscriber carrying an
      `externalClusters` entry. Four requirements were found the hard way and are now the
      lab's spine: `wal_level` is already `logical` (CNPG default, nothing to change);
      `streaming_replica` **cannot** be used, because the source's generated `pg_hba` admits it
      only to the `postgres` database, so a password role with `REPLICATION` granted is
      required; that role also needs `SELECT`, or the subscription applies cleanly and the
      initial copy fails with `permission denied for table`; and logical replication carries no
      DDL, so a missing table on the subscriber gives `applied:false` with `relation
      "public.orders" does not exist` — which the operator then heals by itself once the table
      exists. `publicationDBName` bridges an external cluster whose database differs from the
      publication's.

## Replica clusters

- [x] Bootstrapping a replica cluster from backup — the barman stack with a base backup already
      in the bucket, and one field between a restore and a replica: `replica.enabled` keeps the
      recovered cluster in recovery instead of promoting it. The manifest names no host, port or
      credential for the source — only a bucket and a server name through the plugin. The proof
      it is coupled through object storage alone is on the replica itself: `pg_last_wal_receive_lsn`
      stays **empty** while `pg_last_wal_replay_lsn` advances, and the source's
      `pg_stat_replication` never mentions it. Latency is a WAL segment, not milliseconds —
      `pg_switch_wal()` makes a new row appear.
- [x] Bootstrapping a replica cluster via streaming — built as *Replica Clusters*: a separate
      Cluster object with `bootstrap.pg_basebackup` plus `replica.enabled`, cloned from the
      source in about 60 seconds. It appears in the source's `pg_stat_replication` under the
      cluster's name, refuses writes with a read-only *transaction* error (not a permissions
      one — the superuser is refused too), and detaching via `replica.enabled: false` promotes
      it onto **timeline 2**, at which point the source stops streaming to it and the histories
      diverge for good. The lab also covers *Detaching a replica cluster* below.
- [x] Bootstrapping via volume snapshots — a VolumeSnapshot of the running database's PVC
      (`readyToUse` in ~20s, restoreSize 1Gi, with a cluster-scoped VolumeSnapshotContent behind
      it), then a cluster whose data directory *is* that snapshot. A snapshot is a moment, so the
      manifest pairs `bootstrap.recovery.volumeSnapshots` with `replica.enabled` and a streaming
      `externalClusters` entry: snapshot as seed, streaming to stay current. Unlike the archive
      shape this replica has a WAL receiver — receive and replay LSNs both advance. Nothing
      quiesces the database first; the copy is crash-consistent, which PostgreSQL survives because
      crash recovery is what it does on every start.
- [x] Detaching a replica cluster — the third objective of *Replica Clusters* above: one field,
      `replica.enabled: false`, and it is not reversible.

## Plugin

- [x] Cluster Hibernation using CNPG plugin — `kubectl cnpg hibernate on` annotates the Cluster
      `cnpg.io/hibernation: on`, removes every instance Pod and keeps all three PVCs bound; the
      Services survive with no endpoints, so a connection is refused outright. `hibernate off`
      brought three Pods back in about 75 seconds with the data intact. The clearest view of
      the mechanism is the age mismatch afterwards — Pods 90s old on volumes 10m old.
- [x] Fencing — the interface is the annotation `cnpg.io/fencedInstances`; the plugin is a
      convenience over `kubectl annotate`. The Pod stays with `restartCount` 0 and only
      `/controller/manager` running inside it — no postgres process — and `Ready` flips to
      false about 30 seconds later, which is what removes it from the Services. The PVC is
      untouched, so the data directory is preserved exactly as it was, and unfencing catches
      up from the replication slot with no rebuild.
- [x] Creation of a connection certificate — already covered by *Connecting with Client
      Certificates*, whose second objective is `kubectl cnpg certificate app-client-cert
      --cnpg-cluster pg-cluster --cnpg-user app`. Not built again as a separate lab.

## Postgres Configuration

- [x] Manage PostgreSQL configuration changes — three outcomes, not two. Reload-only
      (`log_min_duration_statement`) applies with `pending_restart` false and nothing
      restarted. Restart-required (`max_connections`) sets `pending_restart` true and rolls the
      cluster — and the primary's Pod is *not* recreated: its postmaster restarts inside the
      running container, `restartCount` staying 0, under the default
      `primaryUpdateMethod: restart`. Fixed parameters are refused at admission
      (`listen_addresses`, `data_directory`, `shared_preload_libraries`, `hot_standby`), with
      `wal_log_hints: off` refused by a message that reasons about the cluster. **A first draft
      claimed `wal_level: replica` was silently overridden back to `logical`; verification
      disproved it** — `wal_level` is restart-required and the early reading was simply the old
      default.
- [x] Rolling updates when changing PostgreSQL images — the environment starts on
      `18.3-system-trixie` (both images pre-seeded into every node) so the change to 18.4 is
      real. Mid-roll the Pods genuinely disagree — one on 18.4 and not ready, two on 18.3 —
      while the cluster reports "Waiting for the instances to become active" and still answers
      queries. Creation timestamps show the order: replicas first, primary last. Every Pod is
      recreated, because a container cannot change image in place.
- [x] Rolling updates when changing ImageCatalog/ClusterImageCatalog images — `spec.images` is
      the required list ({major, image}); `spec.componentImages` is a *separate* list keyed by
      {key, image} for non-PostgreSQL components, and putting `major` there is rejected with a
      strict-decoding error. Adopting a catalog is a no-op when it names the running image — the
      remove of `spec.imageName` and the add of `imageCatalogRef` must be one atomic JSON patch,
      since a Cluster may not have both. Then editing **only the catalog** rolled the cluster
      18.3 → 18.4 while the Cluster object was never touched and still names no image.
- [x] Rolling updates on hot standby sensitive parameter changes — the five settings a standby
      may not hold below its primary, and the channel by which it learns the primary's values:
      **the control file**, updated from the WAL's parameter-change record, so `pg_controldata` on
      a standby reports the *primary's* numbers (abbreviated there as `max_prepared_xacts` and
      `max_locks_per_xact`). The operator rolls standbys first, which is the order an *increase*
      requires. **A hypothesis tested and disproved while building this: the order does not
      reverse for a decrease** — one order is safe both ways.
- [x] Database initialization via InitDB — a cluster bootstrapped with `database: orders`
      owned by `shop`, `walSegmentSize: 32` (pg_settings reports 33554432), and both hooks
      running: `postInitApplicationSQL` seeded a table inside the application database,
      `postInitSQL` created a role in `postgres`. The spine is what happens next: patching
      `database`, `walSegmentSize` and `dataChecksums` on the running cluster is **accepted**
      with no warning and has no effect — the spec permanently says `renamed`/64/false while the
      database stays `orders`/32MB/on. `bootstrap` is a one-shot instruction, not desired state.
      One reading not to misattribute: `data_checksums` is on regardless, because PostgreSQL 18's
      own initdb enables it — CNPG's `dataChecksums` only controls whether `-k` is passed.

## Pod Scheduling

- [x] Tolerations and taints — `NoSchedule` governs placement only: the instance already on a
      freshly tainted node keeps running and the database never notices. Deleting it strands it,
      and the scheduler names **two** reasons at once — `1 node(s) had untolerated taint(s), 2
      node(s) didn't match PersistentVolume's node affinity` — because a `local-path` claim pins
      the instance (via `volume.kubernetes.io/selected-node`) to the very node now tainted.
      Neither fact alone would strand it. A toleration under `spec.affinity.tolerations` is
      written verbatim onto the Pod and schedules it back onto the still-tainted node.
- [ ] Pod affinity using `NodeSelector`
- [ ] Rolling updates on PodSpec drift detection
- [ ] In-place upgrades
- [ ] Multi-Arch availability

## Cluster Metadata

- [ ] ConfigMap for Cluster Labels and Annotations
- [ ] Object metadata

## Recovery

- [ ] Data corruption
- [ ] pg_basebackup

## Importing Databases

- [ ] Microservice approach
- [ ] Monolith approach

## Storage

- [ ] Storage expansion
- [ ] Dedicated PG_WAL persistent volume

## Maintenance

- [ ] Node Drain with maintenance window
- [ ] Node Drain with single-instance cluster with/without Pod Disruption Budgets

## Hibernation

- [ ] Declarative hibernation / rehydration

## Volume snapshots

- [ ] Backup/restore for cold and online snapshots
- [ ] Point-in-time recovery (PITR) for cold and online snapshots
- [ ] Backups via plugin for cold and online snapshots
- [ ] Declarative backups for cold and online snapshots

## Managed Roles

- [ ] Creation and update of managed roles
- [ ] Password maintenance using Kubernetes secrets

## Tablespaces

- [ ] Declarative creation of tablespaces
- [ ] Declarative creation of temporary tablespaces
- [ ] Backup / recovery from object storage
- [ ] Backup / recovery from volume snapshots

## Declarative databases

- [ ] Declarative creation of databases with default (retain) reclaim policy
- [ ] Declarative creation of databases with delete reclaim policy

## Major version upgrade

- [ ] Upgrade to the latest major version

## Content pipeline

This app no longer simulates CNPG — `server/` is a real Go backend that provisions an
actual k3d + MetalLB + SeaweedFS + CloudNativePG environment per attempt, and grading
(`server/check.go`) runs real `kubectl`/`psql` against it. The pipeline below is how the
28 built labs got their real command transcripts, object names and timings, and how each
future lab on this roadmap should be added:

1. **Prove the mechanism against dbcanvas first, if it's new.** `../dbcanvas` (read-only,
   never modified) already runs a real K3D + CloudNativePG + SeaweedFS deploy in
   production — its own `app/cnpg.go`/`k3d.go`/`seaweedfs.go` are the reference for any
   CNPG mechanism not yet implemented in `server/` (e.g. the Barman Cloud plugin backup
   labs below). Drive its *running instance* (`http://localhost:8080`, `admin`/`dudedude`)
   to see the real behavior before implementing it here — never its source.
2. **Implement the provisioning step for real in `server/`** (`attempts.go`'s per-lab
   recipe, plus whatever `cnpg.go`/`k3d.go` method it needs) — every lab's precondition
   is achieved by actually running the real commands server-side once, not by faking a
   starting state.
3. **Add the lab's real, on-demand checks** to `server/check.go` — real `kubectl -o json`
   queries and `cat`/`psql` reads, parsed the same way a human would read the output,
   returning the `{ok, checks}` shape `ObjectiveRail` already renders.
4. **Author the lab content** in `src/labs/` — `id`, `terminals`, an `environment` block,
   and a `tasks[]` array of pure content (`title`, `limitSec`, `criteria`, `brief`,
   `instructions`, `hint`, `solution`). No grading logic lives in the frontend at all;
   `criteria` strings must match the labels `check.go` actually returns, since that's what
   the learner sees flip.

   Three rules bind every lab, and CLAUDE.md's **lab content contract** is the authority on
   them: (a) labs are **independent** — any lab can be entered first, so none may refer to
   another, and whatever a lab needs present is built by its own step-2 recipe and presented
   as its own given; (b) `environment` (`summary`, `provides[]`, `yourJob`) tells the learner
   what is being built and what is deliberately left undone, shown on the provisioning screen
   while the real cluster comes up, and must match step 2 exactly, versions included; (c)
   every task carries a `brief` — the popup shown when that objective starts and again
   whenever its number is clicked in the rail — saying what the objective asks and why, not
   which commands to type.

5. **Record the commands** in `src/reference/cnpg.js`, so the Command Reference page keeps
   pace with the labs: every command the lab hands the learner, with a real captured example
   and its real output. CLAUDE.md's **command reference contract** is the authority.
