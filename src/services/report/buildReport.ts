import { getConfig } from "../../config/env.js";
import { logger } from "../../utils/logger.js";
import {
  dayWindow,
  daysAgoIso,
  formatReportDate,
  billingCycleWindow,
  currentWeekWindow,
} from "../../utils/time.js";
import { NotionClient } from "../../integrations/notion/client.js";
import { TimeDoctorClient } from "../../integrations/timedoctor/client.js";
import {
  getTrackedToday,
  sumProjectInWindow,
  type ProjectWorklogPoint,
} from "../timedoctor/trackedToday.js";
import { getCardsForAccounts, sumSubcardDurations } from "../notion/cards.js";
import { matchCards } from "../matching/matchCards.js";
import { mapWithConcurrency } from "../../utils/concurrency.js";
import type {
  EodReport,
  ReportCard,
  AccountGroup,
  AccountIcon,
  AccountTotals,
} from "../../domain/types.js";

/**
 * Orchestrates the full data pipeline and produces the assembled report:
 *   Time Doctor (tracked today + cumulative) → Notion (card details) →
 *   match by Time Doctor id/name → merge → group by account.
 */
export async function buildReport(): Promise<EodReport> {
  const cfg = getConfig();
  const win = dayWindow(cfg.REPORT_TIMEZONE);
  const dateLabel = formatReportDate(cfg.REPORT_TIMEZONE);

  const td = new TimeDoctorClient({
    token: cfg.TD_TOKEN,
    email: cfg.TD_EMAIL,
    password: cfg.TD_PASSWORD,
    companyId: cfg.TD_COMPANY_ID,
  });
  const notion = new NotionClient(cfg.NOTION_TOKEN, cfg.NOTION_MASTER_TRACKER_DB_ID);

  // 1. Time Doctor: tasks tracked today on the target accounts, with cumulative.
  const tracked = await getTrackedToday({
    td,
    accountNames: cfg.REPORT_ACCOUNTS,
    todayFromIso: win.fromIso,
    todayToIso: win.toIso,
    cumulativeFromIso: daysAgoIso(cfg.TRACKED_FALLBACK_DAYS),
  });

  if (tracked.tasks.length === 0) {
    logger.info("No tracked work today on the target accounts (showing all accounts as empty).");
  }

  // 2. Notion: cards for the target accounts.
  const clientsDbId = await notion.getClientsDatabaseId();
  const { cards, icons } = await getCardsForAccounts({
    notion,
    clientsDbId,
    accountNames: cfg.REPORT_ACCOUNTS,
  });

  // 3. Match and merge.
  const { matched } = matchCards(tracked.tasks, cards);

  // Hours Estimated = sum of each matched card's subcard Durations. Computed
  // only for matched cards (a handful), in parallel.
  const estimates = await mapWithConcurrency(matched, 6, ({ card }) =>
    sumSubcardDurations(notion, card.subcardIds),
  );

  const reportCards: ReportCard[] = matched.map(({ task, card }, i) => ({
    id: card.id,
    title: card.title,
    url: card.url,
    account: card.account,
    status: card.status ?? "—",
    estimatedHours: estimates[i] ?? null,
    trackedSeconds: task.secondsCumulative,
    pushedToQiHours: card.pushedToQiHours,
    timeDoctorTaskId: task.taskId,
    timeDoctorProjectId: task.projectId,
  }));

  // 4. Per-account month-cycle + weekly totals (from the worklog already swept).
  const totals = computeAccountTotals(
    tracked.projectNames,
    tracked.projectPoints,
    cfg.REPORT_CYCLE_START_DAYS,
    cfg.REPORT_TIMEZONE,
  );

  // 5. Group by account, preserving the configured account order.
  const groups = groupByAccount(reportCards, cfg.REPORT_ACCOUNTS, icons, totals);
  return { dateLabel, localDate: win.localDate, groups, fyiUserIds: cfg.REPORT_FYI_USER_IDS };
}

/**
 * For each account with a configured billing-cycle start day, sum its Time
 * Doctor project's tracked seconds over (a) the current billing cycle and
 * (b) the current week. Accounts without a cycle get no totals (null).
 */
function computeAccountTotals(
  projectNames: Map<string, string>,
  points: ProjectWorklogPoint[],
  cycleStartDays: Record<string, number>,
  timeZone: string,
): Map<string, AccountTotals> {
  const nameToProjectId = new Map<string, string>();
  for (const [id, name] of projectNames) nameToProjectId.set(name, id);

  const out = new Map<string, AccountTotals>();
  for (const [account, startDay] of Object.entries(cycleStartDays)) {
    const projectId = nameToProjectId.get(account);
    if (!projectId) continue;

    const cycle = billingCycleWindow(timeZone, startDay);
    const monthSeconds = sumProjectInWindow(
      points,
      projectId,
      new Date(cycle.fromIso).getTime(),
      new Date(cycle.toIso).getTime(),
    );

    // Weekly window is clamped to this account's cycle start so it never
    // counts days from before the cycle began (e.g. a mid-week 1st).
    const week = currentWeekWindow(timeZone, new Date(), cycle.fromIso);
    const weekSeconds = sumProjectInWindow(
      points,
      projectId,
      new Date(week.fromIso).getTime(),
      new Date(week.toIso).getTime(),
    );

    out.set(account, { monthSeconds, weekSeconds, cycleStartDay: startDay });
  }
  return out;
}

/** Group cards by account, ordered by the configured account list (then alpha). */
function groupByAccount(
  cards: ReportCard[],
  accountOrder: string[],
  icons: Map<string, AccountIcon>,
  totals: Map<string, AccountTotals>,
): AccountGroup[] {
  const byAccount = new Map<string, ReportCard[]>();
  for (const c of cards) {
    const list = byAccount.get(c.account) ?? [];
    list.push(c);
    byAccount.set(c.account, list);
  }

  // Always emit a group for EVERY configured account, even with no cards today
  // (empty groups render a "no cards worked today" message). Also include any
  // account that had cards but somehow isn't in the configured list.
  const allAccounts = new Set<string>([...accountOrder, ...byAccount.keys()]);

  const order = new Map(accountOrder.map((a, i) => [a, i]));
  const groups: AccountGroup[] = [...allAccounts].map((account) => ({
    account,
    icon: icons.get(account) ?? null,
    totals: totals.get(account) ?? null,
    // Within an account, show the most-tracked card first.
    cards: (byAccount.get(account) ?? []).sort((a, b) => b.trackedSeconds - a.trackedSeconds),
  }));

  groups.sort((a, b) => {
    const ai = order.get(a.account) ?? Number.MAX_SAFE_INTEGER;
    const bi = order.get(b.account) ?? Number.MAX_SAFE_INTEGER;
    return ai !== bi ? ai - bi : a.account.localeCompare(b.account);
  });
  return groups;
}
