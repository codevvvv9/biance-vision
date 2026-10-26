import { sql } from 'drizzle-orm'
import { getDb } from '../db.js'

export async function writeWorkerHeartbeat(pid = String(process.pid)): Promise<void> {
  const db = getDb()
  if (!db) throw new Error('Worker heartbeat storage unavailable')
  // jsonb_build_object is variadic: PostgreSQL cannot infer an untyped bind parameter.
  await db.execute(sql`INSERT INTO app_settings (key, value)
    VALUES ('observability:worker:heartbeat', jsonb_build_object('at', (extract(epoch FROM now())*1000)::bigint, 'pid', ${pid}::text))
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`)
}
