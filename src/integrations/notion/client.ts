import { Client } from "@notionhq/client";

/**
 * Thin wrapper over the Notion SDK, scoped to what the report needs:
 * reading the Master Tracker database.
 *
 * Property extraction (mapping Notion's property shapes into plain values)
 * lives in the report service, not here — this client only fetches raw pages.
 */
export class NotionClient {
  private readonly notion: Client;

  constructor(
    token: string,
    private readonly masterTrackerDbId: string,
  ) {
    this.notion = new Client({ auth: token });
  }

  /**
   * Query any database, following pagination. Returns raw pages with properties.
   *
   * `filterProperties` lists property IDs to return — strongly recommended for
   * the Master Tracker, which has 90+ properties (many heavy formulas/rollups)
   * and otherwise times out with "object rendering exceeded the response time
   * budget". `pageSize` is kept small for the same reason.
   */
  async queryDatabase(
    databaseId: string,
    opts: {
      filter?: Record<string, unknown>;
      filterProperties?: string[];
      pageSize?: number;
    } = {},
  ): Promise<MasterTrackerPage[]> {
    const { filter, filterProperties, pageSize = 50 } = opts;
    const pages: MasterTrackerPage[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.notion.databases.query({
        database_id: databaseId,
        ...(filter ? { filter: filter as never } : {}),
        ...(filterProperties ? { filter_properties: filterProperties } : {}),
        ...(cursor ? { start_cursor: cursor } : {}),
        page_size: pageSize,
      });
      for (const page of res.results) {
        if ("properties" in page) pages.push(page as MasterTrackerPage);
      }
      cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
    } while (cursor);
    return pages;
  }

  /** Confirm the integration token works; returns the bot/workspace name. */
  async whoami(): Promise<string> {
    const me = await this.notion.users.me({});
    // Bot users expose the owning workspace name.
    const workspace =
      me.type === "bot" && me.bot?.workspace_name ? me.bot.workspace_name : me.name;
    return workspace ?? "unknown";
  }

  /** Read the Master Tracker database metadata (also used as a reachability check). */
  async getMasterTrackerMeta(): Promise<{ title: string }> {
    const db = await this.notion.databases.retrieve({ database_id: this.masterTrackerDbId });
    const title =
      "title" in db && Array.isArray(db.title)
        ? db.title.map((t) => ("plain_text" in t ? t.plain_text : "")).join("")
        : "(untitled)";
    return { title };
  }

  /** Query Master Tracker with an optional filter + property projection. */
  async queryMasterTrackerFiltered(opts: {
    filter?: Record<string, unknown>;
    filterProperties?: string[];
  }): Promise<MasterTrackerPage[]> {
    return this.queryDatabase(this.masterTrackerDbId, opts);
  }

  /** Discover the database id that the `Client` relation points to. */
  async getClientsDatabaseId(): Promise<string> {
    const db = await this.notion.databases.retrieve({ database_id: this.masterTrackerDbId });
    const clientProp = "properties" in db ? db.properties["Client"] : undefined;
    if (clientProp?.type === "relation") {
      return clientProp.relation.database_id;
    }
    throw new Error("Notion: could not resolve the Client relation's database id.");
  }

  /**
   * Resolve a page's icon. Returns an image URL (for file/external icons) or an
   * emoji string, or null. NOTE: uploaded ("file") icon URLs are short-lived
   * S3 links — fetch them at the moment of use (e.g. just before posting).
   */
  async getPageIcon(pageId: string): Promise<{ kind: "image" | "emoji"; value: string } | null> {
    const page = await this.notion.pages.retrieve({ page_id: pageId });
    const icon = "icon" in page ? page.icon : null;
    if (!icon) return null;
    if (icon.type === "emoji") return { kind: "emoji", value: icon.emoji };
    if (icon.type === "external") return { kind: "image", value: icon.external.url };
    if (icon.type === "file") return { kind: "image", value: icon.file.url };
    return null;
  }

  /** Read a single page's properties (used to read a subcard's Duration). */
  async getPage(pageId: string): Promise<MasterTrackerPage | null> {
    const page = await this.notion.pages.retrieve({ page_id: pageId });
    return "properties" in page ? (page as MasterTrackerPage) : null;
  }

  /** Resolve a related page's title (e.g. the Client name from a relation id). */
  async getPageTitle(pageId: string): Promise<string> {
    const page = await this.notion.pages.retrieve({ page_id: pageId });
    if (!("properties" in page)) return pageId;
    for (const prop of Object.values(page.properties)) {
      if (prop.type === "title") {
        return prop.title.map((t) => t.plain_text).join("") || pageId;
      }
    }
    return pageId;
  }
}

/** A Master Tracker page as returned by the Notion query API (raw properties). */
export interface MasterTrackerPage {
  id: string;
  url: string;
  properties: Record<string, NotionProperty>;
}

/** Loose Notion property type — narrowed at the extraction site in the service. */
export type NotionProperty = { type: string } & Record<string, unknown>;
