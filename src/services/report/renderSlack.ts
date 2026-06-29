import type { KnownBlock } from "@slack/web-api";
import type { EodReport, ReportCard } from "../../domain/types.js";
import { secondsToHm, cycleRangeLabel } from "../../utils/time.js";

/** Escape Slack mrkdwn special characters in user-supplied text. */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function estLabel(hours: number | null): string {
  return hours === null ? "N/A" : `${hours}h`;
}

function qiLabel(hours: number | null): string {
  return hours === null ? "N/A" : `${hours} Hours`;
}

/** One card rendered as a single mrkdwn section block (stacked fields). */
function cardBlock(card: ReportCard): KnownBlock {
  const titleLink = `<${card.url}|${esc(card.title)}>`;
  const text = [
    `*Card:* ${titleLink}`,
    `*Status:* ${esc(card.status)}`,
    `*Hours Estimated:* ${estLabel(card.estimatedHours)}`,
    `*Hours Tracked:* ${secondsToHm(card.trackedSeconds)}`,
    `*Hours Pushed to QI/Done:* ${qiLabel(card.pushedToQiHours)}`,
  ].join("\n");
  return { type: "section", text: { type: "mrkdwn", text } };
}

/**
 * Render the report as Slack Block Kit blocks:
 *   - a header with the date
 *   - per account: a divider, a big header block "🏢 <Account> · N cards",
 *     then one section per card
 *   - an optional "FYI" footer mentioning configured users
 */
export function renderSlack(report: EodReport): { blocks: KnownBlock[]; text: string } {
  const blocks: KnownBlock[] = [];

  blocks.push({
    type: "header",
    text: { type: "plain_text", text: `📅 EOD Report — ${report.dateLabel}`, emoji: true },
  });

  if (report.groups.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "_No tracked work today on the target accounts._" },
    });
    appendFyi(blocks, report.fyiUserIds);
    return { blocks, text: `EOD Report — ${report.dateLabel}: no tracked work today.` };
  }

  for (const group of report.groups) {
    blocks.push({ type: "divider" });

    // Account header: one bold/black section line with name + month/week totals.
    // (Slack can't right-align or float text, so totals sit inline after the
    // name; an emoji prefix uses the account's Notion emoji icon, else 🏢.)
    const emoji = group.icon?.kind === "emoji" ? group.icon.value : "🏢";
    let headerText = `${emoji}  *${esc(group.account)}*`;
    if (group.totals) {
      const cycle = cycleRangeLabel(group.totals.cycleStartDay);
      headerText +=
        `  ·  *Hours this Month (${cycle}): ${secondsToHm(group.totals.monthSeconds)}*` +
        `  ·  *Hours this Week: ${secondsToHm(group.totals.weekSeconds)}*`;
    }
    blocks.push({ type: "section", text: { type: "mrkdwn", text: headerText } });

    if (group.cards.length === 0) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: "_No cards worked today._" },
      });
      continue;
    }

    for (const card of group.cards) {
      blocks.push(cardBlock(card));
    }
  }

  appendFyi(blocks, report.fyiUserIds);

  const text = `EOD Report — ${report.dateLabel}`;
  return { blocks, text };
}

/**
 * Append a divider + "*FYI* <@U1> <@U2> …" as a section block. A section (not a
 * context block) renders full-size, black text — so "FYI" appears bold and
 * prominent rather than small/grey.
 */
function appendFyi(blocks: KnownBlock[], userIds: string[]): void {
  if (userIds.length === 0) return;
  const mentions = userIds.map((id) => `<@${id}>`).join(" ");
  blocks.push({ type: "divider" });
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `*FYI* ${mentions}` },
  });
}

/**
 * Slack allows at most 50 blocks per message. Split into chunks, preferring to
 * break before a divider so an account header stays with its cards.
 */
export function chunkBlocks(blocks: KnownBlock[], max = 50): KnownBlock[][] {
  if (blocks.length <= max) return [blocks];
  const chunks: KnownBlock[][] = [];
  let current: KnownBlock[] = [];
  for (const block of blocks) {
    if (current.length >= max - 2 && block.type === "divider") {
      chunks.push(current);
      current = [];
    }
    current.push(block);
    if (current.length >= max) {
      chunks.push(current);
      current = [];
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
