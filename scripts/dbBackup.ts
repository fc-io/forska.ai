import {access, copyFile, mkdir} from 'node:fs/promises'
import {basename, join} from 'node:path'

import {type AppDatabaseSnapshot, getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {createDuckdbSnapshotForCli} from '../src/server/utils/duckdbScriptAccess.ts'

type BackupArtifact = {backupPath: string; backupWalPath: string | null}

const backupDirectory = 'backups'

const log = (message: string) => {
  console.log(`[dbBackup] ${message}`)
}

const getBackupBaseName = (databasePath: string) => {
  const fileName = basename(databasePath === ':memory:' ? 'duckdb' : databasePath)
  return fileName.endsWith('.duckdb') ? fileName.slice(0, -'.duckdb'.length) : fileName
}

const getBackupStamp = (createdAt: string) => {
  return createdAt.replaceAll(':', '-').replaceAll(' ', '_')
}

const getFileExists = async (filePath: string) => {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

const getBackupArtifactPaths = (databasePath: string, snapshot: AppDatabaseSnapshot) => {
  const backupName = `${getBackupBaseName(databasePath)}_${getBackupStamp(snapshot.createdAt)}.duckdb`
  const backupPath = join(backupDirectory, backupName)
  return {backupPath, backupWalPath: `${backupPath}.source.wal`}
}

const copySnapshotToBackup = async (databasePath: string, snapshot: AppDatabaseSnapshot): Promise<BackupArtifact> => {
  const {backupPath, backupWalPath} = getBackupArtifactPaths(databasePath, snapshot)
  const snapshotWalPath = `${snapshot.snapshotPath}.wal`
  const hasWal = await getFileExists(snapshotWalPath)

  await copyFile(snapshot.snapshotPath, backupPath)

  if (!hasWal) {
    return {backupPath, backupWalPath: null}
  }

  await copyFile(snapshotWalPath, backupWalPath)
  return {backupPath, backupWalPath}
}

const deleteSnapshot = async (snapshot: AppDatabaseSnapshot) => {
  try {
    await getAppDatabaseService().deleteSnapshot(snapshot.snapshotPath)
  } catch (error) {
    console.error('[dbBackup] failed to delete snapshot', {error, snapshotPath: snapshot.snapshotPath})
  }
}

const runDuckdbBackup = async () => {
  const runtimeConfig = getAppDatabaseService().getRuntimeConfig()

  log(`Resolved DuckDB path: ${runtimeConfig.databasePath}`)
  await mkdir(backupDirectory, {recursive: true})

  const snapshot = await createDuckdbSnapshotForCli()

  try {
    const artifact = await copySnapshotToBackup(runtimeConfig.databasePath, snapshot)

    log(`Backup created: ${artifact.backupPath}`)

    if (artifact.backupWalPath !== null) {
      log(`Backup WAL created: ${artifact.backupWalPath}`)
      log('Backup WAL is a recovery sidecar; restore it beside the backup as <backup>.wal before first open only when WAL replay is required.')
    }
  } finally {
    await deleteSnapshot(snapshot)
  }
}

if (import.meta.main) {
  await runDuckdbBackup()
}
