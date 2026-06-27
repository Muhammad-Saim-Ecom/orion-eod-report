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
}
