import { getConfig } from "./config/env.js";
import { logger } from "./utils/logger.js";
import { runDailyReport } from "./scheduler/runDailyReport.js";
import { NotionClient } from "./integrations/notion/client.js";
import { SlackClient } from "./integrations/slack/client.js";
import { TimeDoctorClient } from "./integrations/timedoctor/client.js";
import { getTrackedToday } from "./services/timedoctor/trackedToday.js";
import { getCardsForAccounts } from "./services/notion/cards.js";
import { dayWindow, daysAgoIso, secondsToHm } from "./utils/time.js";

/**
 * CLI entrypoint.
 *   connftest          verify connectivity to Slack, Notion, and Time Doctor
 *   report [--dry-run] run the daily report (dry-run prints instead of posting)
 */
async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case "connftest":
      await connectivityTest();
      break;
    case "td:today":
      await timeDoctorTodayDebug();
      break;
    case "notion:cards":
      await notionCardsDebug();
      break;
    case "report":
      await runReportCommand({
        dryRun: rest.includes("--dry-run"),
        force: rest.includes("--force"),
      });
      break;
    default:
      logger.info("Usage: <connftest | td:today | notion:cards | report [--dry-run] [--force]>");
      process.exitCode = 1;
  }
}

/**
 * Run the daily report, and on failure DM the configured alert user so a broken
 * scheduled run is noticed (the error is still re-thrown to fail the CI job).
 */
async function runReportCommand(opts: { dryRun: boolean; force: boolean }): Promise<void> {
  const cfg = getConfig();
  try {
    await runDailyReport(opts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Report run failed", message);
    if (!opts.dryRun && cfg.ALERT_SLACK_USER_ID) {
      try {
        const slack = new SlackClient(cfg.SLACK_BOT_TOKEN, cfg.SLACK_CHANNEL_ID);
        await slack.dm(cfg.ALERT_SLACK_USER_ID, `:warning: EOD Report failed: ${message}`);
      } catch (dmErr) {
        logger.error("Also failed to send failure DM", String(dmErr));
      }
    }
    throw err; // re-throw so the CI job is marked failed
  }
}

/** Phase 3 debug: print the Master Tracker cards for the target accounts. */
async function notionCardsDebug(): Promise<void> {
  const cfg = getConfig();
  const notion = new NotionClient(cfg.NOTION_TOKEN, cfg.NOTION_MASTER_TRACKER_DB_ID);
  const clientsDbId = await notion.getClientsDatabaseId();
  logger.info(`Notion: Clients DB ${clientsDbId}; fetching cards for ${cfg.REPORT_ACCOUNTS.join(", ")}`);

  const { cards } = await getCardsForAccounts({
    notion,
    clientsDbId,
    accountNames: cfg.REPORT_ACCOUNTS,
  });

  const byAccount = new Map<string, typeof cards>();
  for (const c of cards) {
    const list = byAccount.get(c.account) ?? [];
    list.push(c);
    byAccount.set(c.account, list);
  }
  for (const [account, list] of byAccount) {
    logger.info(`\n  ${account} (${list.length} cards)`);
    for (const c of list.slice(0, 8)) {
      logger.info(
        `    • ${c.title} — status=${c.status ?? "—"}, est=${c.estimatedHours ?? "N/A"}h, ` +
          `qi=${c.pushedToQiHours ?? "N/A"}h, tdTask=${c.timeDoctorTaskId ?? "—"}, start=${c.actualStartDate ?? "—"}`,
      );
    }
    if (list.length > 8) logger.info(`    … and ${list.length - 8} more`);
  }
}

/** Phase 2 debug: print today's tracked tasks on the target accounts. */
async function timeDoctorTodayDebug(): Promise<void> {
  const cfg = getConfig();
  const td = new TimeDoctorClient({
    token: cfg.TD_TOKEN,
    email: cfg.TD_EMAIL,
    password: cfg.TD_PASSWORD,
    companyId: cfg.TD_COMPANY_ID,
  });

  const win = dayWindow(cfg.REPORT_TIMEZONE);
  logger.info(`Time Doctor — tasks tracked today (${win.localDate}) on: ${cfg.REPORT_ACCOUNTS.join(", ")}`);

  const result = await getTrackedToday({
    td,
    accountNames: cfg.REPORT_ACCOUNTS,
    todayFromIso: win.fromIso,
    todayToIso: win.toIso,
    cumulativeFromIso: daysAgoIso(cfg.TRACKED_FALLBACK_DAYS),
  });

  if (result.tasks.length === 0) {
    logger.info("No tasks tracked today on the target accounts.");
    return;
  }

  // Group by account for a readable dump.
  const byAccount = new Map<string, typeof result.tasks>();
  for (const t of result.tasks) {
    const list = byAccount.get(t.projectName) ?? [];
    list.push(t);
    byAccount.set(t.projectName, list);
  }
  for (const [account, tasks] of byAccount) {
    logger.info(`\n  ${account}`);
    for (const t of tasks) {
      logger.info(
        `    • ${t.taskName} — today ${secondsToHm(t.secondsToday)}, ` +
          `cumulative ${secondsToHm(t.secondsCumulative)}, ${t.userIds.length} user(s) [task ${t.taskId}]`,
      );
    }
  }
}

/** Phase 1 acceptance test: prove all three integrations authenticate and read. */
async function connectivityTest(): Promise<void> {
  const cfg = getConfig();
  let ok = true;

  // Slack
  try {
    const slack = new SlackClient(cfg.SLACK_BOT_TOKEN, cfg.SLACK_CHANNEL_ID);
    const id = await slack.whoami();
    logger.info(`✅ Slack: connected to "${id.team}" as ${id.user}`);
  } catch (err) {
    ok = false;
    logger.error("❌ Slack failed", String(err));
  }

  // Notion
  try {
    const notion = new NotionClient(cfg.NOTION_TOKEN, cfg.NOTION_MASTER_TRACKER_DB_ID);
    const workspace = await notion.whoami();
    const meta = await notion.getMasterTrackerMeta();
    logger.info(`✅ Notion: workspace "${workspace}", database "${meta.title}" reachable`);
  } catch (err) {
    ok = false;
    logger.error("❌ Notion failed", String(err));
  }

  // Time Doctor
  try {
    const td = new TimeDoctorClient({
      token: cfg.TD_TOKEN,
      email: cfg.TD_EMAIL,
      password: cfg.TD_PASSWORD,
      companyId: cfg.TD_COMPANY_ID,
    });
    const who = await td.whoami();
    const projects = await td.listProjects();
    const company = who.companies.find((c) => c.id === cfg.TD_COMPANY_ID);
    logger.info(
      `✅ Time Doctor: company "${company?.name ?? cfg.TD_COMPANY_ID}", ${projects.length} projects`,
    );
  } catch (err) {
    ok = false;
    logger.error("❌ Time Doctor failed", String(err));
  }

  if (ok) {
    logger.info("All integrations connected. 🎉");
  } else {
    logger.error("One or more integrations failed.");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  logger.error("Fatal error", err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
