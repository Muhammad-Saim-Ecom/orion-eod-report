import type { NotionProperty } from "../../integrations/notion/client.js";

/**
 * Helpers to pull plain values out of Notion's verbose property shapes.
 * Notion titles/text frequently carry trailing whitespace, so string values
 * are trimmed.
 */

type Props = Record<string, NotionProperty>;

function prop(props: Props, name: string): NotionProperty | undefined {
  return props[name];
}

/** Title or rich_text → trimmed plain string (null if absent/empty). */
export function getText(props: Props, name: string): string | null {
  const p = prop(props, name);
  if (!p) return null;
  const arr =
    p.type === "title"
      ? (p.title as Array<{ plain_text?: string }> | undefined)
      : p.type === "rich_text"
        ? (p.rich_text as Array<{ plain_text?: string }> | undefined)
        : undefined;
  if (!arr) return null;
  const text = arr.map((t) => t.plain_text ?? "").join("").trim();
  return text.length > 0 ? text : null;
}

/** select/status → trimmed name (null if empty). */
export function getSelect(props: Props, name: string): string | null {
  const p = prop(props, name);
  if (!p) return null;
  const v =
    p.type === "select"
      ? (p.select as { name?: string } | null)
      : p.type === "status"
        ? (p.status as { name?: string } | null)
        : null;
  return v?.name?.trim() ?? null;
}

/** number or formula(number) → number (null if absent). */
export function getNumber(props: Props, name: string): number | null {
  const p = prop(props, name);
  if (!p) return null;
  if (p.type === "number") return typeof p.number === "number" ? p.number : null;
  if (p.type === "formula") {
    const f = p.formula as { type: string; number?: number } | undefined;
    return f?.type === "number" && typeof f.number === "number" ? f.number : null;
  }
  if (p.type === "rollup") {
    const r = p.rollup as { type: string; number?: number } | undefined;
    return r?.type === "number" && typeof r.number === "number" ? r.number : null;
  }
  return null;
}

/** date → ISO start string (null if empty). */
export function getDateStart(props: Props, name: string): string | null {
  const p = prop(props, name);
  if (!p || p.type !== "date") return null;
  const d = p.date as { start?: string } | null;
  return d?.start ?? null;
}

/** relation → array of related page ids. */
export function getRelationIds(props: Props, name: string): string[] {
  const p = prop(props, name);
  if (!p || p.type !== "relation") return [];
  const rels = p.relation as Array<{ id: string }> | undefined;
  return rels?.map((r) => r.id) ?? [];
}
