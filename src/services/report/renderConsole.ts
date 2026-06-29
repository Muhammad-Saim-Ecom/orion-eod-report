import type { EodReport } from "../../domain/types.js";
import { secondsToHm, cycleRangeLabel } from "../../utils/time.js";

/** Format estimated hours like the report ("7h" or "N/A"). */
function estLabel(hours: number | null): string {
  return hours === null ? "N/A" : `${formatHours(hours)}h`;
}

/** Format QI/Done hours like the report ("7 Hours"). */
function qiLabel(hours: number | null): string {
  return hours === null ? "N/A" : `${formatHours(hours)} Hours`;
}

/** Trim a trailing ".0" from whole numbers (7.0 -> "7", 2.5 -> "2.5"). */
function formatHours(h: number): string {
  return Number.isInteger(h) ? String(h) : String(h);
}

/**
 * Plain-text rendering of the report, mirroring the target Slack layout.
 * Used for `report:dry` so the merged data can be eyeballed before Phase 5.
 */
export function renderConsole(report: EodReport): string {
  const lines: string[] = [];
  lines.push(`📅 EOD Report — ${report.dateLabel}`);

  if (report.groups.length === 0) {
    lines.push("");
    lines.push("No tracked work today on the target accounts.");
    return lines.join("\n");
  }

  for (const group of report.groups) {
    lines.push("");
    let header = `Account: ${group.account}`;
    if (group.totals) {
      const cycle = cycleRangeLabel(group.totals.cycleStartDay);
      header +=
        `  ·  Hours this Month (${cycle}): ${secondsToHm(group.totals.monthSeconds)}` +
        `  ·  Hours this Week: ${secondsToHm(group.totals.weekSeconds)}`;
    }
    lines.push(header);

    if (group.cards.length === 0) {
      lines.push("  No cards worked today.");
      continue;
    }

    for (const card of group.cards) {
      lines.push("");
      lines.push(`  Card: ${card.title}  <${card.url}>`);
      lines.push(`  Status: ${card.status}`);
      lines.push(`  Hours Estimated: ${estLabel(card.estimatedHours)}`);
      lines.push(`  Hours Tracked: ${secondsToHm(card.trackedSeconds)}`);
      lines.push(`  Hours Pushed to QI/Done: ${qiLabel(card.pushedToQiHours)}`);
    }
  }
  return lines.join("\n");
}
