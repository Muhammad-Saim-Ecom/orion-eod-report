/**
 * API-agnostic core types for the report.
 *
 * Integrations (Notion, Time Doctor, Slack) map their own shapes INTO these.
 * The reporting/aggregation logic only ever touches these types, so a change
 * in any external API surface is isolated to that integration's mapper.
 */

/** A single card/project as it will appear in the report. */
export interface ReportCard {
  /** Notion page id. */
  id: string;
  /** Card title (Notion `Name`). */
  title: string;
  /** Public Notion URL for the card hyperlink. */
  url: string;
  /** Account / client name (resolved from Notion `Client` relation). */
  account: string;
  /** Raw status string from Notion (may already contain an emoji). */
  status: string;
  /** Estimated hours = Projected Dev Hours + Buffer Hours. */
  estimatedHours: number | null;
  /** Cumulative hours tracked in Time Doctor for this card's task. */
  trackedSeconds: number;
  /** Hours pushed to QI/Done (Notion `Executed Task Hours`). */
  pushedToQiHours: number | null;
  /** Time Doctor task id this card maps to (Notion `Time Doctor Project ID`). */
  timeDoctorTaskId: string | null;
  /** Time Doctor project (client) id (Notion `Time Doctor (Client) Project ID`). */
  timeDoctorProjectId: string | null;
}

/** An account's icon: a Notion logo image URL or an emoji. */
export interface AccountIcon {
  kind: "image" | "emoji";
  value: string;
}

/** Per-account tracked-hour totals (null when the account has no defined cycle). */
export interface AccountTotals {
  /** Seconds tracked this billing cycle (account-specific month). */
  monthSeconds: number;
  /** Seconds tracked this week (Mon–Sun). */
  weekSeconds: number;
  /** Billing-cycle start day-of-month (e.g. 8 → cycle runs 8th–7th). */
  cycleStartDay: number;
}

/** Cards grouped under one account, as rendered in the report. */
export interface AccountGroup {
  account: string;
  /** Client icon (Notion page icon), or null to fall back to a default emoji. */
  icon: AccountIcon | null;
  /** Month-cycle + weekly totals, or null if no billing cycle is configured. */
  totals: AccountTotals | null;
  cards: ReportCard[];
}

/** The fully assembled report, ready to render to Slack. */
export interface EodReport {
  /** Human header date, e.g. "Thursday, June 18, 2026". */
  dateLabel: string;
  /** Local calendar date, e.g. "2026-06-27". */
  localDate: string;
  groups: AccountGroup[];
  /** Slack user IDs to @-mention in the footer (may be empty). */
  fyiUserIds: string[];
}
