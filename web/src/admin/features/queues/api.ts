import { api } from "../../../api";

export interface QueueHealthRow {
  name: string;
  created: number;
  active: number;
  retry: number;
  completed: number;
  failed: number;
  oldestCreatedAgeSeconds: number | null;
  retentionMinutes: number | null;
  purgeable: boolean;
}

/** GET /api/admin/queue-health：全队列状态快照 */
export const loadQueueHealth = () =>
  api<{ queues: QueueHealthRow[] }>("/admin/queue-health");

/** POST /api/admin/queue-purge：清理冗余型队列的陈旧 created 积压（服务端白名单强制） */
export const purgeQueue = (queue: string, olderThanMinutes = 30) =>
  api<{ queue: string; purged: number; olderThanMinutes: number }>(
    "/admin/queue-purge",
    { method: "POST", body: { queue, olderThanMinutes } },
  );
