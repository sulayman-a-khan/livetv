/**
 * SoluPlay — category-based health-check schedule
 * ===============================================
 * The health cron is split into category batches so one serverless run only ever
 * probes a slice of the curated catalogue, and the six-hourly cadence spreads
 * across the day. This file is the ONE place those groups and times are defined:
 * `/api/admin/scheduler/[task]` dispatches on `task`, and `vercel.json` fires each
 * batch at the UTC times listed here.
 *
 * Every batch checks PINNED channels only (see `lib/autoHealthChecker.ts`), and
 * the two passes of a cycle are disjoint — a channel's category belongs to
 * exactly one batch per cycle, so nothing is checked twice in the same cycle.
 *
 * Alongside the batches, `DELIVERY_RECHECK_TASK` fires once in every UTC hour to
 * re-probe the links the delivery rule hid. Hobby accepts nothing but daily
 * expressions, so that cadence is 24 separate lines rather than one `0 * * * *`.
 */

import { CHANNEL_CATEGORIES, type ChannelCategory } from "./categories";

export interface HealthBatch {
  /** Static path segment: `/api/admin/scheduler/<task>`. */
  task: string;
  label: string;
  /** Categories this pass probes, across pinned channels only. */
  categories: readonly ChannelCategory[];
  /** UTC times this batch fires, as `minute hour` Vercel cron fields. */
  crons: readonly string[];
  /**
   * The daily sweep: covers all five categories and is the only pass allowed to
   * run the whole-catalogue maintenance (merge, dead-link purge, re-ranking).
   */
  sweep: boolean;
}

/**
 * Cycles (UTC):
 *   09:00 + 09:30 → Bangla/Pakistani, then Sports/Indian/Documentary
 *   15:00 + 15:30 → Bangla/Indian, then Sports/Pakistani/Documentary
 *   21:00 + 21:30 → Bangla/Pakistani, then Sports/Indian/Documentary
 *   03:00         → all five, plus the maintenance sweep
 *
 * Each half-hour pair covers all five categories exactly once, so a channel is
 * never intentionally probed twice in the same cycle.
 */
export const HEALTH_BATCHES = [
  {
    task: "health-bangla-pakistani",
    label: "Bangla + Pakistani (pinned)",
    categories: ["Bangla", "Pakistani"],
    crons: ["0 9 * * *", "0 21 * * *"],
    sweep: false,
  },
  {
    task: "health-sports-indian-documentary",
    label: "Sports + Indian + Documentary (pinned)",
    categories: ["Sports", "Indian", "Documentary"],
    crons: ["30 9 * * *", "30 21 * * *"],
    sweep: false,
  },
  {
    task: "health-bangla-indian",
    label: "Bangla + Indian (pinned)",
    categories: ["Bangla", "Indian"],
    crons: ["0 15 * * *"],
    sweep: false,
  },
  {
    task: "health-sports-pakistani-documentary",
    label: "Sports + Pakistani + Documentary (pinned)",
    categories: ["Sports", "Pakistani", "Documentary"],
    crons: ["30 15 * * *"],
    sweep: false,
  },
  {
    task: "health-all",
    label: "Every pinned channel (daily sweep + maintenance)",
    categories: [...CHANNEL_CATEGORIES],
    crons: ["0 3 * * *"],
    sweep: true,
  },
] as const satisfies readonly HealthBatch[];

export type HealthBatchTask = (typeof HEALTH_BATCHES)[number]["task"];

/** One entry of `HEALTH_BATCHES`, with its literal `task` and `categories`. */
export type HealthBatchDefinition = (typeof HEALTH_BATCHES)[number];

const BATCH_BY_TASK = new Map<string, HealthBatchDefinition>(
  HEALTH_BATCHES.map((b) => [b.task, b] as const)
);

export function getHealthBatch(task: string): HealthBatchDefinition | undefined {
  return BATCH_BY_TASK.get((task || "").trim());
}

/** Categories a scheduled task should probe; `null` means every pinned channel. */
export function resolveBatchCategories(task: string): ChannelCategory[] | null {
  const batch = getHealthBatch(task);
  if (!batch) return null;
  return [...batch.categories];
}

/**
 * The delivery re-check (`lib/autoHealthChecker.ts` → `runDeliveryRecheck`):
 * probes the links the 10-second delivery rule hid, plus any still holding an
 * unconfirmed miss, and shows them again as soon as one hands over media. Cheap
 * enough to run every hour.
 */
export const DELIVERY_RECHECK_TASK = "health-recheck";

/**
 * Hourly on paper, 24 daily expressions in practice: Vercel's Hobby plan accepts
 * only one cron per day per job, and an expression like `0 * * * *` fails the
 * deployment. Each line below fires once a day at its own UTC hour, so together
 * they give the re-check its hourly cadence. They sit at minute 15 to land clear
 * of the batch passes at :00 and :30 — a re-check and a batch fired in the same
 * minute would have one of them lose the health lock and do nothing.
 */
export const DELIVERY_RECHECK_CRONS: readonly string[] = Array.from(
  { length: 24 },
  (_, hour) => `15 ${hour} * * *`
);

/** Cron lines this file expects to find in `vercel.json`, for verification. */
export function expectedHealthCrons(): { path: string; schedule: string }[] {
  return [
    ...HEALTH_BATCHES.flatMap((batch) =>
      batch.crons.map((schedule) => ({ path: `/api/admin/scheduler/${batch.task}`, schedule }))
    ),
    ...DELIVERY_RECHECK_CRONS.map((schedule) => ({
      path: `/api/admin/scheduler/${DELIVERY_RECHECK_TASK}`,
      schedule,
    })),
  ];
}
