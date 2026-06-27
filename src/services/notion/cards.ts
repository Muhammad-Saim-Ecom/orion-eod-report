import { NotionClient, type MasterTrackerPage } from "../../integrations/notion/client.js";
import { logger } from "../../utils/logger.js";
import type { AccountIcon } from "../../domain/types.js";
import {
  getText,
  getSelect,
  getNumber,
  getDateStart,
  getRelationIds,
} from "./extract.js";

/** Notion property names used by the report (centralised for easy maintenance). */
export const PROP = {
  name: "Name",
  status: "Status",
  client: "Client",
  projectedDevHours: "Projected Dev Hours",
  bufferHours: "Buffer Hours",
  executedTaskHours: "Executed Task Hours",
  timeDoctorTaskId: "Time Doctor Project ID",
  timeDoctorClientProjectId: "Time Doctor (Client) Project ID",
  actualStartDate: "Actual Start Date",
  tasks: "Tasks",
} as const;

/** Subcard "Duration" property name (in the embedded "Project Task All" DB). */
const SUBCARD_DURATION = "Duration";

/**
 * Property IDs for `filter_properties`. The Master Tracker has 90+ properties
 * (many heavy formulas/rollups); requesting only these avoids Notion's
 * "object rendering exceeded the response time budget" timeout.
 */
const CARD_PROP_IDS = [
  "title", // Name
  "%7BjDe", // Status
  "em%7D%3B", // Client
  "%5CDmP", // Projected Dev Hours
  "%3C_%5Ec", // Buffer Hours
  "Xt%7DM", // Executed Task Hours
  "fTcG", // Time Doctor Project ID
  "%3E%7BIR", // Actual Start Date
  "Jxmx", // Tasks (subcard relation)
];

/** A Master Tracker card with the fields the report needs, extracted. */
export interface NotionCard {
  id: string;
  title: string;
  url: string;
  /** Client (account) name, resolved from the relation. */
  account: string;
  status: string | null;
  /** Sum of all subcard Durations (null if no subcards / none have a value). */
  estimatedHours: number | null;
  /** Subcard (Tasks relation) page ids — used to sum Durations. */
  subcardIds: string[];
  /** Executed Task Hours = hours pushed to QI/Done. */
  pushedToQiHours: number | null;
  /** Time Doctor task id stored on the card. */
  timeDoctorTaskId: string | null;
  /** Actual Start Date ISO (null if unset → caller uses fallback window). */
  actualStartDate: string | null;
}

/**
 * Fetch Master Tracker cards for the given account names.
 *
 * 1. Resolve account names → Client page ids (titles may have trailing
 *    whitespace, so matching is trimmed).
 * 2. Query Master Tracker filtered to those Client relations.
 * 3. Extract the report fields, resolving each card's account name.
 */
export async function getCardsForAccounts(args: {
  notion: NotionClient;
  clientsDbId: string;
  accountNames: string[];
}): Promise<{ cards: NotionCard[]; icons: Map<string, AccountIcon> }> {
  const { notion, clientsDbId, accountNames } = args;
  const wanted = new Set(accountNames.map((a) => a.trim()));

  // 1. Resolve client name → id (only the title is needed).
  const clientPages = await notion.queryDatabase(clientsDbId, {
    filterProperties: ["title"],
  });
  const clientIdToName = new Map<string, string>();
  const matchedClientIds: string[] = [];
  const matchedNameById = new Map<string, string>();
  for (const page of clientPages) {
    const name = titleOf(page);
    if (!name) continue;
    clientIdToName.set(page.id, name);
    if (wanted.has(name)) {
      matchedClientIds.push(page.id);
      matchedNameById.set(page.id, name);
    }
  }

  // Resolve each matched client's icon (account name → icon).
  const icons = new Map<string, AccountIcon>();
  for (const [id, name] of matchedNameById) {
    try {
      const icon = await notion.getPageIcon(id);
      if (icon) icons.set(name, icon);
    } catch (err) {
      logger.warn(`Notion: could not fetch icon for ${name}: ${String(err)}`);
    }
  }

  const missing = [...wanted].filter(
    (n) => ![...clientIdToName.values()].includes(n),
  );
  if (missing.length > 0) {
    logger.warn(`Notion: no Client page found for: ${missing.join(", ")}`);
  }

  // 2. Query Master Tracker filtered to those clients (OR of relation contains).
  const filter =
    matchedClientIds.length > 0
      ? {
          or: matchedClientIds.map((id) => ({
            property: PROP.client,
            relation: { contains: id },
          })),
        }
      : undefined;
  const cardPages = await notion.queryMasterTrackerFiltered({
    filter,
    filterProperties: CARD_PROP_IDS,
  });
  logger.info(`Notion: ${cardPages.length} cards across ${matchedClientIds.length} clients`);

  // 3. Extract fields.
  const cards: NotionCard[] = [];
  for (const page of cardPages) {
    const props = page.properties;
    const clientIds = getRelationIds(props, PROP.client);
    const account =
      clientIds.map((id) => clientIdToName.get(id)).find((n): n is string => !!n) ??
      "(unknown account)";

    cards.push({
      id: page.id,
      title: getText(props, PROP.name) ?? "(untitled)",
      url: page.url,
      account,
      status: getSelect(props, PROP.status),
      // estimatedHours is filled in later from the subcard Duration sum.
      estimatedHours: null,
      subcardIds: getRelationIds(props, PROP.tasks),
      pushedToQiHours: getNumber(props, PROP.executedTaskHours),
      timeDoctorTaskId: getText(props, PROP.timeDoctorTaskId),
      actualStartDate: getDateStart(props, PROP.actualStartDate),
    });
  }
  return { cards, icons };
}

/**
 * Sum the `Duration` of a card's subcards (the embedded "Project Task All"
 * table, exposed via the `Tasks` relation). Fetches each subcard page; call
 * only for the handful of cards that appear in the report.
 */
export async function sumSubcardDurations(
  notion: NotionClient,
  subcardIds: string[],
): Promise<number | null> {
  if (subcardIds.length === 0) return null;
  let total = 0;
  let found = 0;
  for (const id of subcardIds) {
    const page = await notion.getPage(id);
    if (!page) continue;
    const dur = getNumber(page.properties, SUBCARD_DURATION);
    if (dur !== null) {
      total += dur;
      found++;
    }
  }
  return found > 0 ? total : null;
}

function titleOf(page: MasterTrackerPage): string | null {
  for (const p of Object.values(page.properties)) {
    if (p.type === "title") {
      const arr = p.title as Array<{ plain_text?: string }> | undefined;
      const t = arr?.map((x) => x.plain_text ?? "").join("").trim() ?? "";
      return t.length > 0 ? t : null;
    }
  }
  return null;
}
