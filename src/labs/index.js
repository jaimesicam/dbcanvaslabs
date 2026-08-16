import catalogJson from './catalog.json'
import { cnpgOperatorInstall } from './cnpg-operator-install.js'
import { cnpgClusterCreation } from './cnpg-cluster-creation.js'
import { cnpgPersistentVolume } from './cnpg-persistent-volume.js'
import { cnpgServiceConnectivity } from './cnpg-service-connectivity.js'
import { cnpgClientCertificates } from './cnpg-client-certificates.js'
import { cnpgServerCertificates } from './cnpg-server-certificates.js'
import { cnpgPgBouncer } from './cnpg-pgbouncer.js'
import { cnpgFailover } from './cnpg-failover.js'
import { cnpgSwitchover } from './cnpg-switchover.js'
import { cnpgFailoverEndpointTime } from './cnpg-failover-endpoint-time.js'
import { cnpgSwitchoverEndpointTime } from './cnpg-switchover-endpoint-time.js'
import { cnpgDegradedRecovery } from './cnpg-degraded-recovery.js'
import { cnpgPVCDeletion } from './cnpg-pvc-deletion.js'
import { cnpgCorruptedPVC } from './cnpg-corrupted-pvc.js'
import { cnpgBarmanBackup } from './cnpg-barman-backup.js'
import { cnpgVolumeSnapshots } from './cnpg-volume-snapshots.js'
import { cnpgBarmanRestore } from './cnpg-barman-restore.js'
import { cnpgPITR } from './cnpg-pitr.js'
import { cnpgWALRestore } from './cnpg-wal-restore.js'
import { cnpgOperatorEviction } from './cnpg-operator-eviction.js'
import { cnpgOperatorUpgrade } from './cnpg-operator-upgrade.js'
import { cnpgOperatorHA } from './cnpg-operator-ha.js'
import { cnpgMetrics } from './cnpg-metrics.js'
import { cnpgPgBouncerMetrics } from './cnpg-pgbouncer-metrics.js'
import { cnpgJSONLogs } from './cnpg-json-logs.js'
import { cnpgReplicationSlots } from './cnpg-replication-slots.js'
import { cnpgSynchronousReplication } from './cnpg-synchronous-replication.js'
import { cnpgClusterScaling } from './cnpg-cluster-scaling.js'
import { cnpgReplicaCluster } from './cnpg-replica-cluster.js'
import { cnpgLogicalReplication } from './cnpg-logical-replication.js'
import { cnpgFencing } from './cnpg-fencing.js'
import { cnpgHibernation } from './cnpg-hibernation.js'
import { cnpgConfigChanges } from './cnpg-config-changes.js'
import { cnpgRollingUpdate } from './cnpg-rolling-update.js'
import { cnpgImageCatalog } from './cnpg-image-catalog.js'
import { cnpgHotStandbyParams } from './cnpg-hot-standby-params.js'
import { cnpgReplicaFromBackup } from './cnpg-replica-from-backup.js'
import { cnpgReplicaFromSnapshot } from './cnpg-replica-from-snapshot.js'
import { cnpgInitdb } from './cnpg-initdb.js'
import { cnpgTaintsTolerations } from './cnpg-taints-tolerations.js'
import { cnpgOperatorDeployment } from './cnpg-operator-deployment.js'
import { cnpgOperatorConfigMap } from './cnpg-operator-configmap.js'
import { cnpgOperatorPodDeletion } from './cnpg-operator-pod-deletion.js'

/** Every lab this app has is playable end to end — there is no browse-only content. */
export const PLAYABLE = {
  [cnpgOperatorInstall.id]: cnpgOperatorInstall,
  [cnpgClusterCreation.id]: cnpgClusterCreation,
  [cnpgPersistentVolume.id]: cnpgPersistentVolume,
  [cnpgServiceConnectivity.id]: cnpgServiceConnectivity,
  [cnpgClientCertificates.id]: cnpgClientCertificates,
  [cnpgServerCertificates.id]: cnpgServerCertificates,
  [cnpgPgBouncer.id]: cnpgPgBouncer,
  [cnpgFailover.id]: cnpgFailover,
  [cnpgSwitchover.id]: cnpgSwitchover,
  [cnpgFailoverEndpointTime.id]: cnpgFailoverEndpointTime,
  [cnpgSwitchoverEndpointTime.id]: cnpgSwitchoverEndpointTime,
  [cnpgDegradedRecovery.id]: cnpgDegradedRecovery,
  [cnpgPVCDeletion.id]: cnpgPVCDeletion,
  [cnpgCorruptedPVC.id]: cnpgCorruptedPVC,
  [cnpgBarmanBackup.id]: cnpgBarmanBackup,
  [cnpgVolumeSnapshots.id]: cnpgVolumeSnapshots,
  [cnpgBarmanRestore.id]: cnpgBarmanRestore,
  [cnpgPITR.id]: cnpgPITR,
  [cnpgWALRestore.id]: cnpgWALRestore,
  [cnpgOperatorEviction.id]: cnpgOperatorEviction,
  [cnpgOperatorUpgrade.id]: cnpgOperatorUpgrade,
  [cnpgOperatorHA.id]: cnpgOperatorHA,
  [cnpgMetrics.id]: cnpgMetrics,
  [cnpgPgBouncerMetrics.id]: cnpgPgBouncerMetrics,
  [cnpgJSONLogs.id]: cnpgJSONLogs,
  [cnpgReplicationSlots.id]: cnpgReplicationSlots,
  [cnpgSynchronousReplication.id]: cnpgSynchronousReplication,
  [cnpgClusterScaling.id]: cnpgClusterScaling,
  [cnpgReplicaCluster.id]: cnpgReplicaCluster,
  [cnpgLogicalReplication.id]: cnpgLogicalReplication,
  [cnpgFencing.id]: cnpgFencing,
  [cnpgHibernation.id]: cnpgHibernation,
  [cnpgConfigChanges.id]: cnpgConfigChanges,
  [cnpgRollingUpdate.id]: cnpgRollingUpdate,
  [cnpgImageCatalog.id]: cnpgImageCatalog,
  [cnpgHotStandbyParams.id]: cnpgHotStandbyParams,
  [cnpgReplicaFromBackup.id]: cnpgReplicaFromBackup,
  [cnpgReplicaFromSnapshot.id]: cnpgReplicaFromSnapshot,
  [cnpgInitdb.id]: cnpgInitdb,
  [cnpgTaintsTolerations.id]: cnpgTaintsTolerations,
  [cnpgOperatorDeployment.id]: cnpgOperatorDeployment,
  [cnpgOperatorConfigMap.id]: cnpgOperatorConfigMap,
  [cnpgOperatorPodDeletion.id]: cnpgOperatorPodDeletion,
}

const TTL_LABEL = { '2h': '2 hours', '3h': '3 hours', '4h': '4 hours', '8h': '8 hours', '24h': '24 hours' }
const TTL_MS = { '2h': 7200e3, '3h': 10800e3, '4h': 14400e3, '8h': 28800e3, '24h': 86400e3 }

export const CATALOG = catalogJson.map((lab) => {
  const play = PLAYABLE[lab.id]
  return {
    ...lab,
    playable: !!play,
    taskCount: play ? play.tasks.length : lab.steps.length,
    timeLimitLabel: TTL_LABEL[lab.timeLimit] || lab.timeLimit,
    timeLimitMs: TTL_MS[lab.timeLimit] || 7200e3,
  }
})

export const BY_ID = Object.fromEntries(CATALOG.map((l) => [l.id, l]))

export function getLab(id) {
  return BY_ID[id] ?? null
}

export function getPlayable(id) {
  return PLAYABLE[id] ?? null
}

/** Total task time a lab budgets, in ms — used on the detail page. */
export function taskBudgetMs(id) {
  const p = PLAYABLE[id]
  return p ? p.tasks.reduce((n, t) => n + t.limitSec, 0) * 1000 : 0
}

/**
 * Database → Technology → Category, preserving catalog order rather than
 * alphabetising, exactly as DBCanvas groups its own catalog.
 */
export function groupCatalog(labs) {
  const dbs = []
  const index = new Map()
  for (const lab of labs) {
    let db = index.get(lab.database)
    if (!db) {
      db = { name: lab.database, count: 0, techs: [], _t: new Map() }
      index.set(lab.database, db)
      dbs.push(db)
    }
    db.count++
    let tech = db._t.get(lab.technology)
    if (!tech) {
      tech = { name: lab.technology, count: 0, cats: [], _c: new Map() }
      db._t.set(lab.technology, tech)
      db.techs.push(tech)
    }
    tech.count++
    let cat = tech._c.get(lab.category)
    if (!cat) {
      cat = { name: lab.category, labs: [] }
      tech._c.set(lab.category, cat)
      tech.cats.push(cat)
    }
    cat.labs.push(lab)
  }
  return dbs
}

export const DIFFICULTIES = ['Beginner', 'Intermediate', 'Advanced']

export const DIFFICULTY_TONE = {
  Beginner: 'success',
  Intermediate: 'warning',
  Advanced: 'danger',
}

/** Engine accent, used for catalog chips and the topology diagram. */
export const DATABASE_TONE = {
  PostgreSQL: 'primary',
}

export function searchLabs(labs, query, filters = {}) {
  const q = query.trim().toLowerCase()
  return labs.filter((l) => {
    if (filters.difficulty?.length && !filters.difficulty.includes(l.difficulty)) return false
    if (filters.database?.length && !filters.database.includes(l.database)) return false
    if (filters.playableOnly && !l.playable) return false
    if (!q) return true
    return [l.title, l.description, l.database, l.technology, l.category]
      .join(' ')
      .toLowerCase()
      .includes(q)
  })
}
