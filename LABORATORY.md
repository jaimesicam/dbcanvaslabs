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

**Every item on this roadmap is now built**: 71 labs, each provisioning a real cluster and
grading real command output. New entries added below start unchecked and go through the
same pipeline (see *Content pipeline* at the end).

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
- [x] Pod affinity using `NodeSelector` — built as *Node Selectors and Pod Anti-Affinity*. A
      Cluster nobody has touched already reads `podAntiAffinityType: preferred`, defaulted in by
      the webhook, and only the *Pod* carries the rule it expands into — a weighted term on
      `kubernetes.io/hostname`. Declaring `spec.affinity.nodeSelector` rolls the cluster, and on
      `local-path` storage the first Pod rebuilt cannot be placed at all: `1 node(s) didn't match
      PersistentVolume's node affinity, 2 node(s) didn't match Pod's node affinity/selector`.
      Labelling the remaining nodes fixes it without touching the database. The third objective is
      the single-zone trap — `required` over a topology every node shares, which strands an
      instance with `didn't match pod anti-affinity rules`.
- [x] Rolling updates on PodSpec drift detection — the operator keeps the Pod spec it generated in
      the `cnpg.io/podSpec` annotation and compares *that*, not the live object. A `spec.resources`
      patch rolls all three instances in under a minute (replicas first, primary last, phase
      "Primary instance is being restarted without a switchover", primary unchanged); overwriting
      one Pod's annotation with junk has that Pod deleted and rebuilt within three seconds, while
      an ordinary label of the learner's own on the same Pod is left alone forever.
- [x] In-place upgrades — the instance manager is an operator binary running as PID 1 in every
      postgres container, so by default an operator upgrade replaces every instance Pod.
      `ENABLE_INSTANCE_MANAGER_INPLACE_UPDATES=true` (INPLACE, one word — the `IN_PLACE` spelling
      is ignored in silence and the operator logs the setting still false) makes 1.29.2 → 1.30.0
      swap the binary inside the running containers: `cnpg.io/operatorVersion` moves, creation
      timestamps do not, restart counts stay 0 and PostgreSQL's uptime spans the upgrade.
- [x] Multi-Arch availability — the environment is whatever the host is, so the lab reads its own
      architecture and then asks ghcr.io what the pinned tag really contains: an index of four
      manifests, `linux/amd64`, `linux/arm64` and two `unknown/unknown` build attestations.
      Following the platform digest to its manifest and then to the config blob returns the
      image's own `{"architecture":"arm64","os":"linux"}`. Grading walks the same chain
      server-side (`server/registry.go`), which is the only way to check a digest the learner
      typed. The Pod's `imageID` deliberately is **not** compared: these images are side-loaded
      into the k3d nodes, so the local re-pack has a different digest.

## Cluster Metadata

- [x] ConfigMap for Cluster Labels and Annotations — built around the per-cluster field,
      `spec.inheritedMetadata`, which needs no operator restart: labels and annotations reach the
      Pods, claims, Services and the generated Secret within seconds with nothing recreated. Two
      asymmetries are the spine: changing a value rewrites it everywhere, while removing a key
      leaves the old label on every object indefinitely (and a merge patch needs an explicit
      `null` to remove it at all). It ends by inheriting `cnpg.io/instanceRole: primary`, which
      overrides the operator's own routing label — three endpoints behind the read-write Service
      and `cannot execute INSERT in a read-only transaction` on five writes out of six.
- [x] Object metadata — one selector, `cnpg.io/cluster`, inventories everything the operator
      generated; the per-kind role labels (`podRole`, `pvcRole`, `userType`) and the `-rw`/`-ro`/
      `-r` Service selectors are the whole of CloudNativePG's traffic routing. Relabelling a
      replica `primary` by hand is reverted in about a second — too fast for the EndpointSlice
      controller to act on it — while a label of the learner's own on the same Pod survives.

## Recovery

- [x] Data corruption — damage *inside* a table rather than in the files that stop a server
      starting: 256 bytes overwritten in one 8KB page of a real relation. The instance stays
      Ready, the Cluster still reports "Cluster in healthy state" 3/3, and only a query touching
      that block fails — `ERROR: invalid page in block 3 of relation "base/16385/16390"`. The
      spine is the gap between healthy and correct: `pg_stat_database.checksum_failures` counts
      failed *reads* (zero until something looks, and reset by a restart), `pg_checksums --check`
      is the only thing that goes looking, and it needs the instance stopped, which fencing does.
      The replicas are untouched because replication ships WAL records rather than pages, so the
      recovery is switchover first, then `kubectl cnpg destroy` — which leaves the claim
      Terminating until the Pod the operator has already recreated is deleted.
- [x] pg_basebackup — built as *Cloning a Cluster with pg_basebackup*: the same bootstrap block
      as a streaming replica cluster with the `replica` stanza left out, which is the whole
      difference. A `pg-clone-1-pgbasebackup-*` Job copies the source in ~36 seconds and the copy
      comes up as its own primary (`pg_is_in_recovery()` is `f`, no WAL receiver, absent from the
      source's `pg_stat_replication`). Two findings make the lab: the operator resets the
      application user to the clone's own Secret, so the source password is refused on the copy;
      and both clusters stay on **timeline 1**, since a clone is never promoted — after which the
      same id means a different row on each side and their WAL must never share an archive.

## Importing Databases

- [x] Microservice approach — `bootstrap.initdb.import` with `type: microservice` moves one
      database off a shared server with pg_dump and pg_restore, in about 30 seconds. It arrives
      as the new cluster's **app** database with its objects reassigned to the new **app** user,
      so both the database name and the ownership change; no roles come with it, and a row
      written on the source afterwards never appears (501 against 500). The connection must be
      made as a superuser, so the recipe switches `enableSuperuserAccess` on for the source.
- [x] Monolith approach — the same field with `type: monolith` and `"*"` for both databases and
      roles lifts the whole server: names, owners, grants and roles kept, including a NOLOGIN
      role and the login role's password hash, so `shop` authenticates on the copy with the
      password it had on the original. What such a cluster does *not* have is the interesting
      half — no application database, user or `-app` Secret, only the ca/replication/server
      certificates, because the operator was never asked to create one.

## Storage

- [x] Storage expansion — needs a class that allows it, so the lab runs on the CSI hostpath driver
      (`server/csi.go`) with k3s's own `local-path` next to it for contrast: one says
      `allowVolumeExpansion: true`, the other says nothing, which means false. Patching
      `spec.storage.size` 1Gi → 2Gi moved the claim's *request* at once and its
      `status.capacity` about a minute later, with the PVC's events recording all four
      handoffs — ExternalExpanding → Resizing → FileSystemResizeRequired →
      FileSystemResizeSuccessful — and the Pod never restarted, on the same volume throughout.
      Both walls are real refusals: the operator's webhook says `can't shrink existing storage
      from 2Gi to 1Gi`, and the API server says `only dynamically provisioned pvc can be
      resized and the storageclass that provisions the pvc must support resize`.
- [x] Dedicated PG_WAL persistent volume — `spec.walStorage` can be added to a *running*
      cluster: one `<instance>-wal` claim each, a roll of about 45 seconds, and `pg_wal` inside
      the data directory becomes a symlink to `/var/lib/postgresql/wal/pg_wal`. Two findings
      make the lab: the WAL claims land on the **default** StorageClass unless one is named, so
      it is easy to put the log on slower storage than the data; and the field is a one-way
      door — `walStorage cannot be disabled once configured`.

## Maintenance

- [x] Node Drain with maintenance window — the operator maintains **two** PodDisruptionBudgets,
      one over the replicas (one disruption allowed) and one over the primary (none). Draining a
      replica's node evicts it and then strands it, because a `local-path` volume cannot follow:
      `1 node(s) were unschedulable, 2 node(s) didn't match PersistentVolume's node affinity`.
      The drain also deletes the bare `psql-client` Pod for good, warning about Pods that
      declare no controller. `spec.nodeMaintenanceWindow` with `reusePVC: false` then has the
      operator write that copy off and rebuild the instance elsewhere in about a minute — and
      the API server answers the patch with `Consider using .spec.enablePDB instead of the node
      maintenance window feature`.
- [x] Node Drain with single-instance cluster with/without Pod Disruption Budgets — one instance
      means one budget with zero allowed disruptions, so the drain cordons the node and then
      never finishes: `Cannot evict pod as it would violate the pod's disruption budget`, retried
      until the timeout, with the database serving throughout. `spec.enablePDB: false` deletes
      the budgets and the same drain completes in seconds — into the outage the budget existed
      to prevent: the instance Pending, the read-write Service with no endpoints, and a client
      getting `Connection refused` until the node is uncordoned.

## Hibernation

- [x] Declarative hibernation / rehydration — the annotation `cnpg.io/hibernation`, applied
      directly rather than through the plugin, so a manifest can carry it. Pods gone in about ten
      seconds, all claims kept, and the trap worth teaching: `kubectl get cluster` still reports
      "Cluster in healthy state" with a blank READY column, so the only honest signal is the
      `cnpg.io/hibernation` condition (True/Hibernated) — which is *removed* rather than set to
      False on waking. The Services survive with no endpoints, so a client gets `Connection
      refused` rather than a name that does not resolve; the spec stays editable while it sleeps
      (max_connections patched to 200 with no Pods running, in force on wake); and waking took
      about 30 seconds onto volumes older than the Pods using them.

## Volume snapshots

- [x] Backup/restore for cold and online snapshots — one boolean, `spec.online`. Online (the
      default) keeps the instance serving and stores PostgreSQL's own backup label on the
      VolumeSnapshot as `cnpg.io/backupLabelFile`; offline fences the instance for the duration
      — `cnpg.io/fencedInstances` names it while the backup runs — and produces a snapshot with
      no label at all. The difference is durable and unarguable in the snapshot's recorded
      control file: `Database cluster state: in production` against `shut down`. One caution
      baked into the lab: `.status.online` reported true for *both* backups in 1.30, so the mode
      has to be read from `.spec.online`. Restoring the cold one brought a cluster up healthy in
      ~37 seconds with no recovery at all.
- [x] Point-in-time recovery (PITR) for cold and online snapshots — the snapshot is a floor,
      not a destination. Paired with a WAL archive through `bootstrap.recovery.source` and an
      `externalClusters` entry, `recoveryTarget.targetTime` decides where replay stops. Measured
      with a hot and a cold snapshot taken back to back (the second waited `pending` while the
      first ran) and two rows written four seconds apart around a recorded moment: both recovered
      clusters came up healthy in ~40s carrying `first` and not `second`, and each claim's
      `spec.dataSource` named the snapshot it was built from. Hot and cold reach the same point —
      the mode decides what happens when the copy is opened, the archive decides how far forward
      it can go. Take the target time from `SELECT now()`, not from a node's clock.
- [x] Backups via plugin for cold and online snapshots — `kubectl cnpg backup` builds an ordinary
      Backup out of its flags and applies it; there is no second mechanism. With no flags it
      leaves `spec.online` unset (the listing reads `<none>`) so the Cluster decides, and names
      the object `<cluster>-<timestamp>`. `--online=false --backup-name cold-by-plugin` fenced the
      instance for ~31s — `cnpg.io/fencedInstances` naming it throughout — and left a snapshot
      whose recorded control file reads `shut down` with no backup label. `kubectl cnpg status`
      and `status.lastSuccessfulBackupByMethod` are where the cluster's own account lives.
- [x] Declarative backups for cold and online snapshots — a ScheduledBackup is a Backup with a
      clock: six-field cron (seconds first), `immediate`, `suspend`, and the same `online` choice
      applied on every firing. `status.{lastCheckTime,lastScheduleTime,nextScheduleTime}` are what
      monitoring should watch. The lab's spine is retention, measured twice: with the default
      `snapshotOwnerReference: none` a snapshot has no ownerReferences and outlives the Backup
      that made it; set to `backup` the next snapshot carries `Backup/<name>` and is
      garbage-collected with it. Nothing prunes VolumeSnapshots — Barman retention applies to
      object storage, not to CSI snapshots. One more thing the lab records because a real run
      produced it: two schedules both firing at second zero contend, and an online run landing
      while the cold one has the instance fenced fails with `while ensuring target pod is
      healthy: no status found for target pod`.

## Managed Roles

- [x] Creation and update of managed roles — `spec.managed.roles` with a `passwordSecret` creates
      the role within seconds, applies its `COMMENT ON ROLE`, and reports it under
      `byStatus.reconciled`. Two edges shape the lab, both measured over several minutes: an
      `ALTER ROLE analyst NOLOGIN` made outside the spec is **not** reverted and the status goes
      on saying `reconciled` — applied on change, not enforced continuously — until any later
      spec change re-applies the whole entry and restores LOGIN. And `ensure: absent` on a role
      that owns objects is refused into `cannotReconcile: could not perform DELETE on role
      analyst: 2 objects in database app` with a status of `pending-reconciliation`, on a cluster
      that stays perfectly healthy.
- [x] Password maintenance using Kubernetes secrets — the finding the lab is built on: editing the
      password inside a managed role's Secret changed **nothing** for six minutes, because
      CloudNativePG only watches Secrets labelled `cnpg.io/reload: "true"` — which its own
      generated Secrets carry and a hand-made one does not. Labelling it applied the rotation in
      ~8 seconds (`passwordStatus.resourceVersion` 1351 → 2154, transaction 757 → 770), and every
      later edit landed just as fast. The one-line diagnosis is that resourceVersion against the
      Secret's own. An `ALTER ROLE ... PASSWORD` in SQL is not reverted and the role still reads
      `reconciled`; touching the Secret (an annotation, same password) had the operator overwrite
      it on the next poll. `validUntil` in the past gives `FATAL: password authentication failed`
      — PostgreSQL never says "expired" — and `disablePassword: true` is refused alongside a
      `passwordSecret` ("This role both sets and disables a password") but on its own leaves
      `rolpassword` NULL, `rolvaliduntil` back to `infinity` and `passwordStatus` carrying only a
      transaction id.

## Tablespaces

- [x] Declarative creation of tablespaces — one entry under `spec.tablespaces` becomes **one PVC
      per instance**, `<instance>-tbs-<name>`, labelled `cnpg.io/pvcRole: PG_TABLESPACE` and
      `cnpg.io/tablespaceName`; three instances and two tablespaces is six volumes. Attaching them
      rolls the cluster (~50s) while `status.tablespacesStatus` goes pending → reconciled. The
      implementation is visible: `pg_tablespace_location` reads
      `/var/lib/postgresql/tablespaces/<name>/data` and `pg_tblspc/<oid>` is a symlink to it. The
      webhook fills in `owner` (the app user), `temporary: false` and `resizeInUseVolumes: true`.
      Removing one is refused outright — `no tablespace can be deleted once created`. A trap found
      while building it and deliberately kept out of the lab: growing a tablespace on a class that
      cannot expand is *accepted* by the webhook and then wedges the reconcile loop, leaving later
      tablespaces `pending` behind a failing PVC resize.
- [x] Declarative creation of temporary tablespaces — `temporary: true` also writes the name into
      `temp_tablespaces`, on **every** instance. A temp table's `reltablespace` reads `scratch`; a
      64kB-`work_mem` sort over 300k rows grew the tablespace to **99M** mid-query and took
      `pg_stat_database` from `1 / 2734 kB` to `3 / 107 MB`. The evidence is emptiness, not
      absence: `base/pgsql_tmp` exists (PostgreSQL makes it at startup) and stayed at 4.0K with
      zero entries while the files piled up in a `pgsql_tmp` inside the tablespace. A read-only
      sort through the -ro Service spilled on the standby that served it — 2 files / 22 MB there,
      nothing on the other — since stats and storage are both per-instance.
- [x] Backup / recovery from object storage — the backup contains the tablespaces and the recovery
      manifest has to declare them. Two failures were measured and both are in the lab. Restoring
      straight after a plugin backup failed with `object storage or file not found
      000000010000000000000008: WAL not found`, because the segment `status.beginWal` names was
      still open on an idle database — `pg_switch_wal()` is the fix. And recovering into a cluster
      with no `tablespaces` block failed with `Barman cloud restore exception: [Errno 30]
      Read-only file system: '/var/lib/postgresql/tablespaces'`, retried forever, the Cluster stuck
      at `Setting up primary` and the reason only in `<cluster>-1-full-recovery-…` Job Pods that
      keep being replaced. Declaring the tablespace brought it up healthy in ~40s with its own
      claim and all 500 rows still inside the tablespace.
- [x] Backup / recovery from volume snapshots — one snapshot **per volume**: `daily-snapshot` from
      the data claim and `daily-snapshot-tbs-reporting` from the tablespace's, the latter labelled
      `cnpg.io/tablespaceName`. Recovery is a hand-written map,
      `volumeSnapshots.tablespaceStorage`, keyed by tablespace name, and leaving it out fails
      *silently*: one Pending claim, no Pod, no events, an empty phase, and the reason only in the
      operator log — `cannot create primary instance PVCs: missing StorageSource for tablespace
      reporting PVC`. Mapped properly it is healthy in ~36s with each claim's `spec.dataSource`
      naming its snapshot. **The naming trap that cost the most time: a cluster whose name contains
      `-tbs-`** (here `pg-tbs-restored`) has its own data claim read as a tablespace's, and the
      instance then rolls every twenty seconds forever — "original and target PodSpec differ in
      volumes: element tbs-pgdata has been removed" — with the data correctly restored and the
      cluster never ready. Renaming it, nothing else changed, fixed it.

## Declarative databases

- [x] Declarative creation of databases with default (retain) reclaim policy — a `Database` object
      created the database in ~12s and reported `applied: true` in its own status; the webhook adds
      `ensure: present`, `databaseReclaimPolicy: retain` and the finalizer
      `cnpg.io/deleteDatabase`. A second object naming the same PostgreSQL database is accepted by
      the API and refused by the operator in *its* status — `"reporting" is already managed by
      object "reporting-db"` — leaving the first untouched. Deleting a retain object left the
      database and its rows exactly where they were, and re-applying the identical manifest
      **adopted** the existing database rather than failing or recreating it.
- [x] Declarative creation of databases with delete reclaim policy — `delete` drops the database
      when the object is deleted, and PostgreSQL will not drop a database with a session on it: the
      deletion blocked with a `deletionTimestamp` set, the finalizer still attached, `applied: true`
      unchanged, **no event, no message and no operator log line**, and the database still present.
      A plain `kubectl delete` simply never returns. The moment the session ended, the object went
      and the database was dropped. Contrasted with `ensure: absent`, which dropped a database
      whose policy said `retain` — the policy was never consulted, because the object was never
      deleted.

## Major version upgrade

- [x] Upgrade to the latest major version — declarative, through `spec.imageName`, and a different
      operation from a minor bump because the operator compares the new major against
      `status.pgDataImageInfo` (the image that last ran on the data directory). A 3-instance
      PostgreSQL 17.11 cluster reached 18.4 in about two minutes: the phase read `Upgrading Postgres
      major version` while a `pg-cluster-1-major-upgrade` Job ran for ~31s, then both replicas were
      **rebuilt from scratch** by ordinary `<instance>-join` Jobs. How pg_upgrade gets two
      installations is the mechanism worth teaching — the Job's Pod is init `bootstrap-controller`
      (operator image), init `prepare` running the **old** image (its log: *Copying the PostgreSQL
      installation to the destination /controller/old*, then `/usr/lib/postgresql/17/{bin,lib}`,
      `/usr/share/postgresql/17` and a `bindir.txt`), and main `major-upgrade` on the **new** image.
      So the old image has to still be pullable. The primary keeps its PVC and the replicas get new
      ones, which the claim timestamps show plainly. Three findings close the lab: going back is
      refused at admission — `spec.imageName: Invalid value: "17": can't downgrade from major 18 to
      17` — with no copy of the old cluster left on the volume; optimizer statistics do **not**
      survive (`reltuples` reads `-1` and `pg_stats` is empty until `ANALYZE`, after which 50 and 2);
      and the upgraded cluster reports `data_checksums off` while one freshly bootstrapped from the
      *same* 18 image reports `on`, because pg_upgrade carries 17's initdb decisions forward.

## Content pipeline

This app no longer simulates CNPG — `server/` is a real Go backend that provisions an
actual k3d + MetalLB + SeaweedFS + CloudNativePG environment per attempt, and grading
(`server/check.go`) runs real `kubectl`/`psql` against it. The pipeline below is how the
71 built labs got their real command transcripts, object names and timings, and how each
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
