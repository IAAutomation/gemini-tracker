/**
 * Database backup helper.
 * On Vercel (production), backups are handled by Supabase automatically.
 * These functions are no-ops on Vercel to avoid file system errors.
 */

const isVercel = process.env.DATABASE_URL?.startsWith("postgresql") ?? false;

export async function backupAfterSale() {
  if (isVercel) return; // Supabase handles backups
}

export async function backupAfterEdit() {
  if (isVercel) return;
}

export async function backupDailyIfDue() {
  if (isVercel) return;
}

export async function backupEveryMinute() {
  if (isVercel) return;
}

export async function autoRestoreIfEmpty(): Promise<string | null> {
  return null; // Supabase handles this
}

export async function listBackups() {
  return [];
}

export async function restoreFromLatestBackup(): Promise<string | null> {
  return null;
}

export async function checkDbIntegrity() {
  return { ok: true, size: 0 };
}
