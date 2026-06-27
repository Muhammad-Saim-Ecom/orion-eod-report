import { requestJson } from "../../utils/http.js";
import { logger } from "../../utils/logger.js";

const BASE_URL = "https://api2.timedoctor.com/api/1.0";

export interface TimeDoctorAuth {
  /** A pre-obtained long-lived token. If set, login is skipped. */
  token?: string;
  email?: string;
  password?: string;
  companyId: string;
}

export interface TdProject {
  id: string;
  name: string;
}

export interface TdTask {
  id: string;
  name: string;
  project?: { id: string };
  status?: string;
}

export interface TdUser {
  id: string;
  name: string;
  email?: string;
}

export interface TdWorklogEntry {
  start: string;
  /** Tracked time in seconds. */
  time: number;
  projectId?: string;
  taskId?: string;
  userId?: string;
}

interface LoginResponse {
  data: { token: string; expiresAt: string };
}

interface ListResponse<T> {
  data: T[];
}

/**
 * Thin typed client over the Time Doctor 2 REST API.
 *
 * Structure (verified against the live API):
 *   - Projects  = clients / accounts
 *   - Tasks     = card-level work within a project
 *   - Worklog   = time entries (seconds) tagged with projectId/taskId/userId
 */
export class TimeDoctorClient {
  private token: string | undefined;

  constructor(private readonly auth: TimeDoctorAuth) {
    this.token = auth.token && auth.token.length > 0 ? auth.token : undefined;
  }

  /** Obtain (and cache) an API token, logging in with email+password if needed. */
  private async ensureToken(): Promise<string> {
    if (this.token) return this.token;
    if (!this.auth.email || !this.auth.password) {
      throw new Error("Time Doctor: no TD_TOKEN and no email/password to log in with.");
    }
    logger.debug("Time Doctor: logging in to obtain token");
    const res = await requestJson<LoginResponse>(`${BASE_URL}/login`, {
      method: "POST",
      body: { email: this.auth.email, password: this.auth.password, permissions: "read" },
    });
    this.token = res.data.token;
    return this.token;
  }

  private async query(path: string, params: Record<string, string>): Promise<string> {
    const token = await this.ensureToken();
    const search = new URLSearchParams({
      company: this.auth.companyId,
      token,
      ...params,
    });
    return `${BASE_URL}${path}?${search.toString()}`;
  }

  /** Confirm auth + return basic identity for the connectivity test. */
  async whoami(): Promise<{ userId: string; companies: { id: string; name: string }[] }> {
    const token = await this.ensureToken();
    const url = `${BASE_URL}/authorization?token=${encodeURIComponent(token)}`;
    const res = await requestJson<{
      data: { id: string; companies: { id: string; name: string }[] };
    }>(url);
    return { userId: res.data.id, companies: res.data.companies };
  }

  /** List all projects (clients/accounts). */
  async listProjects(): Promise<TdProject[]> {
    const url = await this.query("/projects", { limit: "1000" });
    const res = await requestJson<ListResponse<TdProject>>(url);
    return res.data;
  }

  /**
   * List all tasks, following Time Doctor's offset-style pagination.
   * NOTE: `page` is a ROW OFFSET, not a page index — advance by `limit`.
   * The `project=` filter is ignored by the API, so callers filter client-side.
   */
  async listTasks(): Promise<TdTask[]> {
    const limit = 1000;
    const out: TdTask[] = [];
    let offset = 0;
    // Hard cap to avoid runaway loops; the company has ~10.7k tasks.
    for (let guard = 0; guard < 50; guard++) {
      const url = await this.query("/tasks", { limit: String(limit), page: String(offset) });
      const res = await requestJson<ListResponse<TdTask> & { paging?: { totalCount?: number } }>(url);
      const batch = res.data ?? [];
      if (batch.length === 0) break;
      out.push(...batch);
      offset += limit;
      const total = res.paging?.totalCount;
      if (total !== undefined && out.length >= total) break;
      if (batch.length < limit) break;
    }
    // De-dupe defensively (offset pagination can overlap on the boundary).
    const byId = new Map(out.map((t) => [t.id, t]));
    return [...byId.values()];
  }

  /** List all users (team members). */
  async listUsers(): Promise<TdUser[]> {
    const url = await this.query("/users", { limit: "500" });
    const res = await requestJson<ListResponse<TdUser>>(url);
    return res.data;
  }

  /**
   * Fetch worklog entries for ONE user over a window, automatically splitting
   * the range into <=7-day chunks (the API rejects wider windows with a
   * "mergeRange: range too wide" error returned inside a 200 response).
   *
   * The API filters by project/task are unreliable, so callers filter the
   * returned entries by projectId/taskId themselves.
   */
  async getUserWorklog(userId: string, fromIso: string, toIso: string): Promise<TdWorklogEntry[]> {
    const out: TdWorklogEntry[] = [];
    for (const [chunkFrom, chunkTo] of weeklyChunks(fromIso, toIso)) {
      const url = await this.query("/activity/worklog", {
        from: chunkFrom,
        to: chunkTo,
        user: userId,
      });
      const res = await requestJson<{ data?: unknown; error?: string }>(url);
      if (res.error) {
        throw new Error(`Time Doctor worklog error for user ${userId}: ${res.error}`);
      }
      out.push(...flattenWorklog(res.data));
    }
    return out;
  }
}

/** Split [from, to) into consecutive <=7-day [start, end) ISO windows. */
export function weeklyChunks(fromIso: string, toIso: string): Array<[string, string]> {
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
  const start = new Date(fromIso).getTime();
  const end = new Date(toIso).getTime();
  const chunks: Array<[string, string]> = [];
  let cursor = start;
  while (cursor < end) {
    const next = Math.min(cursor + SEVEN_DAYS, end);
    chunks.push([new Date(cursor).toISOString(), new Date(next).toISOString()]);
    cursor = next;
  }
  return chunks;
}

/** Worklog responses nest entries in arrays-of-arrays (per user); flatten them. */
function flattenWorklog(data: unknown): TdWorklogEntry[] {
  const out: TdWorklogEntry[] = [];
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) {
      for (const item of x) walk(item);
    } else if (x && typeof x === "object") {
      const e = x as Record<string, unknown>;
      if (typeof e.time === "number" && typeof e.start === "string") {
        out.push({
          start: e.start,
          time: e.time,
          projectId: typeof e.projectId === "string" ? e.projectId : undefined,
          taskId: typeof e.taskId === "string" ? e.taskId : undefined,
          userId: typeof e.userId === "string" ? e.userId : undefined,
        });
      }
    }
  };
  walk(data);
  return out;
}
