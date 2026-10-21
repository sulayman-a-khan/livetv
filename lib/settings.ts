import { connectToDatabase } from "@/lib/db";
import Setting from "@/models/Setting";

const SCHEDULER_HEARTBEAT_KEY = "schedulerHeartbeat";

export interface SchedulerHeartbeat {
  at: string;
  task: string;
  /** Vercel's own scheduler sent this run, rather than an admin secret header. */
  scheduled: boolean;
}

/**
 * Vercel drops a cron invocation without a trace: a 3xx from Deployment
 * Protection ends the job (cron never follows redirects) and a missing
 * `CRON_SECRET` gets a 401, neither of which reaches the cron logs. So a
 * scheduler that has never arrived looks exactly like a health rule that does
 * not work. One document stamped per accepted run is the only in-app proof.
 */
export async function recordSchedulerHeartbeat(task: string, scheduled: boolean): Promise<void> {
  const heartbeat: SchedulerHeartbeat = { at: new Date().toISOString(), task, scheduled };
  try {
    const conn = await connectToDatabase();
    if (!conn) return;
    await Setting.updateOne(
      { key: SCHEDULER_HEARTBEAT_KEY },
      {
        $set: {
          key: SCHEDULER_HEARTBEAT_KEY,
          value: JSON.stringify(heartbeat),
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );
  } catch (err) {
    console.warn("[settings] recordSchedulerHeartbeat error:", err);
  }
}
