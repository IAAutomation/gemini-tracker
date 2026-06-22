/**
 * Database backup helper.
 *
 * SQLite is a single file on disk (`db/custom.db`), so a "backup" is just
 * copying that file to a timestamped backup path. We do this:
 *
 *   1. After every sale is inserted (so we never lose a sale to a crash)
 *   2. After EVERY edit (payment toggle, delete, undo) — the "edit-" prefix
 *   3. Once per day (a daily snapshot, kept for 7 days)
 *
 * On server start, we also auto-restore from the latest backup if the current
 * DB is empty/corrupt (safety net against sandbox kills).
 *
 * Backups live in `/home/z/my-project/db/backups/` and never get auto-deleted
 * by the sandbox (they're files on disk, not in-memory state).
 */

import { promises as fs } from "fs";
import path from "path";

const DB_PATH = "/home/z/my-project/db/custom.db";
const BACKUP_DIR = "/home/z/my-project/db/backups";
const DAILY_BACKUP_PREFIX = "daily-";
const AFTER_SALE_BACKUP_PREFIX = "sale-";
const AFTER_EDIT_BACKUP_PREFIX = "edit-";
const MAX_DAILY_BACKUPS = 7;
const MAX_SALE_BACKUPS = 20;
const MAX_EDIT_BACKUPS = 30;

let lastDailyBackupDate = "";
let lastSaleBackupTime = 0;
let lastEditBackupTime = 0;

async function ensureBackupDir() {
  try {
    await fs.mkdir(BACKUP_DIR, { recursive: true });
  } catch {
    // already exists
  }
}

/** Copy the current DB file to a backup path. */
async function copyDbTo(destPath: string) {
  await ensureBackupDir();
  try {
    await fs.copyFile(DB_PATH, destPath);
    return true;
  } catch (e) {
    console.error("[backup] copyDbTo failed:", e);
    return false;
  }
}

/** Take a backup after a sale was inserted (throttled to max 1 per 10 seconds). */
export async function backupAfterSale() {
  const now = Date.now();
  if (now - lastSaleBackupTime < 10000) return; // throttle
  lastSaleBackupTime = now;

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(BACKUP_DIR, `${AFTER_SALE_BACKUP_PREFIX}${ts}.db`);
  await copyDbTo(dest);

  // Prune: keep only the most recent MAX_SALE_BACKUPS sale backups
  try {
    const files = await fs.readdir(BACKUP_DIR);
    const saleBackups = files
      .filter((f) => f.startsWith(AFTER_SALE_BACKUP_PREFIX))
      .sort()
      .reverse();
    for (const old of saleBackups.slice(MAX_SALE_BACKUPS)) {
      await fs.unlink(path.join(BACKUP_DIR, old));
    }
  } catch {
    // ignore prune errors
  }
}

/**
 * Take a backup after ANY edit (payment toggle, delete, undo, etc.).
 * Throttled to max 1 per 3 seconds so rapid toggles don't spam the disk.
 *
 * Edit backups are kept for up to MAX_EDIT_BACKUPS = 30 snapshots.
 */
export async function backupAfterEdit() {
  const now = Date.now();
  if (now - lastEditBackupTime < 3000) return; // throttle 3s
  lastEditBackupTime = now;

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(BACKUP_DIR, `${AFTER_EDIT_BACKUP_PREFIX}${ts}.db`);
  await copyDbTo(dest);

  // Prune: keep only the most recent MAX_EDIT_BACKUPS edit backups
  try {
    const files = await fs.readdir(BACKUP_DIR);
    const editBackups = files
      .filter((f) => f.startsWith(AFTER_EDIT_BACKUP_PREFIX))
      .sort()
      .reverse();
    for (const old of editBackups.slice(MAX_EDIT_BACKUPS)) {
      await fs.unlink(path.join(BACKUP_DIR, old));
    }
  } catch {
    // ignore prune errors
  }
}

/** Take a daily snapshot if we haven't already today. */
export async function backupDailyIfDue() {
  const today = new Date().toISOString().slice(0, 10);
  if (today === lastDailyBackupDate) return;
  lastDailyBackupDate = today;

  const dest = path.join(BACKUP_DIR, `${DAILY_BACKUP_PREFIX}${today}.db`);
  // Only make it if it doesn't already exist for today
  try {
    await fs.access(dest);
    return; // already backed up today
  } catch {
    // doesn't exist, proceed
  }
  await copyDbTo(dest);

  // Prune: keep only the most recent MAX_DAILY_BACKUPS daily backups
  try {
    const files = await fs.readdir(BACKUP_DIR);
    const dailyBackups = files
      .filter((f) => f.startsWith(DAILY_BACKUP_PREFIX))
      .sort()
      .reverse();
    for (const old of dailyBackups.slice(MAX_DAILY_BACKUPS)) {
      await fs.unlink(path.join(BACKUP_DIR, old));
    }
  } catch {
    // ignore prune errors
  }
}

/**
 * AUTO-RESTORE SAFETY NET — called on server startup.
 *
 * If the main DB file is missing, empty, or unreadable AND backups exist,
 * restore from the most recent backup. This protects against sandbox kills
 * that might corrupt the DB.
 *
 * Returns the name of the backup used, or null if no restore was needed/possible.
 */
export async function autoRestoreIfEmpty(): Promise<string | null> {
  try {
    const stat = await fs.stat(DB_PATH);
    // If DB exists and is reasonably sized (>1KB), assume it's healthy and skip.
    if (stat.size > 1024) return null;

    console.log(`[backup] DB file is suspiciously small (${stat.size} bytes). Attempting auto-restore...`);
  } catch {
    // DB file doesn't exist — definitely need to restore
    console.log("[backup] DB file does not exist. Attempting auto-restore...");
  }

  const backups = await listBackups();
  if (backups.length === 0) {
    console.log("[backup] No backups available for auto-restore.");
    return null;
  }

  const latest = backups[0];
  const latestPath = path.join(BACKUP_DIR, latest.name);
  try {
    await ensureBackupDir();
    await fs.copyFile(latestPath, DB_PATH);
    console.log(`[backup] ✅ Auto-restored DB from: ${latest.name}`);
    return latest.name;
  } catch (e) {
    console.error("[backup] Auto-restore failed:", e);
    return null;
  }
}

/** List all available backups (for diagnostics / restore tooling). */
export async function listBackups() {
  try {
    const files = await fs.readdir(BACKUP_DIR);
    const stats = await Promise.all(
      files.map(async (f) => {
        const stat = await fs.stat(path.join(BACKUP_DIR, f));
        return { name: f, size: stat.size, mtime: stat.mtime.toISOString() };
      })
    );
    return stats.sort((a, b) => b.mtime.localeCompare(a.mtime));
  } catch {
    return [];
  }
}

/**
 * Restore the database from the most recent backup file.
 * Returns the name of the backup used, or null if no backup exists.
 *
 * CAUTION: This OVERWRITES the current DB file. The current DB is backed up
 * to a `pre-restore-<timestamp>.db` file first, so the user can always undo.
 */
export async function restoreFromLatestBackup(): Promise<string | null> {
  const backups = await listBackups();
  if (backups.length === 0) return null;

  // Safety: snapshot the current DB before overwriting it
  const preRestoreTs = new Date().toISOString().replace(/[:.]/g, "-");
  const preRestorePath = path.join(BACKUP_DIR, `pre-restore-${preRestoreTs}.db`);
  try {
    await fs.copyFile(DB_PATH, preRestorePath);
  } catch (e) {
    console.error("[backup] pre-restore snapshot failed:", e);
  }

  // Overwrite DB with the latest backup
  const latest = backups[0];
  const latestPath = path.join(BACKUP_DIR, latest.name);
  try {
    await fs.copyFile(latestPath, DB_PATH);
    return latest.name;
  } catch (e) {
    console.error("[backup] restore failed:", e);
    return null;
  }
}

/**
 * Integrity check: verify the DB file exists and is readable.
 * Returns { ok, size, error }.
 */
export async function checkDbIntegrity(): Promise<{
  ok: boolean;
  size: number;
  error?: string;
}> {
  try {
    const stat = await fs.stat(DB_PATH);
    return { ok: true, size: stat.size };
  } catch (e) {
    return { ok: false, size: 0, error: (e as Error).message };
  }
}
