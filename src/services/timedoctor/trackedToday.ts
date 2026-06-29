import { TimeDoctorClient, type TdWorklogEntry } from "../../integrations/timedoctor/client.js";
import { logger } from "../../utils/logger.js";
import { mapWithConcurrency } from "../../utils/concurrency.js";

/** Aggregated tracking for a single Time Doctor task. */
export interface TrackedTask {
  taskId: string;
  taskName: string;
  projectId: string;
  projectName: string;
  /** Seconds tracked within "today". */
  secondsToday: number;
  /** Seconds tracked over the cumulative span (start-or-90d → today). */
  secondsCumulative: number;
  /** Distinct user ids who tracked time on this task. */
  userIds: string[];
}

/** A minimal worklog datum, for computing per-project windowed totals. */
export interface ProjectWorklogPoint {
  projectId: string;
  /** Entry start time, epoch ms. */
  startMs: number;
  /** Seconds tracked. */
  seconds: number;
}

export interface TrackedTodayResult {
  /** Tasks that had any tracked time today, on the target projects. */
  tasks: TrackedTask[];
  /** Map of projectId → project (account) name, for the target projects. */
  projectNames: Map<string, string>;
  /**
   * All target-project worklog points within the swept window. Lets callers
   * sum per-project totals for any sub-window (billing cycle, current week)
   * without extra API calls.
   */
  projectPoints: ProjectWorklogPoint[];
}

/**
 * Phase 2 core: find every task that had time tracked TODAY on the target
 * accounts' projects, and (for each) sum tracked time over the cumulative span.
 *
 * Strategy (see memory: orion-eod-td-matching):
 *   1. Resolve the target account names → Time Doctor project ids.
 *   2. Scan today's worklog per user to find who tracked time on those
 *      projects, and which tasks. This is the inclusion filter.
 *   3. For only those active users, pull worklog over [cumulativeFrom, today]
 *      and bucket by task, keeping only the target projects.
 */
export async function getTrackedToday(args: {
  td: TimeDoctorClient;
  /** Account names to include (must match TD project names). */
  accountNames: string[];
  /** UTC window for "today". */
  todayFromIso: string;
  todayToIso: string;
  /** UTC start for the cumulative sum (e.g. 90 days ago). */
  cumulativeFromIso: string;
}): Promise<TrackedTodayResult> {
  const { td, accountNames, todayFromIso, todayToIso, cumulativeFromIso } = args;

  // 1. Resolve target project ids by name.
  const allProjects = await td.listProjects();
  const wanted = new Set(accountNames);
  const targetProjects = allProjects.filter((p) => wanted.has(p.name));
  const projectNames = new Map(targetProjects.map((p) => [p.id, p.name]));
  const targetProjectIds = new Set(projectNames.keys());

  const missing = accountNames.filter((n) => !targetProjects.some((p) => p.name === n));
  if (missing.length > 0) {
    logger.warn(`Time Doctor: no project found for accounts: ${missing.join(", ")}`);
  }
  logger.info(
    `Time Doctor: ${targetProjects.length} target projects (${[...projectNames.values()].join(", ")})`,
  );

  // 2. Sweep the FULL cumulative window for ALL users (bounded concurrency),
  //    keeping only entries on the target projects. A single pass gives us both
  //    today's activity (inclusion filter) and accurate cumulative totals
  //    across all contributors — not just whoever tracked today.
  const users = await td.listUsers();
  logger.debug(
    `Time Doctor: sweeping ${users.length} users from ${cumulativeFromIso} to ${todayToIso}`,
  );

  const todayStart = new Date(todayFromIso).getTime();
  const todayEnd = new Date(todayToIso).getTime();

  const todayByTask = new Map<string, TdWorklogEntry[]>();
  const cumulativeByTask = new Map<
    string,
    { seconds: number; projectId: string; userIds: Set<string> }
  >();
  const projectPoints: ProjectWorklogPoint[] = [];

  await mapWithConcurrency(users, 8, async (user) => {
    const entries = await td.getUserWorklog(user.id, cumulativeFromIso, todayToIso);
    for (const e of entries) {
      if (!e.projectId || !targetProjectIds.has(e.projectId)) continue;

      // Per-project point for windowed totals (includes entries with no taskId,
      // so account-level cycle/week totals capture ALL time on the project).
      projectPoints.push({
        projectId: e.projectId,
        startMs: new Date(e.start).getTime(),
        seconds: e.time,
      });

      if (!e.taskId) continue;

      // Cumulative bucket (whole span, all users).
      const agg = cumulativeByTask.get(e.taskId) ?? {
        seconds: 0,
        projectId: e.projectId,
        userIds: new Set<string>(),
      };
      agg.seconds += e.time;
      if (e.userId) agg.userIds.add(e.userId);
      cumulativeByTask.set(e.taskId, agg);

      // Today bucket (defines which tasks appear in the report).
      const startMs = new Date(e.start).getTime();
      if (startMs >= todayStart && startMs < todayEnd) {
        const list = todayByTask.get(e.taskId) ?? [];
        list.push(e);
        todayByTask.set(e.taskId, list);
      }
    }
  });

  logger.info(
    `Time Doctor: ${todayByTask.size} tasks tracked today on target projects ` +
      `(${cumulativeByTask.size} tasks in the cumulative span)`,
  );

  // Resolve task names for the tracked tasks.
  const allTasks = await td.listTasks();
  const taskNames = new Map<string, string>();
  for (const t of allTasks) taskNames.set(t.id, t.name?.trim() ?? "");

  // Build results from tasks that had time TODAY.
  const tasks: TrackedTask[] = [];
  for (const [taskId, todayEntries] of todayByTask) {
    const secondsToday = todayEntries.reduce((s, e) => s + e.time, 0);
    const cum = cumulativeByTask.get(taskId);
    const projectId = todayEntries[0]?.projectId ?? cum?.projectId ?? "";
    tasks.push({
      taskId,
      taskName: taskNames.get(taskId) ?? "(unknown task)",
      projectId,
      projectName: projectNames.get(projectId) ?? "(unknown project)",
      secondsToday,
      secondsCumulative: cum?.seconds ?? secondsToday,
      userIds: cum ? [...cum.userIds] : [...new Set(todayEntries.map((e) => e.userId ?? ""))],
    });
  }

  tasks.sort((a, b) => b.secondsToday - a.secondsToday);
  return { tasks, projectNames, projectPoints };
}

/** Sum seconds for a project within [fromMs, toMs). */
export function sumProjectInWindow(
  points: ProjectWorklogPoint[],
  projectId: string,
  fromMs: number,
  toMs: number,
): number {
  let total = 0;
  for (const p of points) {
    if (p.projectId === projectId && p.startMs >= fromMs && p.startMs < toMs) {
      total += p.seconds;
    }
  }
  return total;
}
