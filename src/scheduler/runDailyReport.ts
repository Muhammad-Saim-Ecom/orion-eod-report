import { getConfig } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { secondsToHm } from "../utils/time.js";
import { checkBusinessDay, localHour } from "../utils/calendar.js";
import { buildReport } from "../services/report/buildReport.js";
import { renderConsole } from "../services/report/renderConsole.js";
import { renderSlack, chunkBlocks } from "../services/report/renderSlack.js";
import { SlackClient } from "../integrations/slack/client.js";
import type { EodReport } from "../domain/types.js";

export interface RunOptions {
  /** When true, render to console instead of posting to Slack. */
  dryRun?: boolean;
  /** When true, run even on weekends/holidays (for manual testing). */
  force?: boolean;
}

/**
 * The single deploy-agnostic entrypoint for the daily report. A scheduler
 * (GitHub Actions cron in Phase 6) invokes this once at 5 PM ET.
 *
 * Phase 4: builds the fully-merged report and prints it to console.
 * Phase 5 will add Slack Block Kit rendering + posting for the non-dry path.
 */
export async function runDailyReport(opts: RunOptions = {}): Promise<EodReport | null> {
  const cfg = getConfig();

  // Skip weekends (and holidays if enabled), unless forced.
  if (!opts.force) {
    const day = checkBusinessDay(cfg.REPORT_TIMEZONE, new Date(), cfg.SKIP_US_HOLIDAYS);
    if (!day.isBusinessDay) {
      logger.info(`Skipping report: today is a ${day.reason}. (Use --force to run anyway.)`);
      return null;
    }
    // We schedule two UTC crons (one for EST, one for EDT) so the run always
    // lands at the target local hour. Only the cron matching the current local
    // post hour proceeds; the other is a no-op for that part of the year.
    const hour = localHour(cfg.REPORT_TIMEZONE);
    if (hour !== cfg.REPORT_POST_HOUR) {
      logger.info(
        `Skipping report: local hour is ${hour}:00, not ${cfg.REPORT_POST_HOUR}:00. (post-hour guard)`,
      );
      return null;
    }
  }

  logger.info(`Building EOD report (${cfg.REPORT_TIMEZONE})`);

  const report = await buildReport();

  const cardCount = report.groups.reduce((n, g) => n + g.cards.length, 0);
  logger.info(`Report assembled: ${report.groups.length} accounts, ${cardCount} cards`);

  if (opts.dryRun) {
    // eslint-disable-next-line no-console
    console.log("\n" + renderConsole(report) + "\n");
    return report;
  }

  // Post to Slack. Block Kit allows max 50 blocks per message, so split a long
  // report across multiple messages (the first carries the fallback text).
  const slack = new SlackClient(cfg.SLACK_BOT_TOKEN, cfg.SLACK_CHANNEL_ID);
  const { blocks, text } = renderSlack(report);
  const chunks = chunkBlocks(blocks);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;
    await slack.post({ blocks: chunk, text: i === 0 ? text : `${text} (cont.)` });
  }
  logger.info(`Posted report to Slack in ${chunks.length} message(s).`);

  return report;
}

/** Re-exported for convenience in tests/other callers. */
export { secondsToHm };
