import { config as loadDotenv } from "dotenv";
import { z } from "zod";

// Load .env into process.env (no-op if the file is absent, e.g. in CI where
// secrets are injected directly into the environment).
loadDotenv();

/** Treat empty-string env values (e.g. `TD_TOKEN=`) as undefined before validating. */
function emptyToUndefined<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((v) => (v === "" ? undefined : v), schema);
}

/**
 * Schema for all configuration the app needs. Validating up front means a
 * missing or malformed secret fails loudly at startup with a clear message,
 * instead of surfacing as a cryptic 401 in the middle of the 5 PM run.
 */
const envSchema = z
  .object({
    // Slack
    SLACK_BOT_TOKEN: z.string().min(1, "SLACK_BOT_TOKEN is required").startsWith("xoxb-"),
    SLACK_CHANNEL_ID: z.string().min(1, "SLACK_CHANNEL_ID is required"),

    // Notion
    NOTION_TOKEN: z.string().min(1, "NOTION_TOKEN is required"),
    NOTION_MASTER_TRACKER_DB_ID: z.string().min(1, "NOTION_MASTER_TRACKER_DB_ID is required"),

    // Time Doctor — either a pre-obtained token OR email+password must be present.
    // Empty strings in .env are treated as "not set".
    TD_EMAIL: emptyToUndefined(z.string().email().optional()),
    TD_PASSWORD: emptyToUndefined(z.string().min(1).optional()),
    TD_TOKEN: emptyToUndefined(z.string().min(1).optional()),
    TD_COMPANY_ID: z.string().min(1, "TD_COMPANY_ID is required"),

    // Behaviour
    REPORT_TIMEZONE: z.string().min(1).default("America/New_York"),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    REPORT_ACCOUNTS: z
      .string()
      .min(1, "REPORT_ACCOUNTS is required")
      .transform((s) => s.split(",").map((a) => a.trim()).filter(Boolean)),
    TRACKED_FALLBACK_DAYS: z.coerce.number().int().positive().default(90),
    // Comma-separated Slack user IDs (U…) to @-mention in the footer (optional).
    REPORT_FYI_USER_IDS: emptyToUndefined(z.string().optional()).transform((s) =>
      (s ?? "").split(",").map((id) => id.trim()).filter(Boolean),
    ),
    // Skip US federal holidays in addition to weekends (default off).
    SKIP_US_HOLIDAYS: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    // Slack user ID (U…) to DM when a scheduled run fails (optional).
    ALERT_SLACK_USER_ID: emptyToUndefined(z.string().optional()),
    // Per-account billing-cycle start day, JSON: {"Account Name": dayOfMonth}.
    // Accounts not listed simply omit the month/week totals.
    REPORT_CYCLE_START_DAYS: emptyToUndefined(z.string().optional()).transform((s) => {
      if (!s) return {} as Record<string, number>;
      const parsed = JSON.parse(s) as Record<string, number>;
      return parsed;
    }),
  })
  .superRefine((val, ctx) => {
    const hasToken = !!val.TD_TOKEN;
    const hasCredentials = !!val.TD_EMAIL && !!val.TD_PASSWORD;
    if (!hasToken && !hasCredentials) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Time Doctor auth missing: set TD_TOKEN, or both TD_EMAIL and TD_PASSWORD.",
        path: ["TD_TOKEN"],
      });
    }
  });

export type AppConfig = z.infer<typeof envSchema>;

let cached: AppConfig | undefined;

/**
 * Returns the validated, frozen configuration. Parsed once and memoised.
 * Throws a readable aggregated error if anything is missing/invalid.
 */
export function getConfig(): AppConfig {
  if (cached) return cached;

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  cached = Object.freeze(parsed.data);
  return cached;
}
