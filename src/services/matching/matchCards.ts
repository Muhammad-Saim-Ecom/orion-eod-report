import type { TrackedTask } from "../timedoctor/trackedToday.js";
import type { NotionCard } from "../notion/cards.js";
import { logger } from "../../utils/logger.js";

/** A tracked task successfully paired with its Notion card. */
export interface MatchedCard {
  task: TrackedTask;
  card: NotionCard;
  /** How the match was made — for diagnostics. */
  via: "id" | "name";
}

export interface MatchResult {
  matched: MatchedCard[];
  /** Tracked tasks with no Notion card (omitted from the report per spec). */
  unmatchedTasks: TrackedTask[];
}

/** Normalise a title/name for comparison (trim, collapse whitespace, lowercase). */
function norm(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Join the tasks tracked today (Time Doctor) with Master Tracker cards (Notion).
 *
 * Primary key: Notion card `Time Doctor Project ID` === worklog `taskId`.
 * Fallback:    Notion card title === Time Doctor task name (handles the
 *              duplicate-task case where Notion links an empty stub but time
 *              was logged against an identically-named sibling task).
 *
 * Tasks with no matching card are returned separately (the report omits them).
 */
export function matchCards(tasks: TrackedTask[], cards: NotionCard[]): MatchResult {
  const byTdId = new Map<string, NotionCard>();
  const byName = new Map<string, NotionCard>();
  for (const card of cards) {
    if (card.timeDoctorTaskId) byTdId.set(card.timeDoctorTaskId, card);
    byName.set(norm(card.title), card);
  }

  const matched: MatchedCard[] = [];
  const unmatchedTasks: TrackedTask[] = [];

  for (const task of tasks) {
    const byId = byTdId.get(task.taskId);
    if (byId) {
      matched.push({ task, card: byId, via: "id" });
      continue;
    }
    const byNm = byName.get(norm(task.taskName));
    if (byNm) {
      matched.push({ task, card: byNm, via: "name" });
      continue;
    }
    unmatchedTasks.push(task);
  }

  logger.info(
    `Matching: ${matched.length} matched ` +
      `(${matched.filter((m) => m.via === "id").length} by id, ` +
      `${matched.filter((m) => m.via === "name").length} by name), ` +
      `${unmatchedTasks.length} unmatched (omitted)`,
  );
  if (unmatchedTasks.length > 0) {
    logger.debug(
      `Unmatched tasks: ${unmatchedTasks.map((t) => `${t.taskName} (${t.taskId})`).join("; ")}`,
    );
  }

  return { matched, unmatchedTasks };
}
