import { WebClient } from "@slack/web-api";
import type { KnownBlock } from "@slack/web-api";

/**
 * Slack posting client. We only post messages on a schedule, so the lightweight
 * WebClient (chat.postMessage) is all we need — no Bolt event server.
 */
export class SlackClient {
  private readonly web: WebClient;

  constructor(
    token: string,
    private readonly defaultChannel: string,
  ) {
    this.web = new WebClient(token);
  }

  /** Confirm the bot token works; returns the bot identity. */
  async whoami(): Promise<{ team: string; user: string }> {
    const res = await this.web.auth.test();
    return { team: String(res.team), user: String(res.user) };
  }

  /** Post a message (Block Kit blocks + fallback text) to a channel. */
  async post(args: { blocks?: KnownBlock[]; text: string; channel?: string }): Promise<void> {
    await this.web.chat.postMessage({
      channel: args.channel ?? this.defaultChannel,
      text: args.text,
      ...(args.blocks ? { blocks: args.blocks } : {}),
    });
  }

  /**
   * Send a direct message to a user. Opens (or reuses) the DM channel first.
   * Requires the `im:write` scope.
   */
  async dm(userId: string, text: string): Promise<void> {
    const opened = await this.web.conversations.open({ users: userId });
    const channel = opened.channel?.id;
    if (!channel) throw new Error(`Could not open DM with user ${userId}`);
    await this.web.chat.postMessage({ channel, text });
  }

  /**
   * Return the bot's own user id (cached via auth.test).
   */
  async botUserId(): Promise<string> {
    const res = await this.web.auth.test();
    return String(res.user_id);
  }

  /**
   * List this bot's own recent messages in a channel, newest first.
   * Requires `channels:history` (public) or `groups:history` (private).
   */
  private async ownMessages(channel: string, limit: number): Promise<Array<{ ts: string; text: string }>> {
    const botId = await this.botUserId();
    const history = await this.web.conversations.history({ channel, limit });
    return (history.messages ?? [])
      .filter((m) => (m as { user?: string }).user === botId)
      .map((m) => ({ ts: String((m as { ts?: string }).ts ?? ""), text: String((m as { text?: string }).text ?? "") }))
      .filter((m) => m.ts.length > 0);
  }

  /**
   * Delete recent messages posted by THIS bot in a channel.
   * Requires history scope to read and `chat:write` to delete.
   * `limit` caps how many recent messages to scan. Returns the count deleted.
   */
  async deleteOwnMessages(channel: string, limit = 50): Promise<number> {
    const mine = await this.ownMessages(channel, limit);
    let deleted = 0;
    for (const m of mine) {
      try {
        await this.web.chat.delete({ channel, ts: m.ts });
        deleted++;
      } catch {
        // Skip messages we can't delete (e.g. not authored by this app).
      }
    }
    return deleted;
  }

  /**
   * Delete only the SINGLE most-recent message posted by this bot in a channel.
   * Returns the deleted message's text, or null if the bot has no recent message.
   */
  async deleteLastOwnMessage(channel: string): Promise<string | null> {
    const mine = await this.ownMessages(channel, 30);
    const last = mine[0]; // history is newest-first
    if (!last) return null;
    await this.web.chat.delete({ channel, ts: last.ts });
    return last.text || "(no text)";
  }
}
