import { DurableObject } from "cloudflare:workers";

const AUCTION_STATUSES = ["draft", "upcoming", "active", "ended", "settled", "cancelled"] as const;
type AuctionStatus = (typeof AUCTION_STATUSES)[number];

const LEGAL_TRANSITIONS: Record<AuctionStatus, AuctionStatus[]> = {
  draft: ["upcoming", "active", "cancelled"],
  upcoming: ["active", "cancelled"],
  active: ["ended", "cancelled"],
  ended: ["settled"],
  settled: [],
  cancelled: [],
};

function isAuctionStatus(value: string): value is AuctionStatus {
  return AUCTION_STATUSES.includes(value as AuctionStatus);
}

const ANTI_SNIPE_WINDOW_MS = 30_000;
const ANTI_SNIPE_EXTENSION_MS = 30_000;

export class AuctionRoom extends DurableObject {
  private socketMetadata = new Map<WebSocket, { userId: string; joinedAt: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.ctx.blockConcurrencyWhile(async () => {
      try {
        this.ctx.storage.sql.exec(`
          CREATE TABLE IF NOT EXISTS auction_state (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL,
            starting_price INTEGER NOT NULL,
            reserve_price INTEGER NOT NULL,
            current_price INTEGER NOT NULL,
            winner_user_id TEXT,
            start_time INTEGER,
            end_time INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );

          CREATE TABLE IF NOT EXISTS bids (
            id TEXT PRIMARY KEY,
            auction_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            amount INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            idempotency_key TEXT NOT NULL UNIQUE
          );

          CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            run_at INTEGER NOT NULL,
            type TEXT NOT NULL,
            payload_json TEXT NOT NULL
          );

          CREATE INDEX IF NOT EXISTS bids_by_created
            ON bids (created_at DESC);

          CREATE INDEX IF NOT EXISTS bids_by_amount
            ON bids (amount DESC);

          CREATE UNIQUE INDEX IF NOT EXISTS bids_idempotency_scope
            ON bids (user_id, idempotency_key);
        `);
      } catch (error) {
        console.error("init failed", error);
        throw error;
      }

      this.rebuildSocketMetadata();

      this.ctx.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair("ping", "pong"),
      );
    });
  }

  private rebuildSocketMetadata() {
    this.socketMetadata.clear();

    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as
        | { userId: string; joinedAt: number }
        | null;
      if (attachment) {
        this.socketMetadata.set(ws, attachment);
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const upgrade = request.headers.get("Upgrade");
    if (!upgrade || upgrade.toLowerCase() !== "websocket") {
      return new Response("Expected websocket", { status: 426 });
    }

    const userId = request.headers.get("x-authenticated-user-id");
    if (!userId) {
      return new Response("Missing websocket identity", { status: 401 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    const metadata = { userId, joinedAt: Date.now() };
    server.serializeAttachment(metadata);
    this.socketMetadata.set(server, metadata);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private broadcast(event: Record<string, unknown>) {
    const payload = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        // Connection closed between getWebSockets() and send()
      }
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const metadata = this.socketMetadata.get(ws);
    const userId = metadata?.userId ?? "unknown";

    if (typeof message === "string") {
      try {
        const parsed = JSON.parse(message) as {
          type?: string;
          messages?: Array<Record<string, unknown>>;
        };

        if (parsed.type === "batch" && Array.isArray(parsed.messages)) {
          if (parsed.messages.length > 100) {
            ws.send(JSON.stringify({ type: "error", message: "Batch too large" }));
            return;
          }

          for (const item of parsed.messages) {
            this.broadcast({ type: "client_event", from: userId, payload: item });
          }
          return;
        }
      } catch {
        // Not JSON — fall through to echo
      }
    }

    ws.send(JSON.stringify({ type: "echo", userId, message }));
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    this.socketMetadata.delete(ws);
    ws.close(code, reason);
  }

  async webSocketError(ws: WebSocket, error: unknown) {
    this.socketMetadata.delete(ws);
    console.error("WebSocket error:", error);
  }

  async initAuction(input: {
    title: string;
    startingPrice: number;
    startTime?: number | null;
    endTime?: number | null;
  }) {
    const now = Date.now();
    const startTime = input.startTime ?? null;
    const endTime = input.endTime ?? null;
    const status: AuctionStatus =
      typeof startTime === "number" && startTime > now ? "upcoming" : "active";

    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO auction_state
        (id, title, status, starting_price, reserve_price, current_price, start_time, end_time, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      this.ctx.id.toString(),
      input.title,
      status,
      input.startingPrice,
      input.startingPrice,
      input.startingPrice,
      startTime,
      endTime,
      now,
      now,
    );

    await this.reconcileAlarmSchedule();
  }

  async getDetails() {
    return this.ctx.storage.sql
      .exec<{
        id: string;
        title: string;
        status: string;
        starting_price: number;
        current_price: number;
        created_at: number;
      }>(
        "SELECT id, title, status, starting_price, current_price, created_at FROM auction_state WHERE id = ?",
        this.ctx.id.toString(),
      )
      .one();
  }

  async placeBid(input: { userId: string; amount: number; idempotencyKey: string }) {
    const state = this.ctx.storage.sql
      .exec<{ status: string; current_price: number }>(
        "SELECT status, current_price FROM auction_state WHERE id = ?",
        this.ctx.id.toString(),
      )
      .toArray()[0];

    if (!state) throw new Error("AUCTION_NOT_FOUND");
    if (state.status !== "active") throw new Error("AUCTION_NOT_ACTIVE");
    if (input.amount <= state.current_price) throw new Error("BID_TOO_LOW");

    const now = Date.now();

    this.ctx.storage.sql.exec(
      `INSERT INTO bids (id, auction_id, user_id, amount, created_at, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(),
      this.ctx.id.toString(),
      input.userId,
      input.amount,
      now,
      input.idempotencyKey,
    );

    this.ctx.storage.sql.exec(
      "UPDATE auction_state SET current_price = ?, winner_user_id = ?, updated_at = ? WHERE id = ?",
      input.amount,
      input.userId,
      now,
      this.ctx.id.toString(),
    );

    this.broadcast({
      type: "bid_placed",
      auctionId: this.ctx.id.toString(),
      userId: input.userId,
      amount: input.amount,
    });

    this.maybeApplyAntiSnipeExtension(now);
    await this.reconcileAlarmSchedule();

    return {
      accepted: true,
      currentPrice: input.amount,
      winnerUserId: input.userId,
    };
  }

  private maybeApplyAntiSnipeExtension(now: number) {
    const row = this.ctx.storage.sql
      .exec<{ status: string; end_time: number | null }>(
        "SELECT status, end_time FROM auction_state WHERE id = ?",
        this.ctx.id.toString(),
      )
      .toArray()[0];

    if (!row || row.status !== "active" || typeof row.end_time !== "number") {
      return;
    }

    if (row.end_time - now > ANTI_SNIPE_WINDOW_MS) {
      return;
    }

    const nextEndTime = row.end_time + ANTI_SNIPE_EXTENSION_MS;
    this.ctx.storage.sql.exec(
      "UPDATE auction_state SET end_time = ?, updated_at = ? WHERE id = ?",
      nextEndTime,
      now,
      this.ctx.id.toString(),
    );

    this.broadcast({
      type: "auction_extended",
      auctionId: this.ctx.id.toString(),
      newEndTime: nextEndTime,
    });
  }

  getHistory(limit = 50, offset = 0) {
    return this.ctx.storage.sql
      .exec<{ user_id: string; amount: number; created_at: number }>(
        "SELECT user_id, amount, created_at FROM bids ORDER BY created_at DESC LIMIT ? OFFSET ?",
        limit,
        offset,
      )
      .toArray();
  }

  async transitionState(nextStatus: string) {
    if (!isAuctionStatus(nextStatus)) {
      throw new Error("INVALID_AUCTION_STATUS");
    }

    const current = this.ctx.storage.sql
      .exec<{ status: string }>(
        "SELECT status FROM auction_state WHERE id = ?",
        this.ctx.id.toString(),
      )
      .toArray()[0];

    if (!current) throw new Error("AUCTION_NOT_FOUND");
    if (!isAuctionStatus(current.status)) throw new Error("INVALID_AUCTION_STATUS");

    if (!LEGAL_TRANSITIONS[current.status].includes(nextStatus)) {
      throw new Error(`ILLEGAL_TRANSITION:${current.status}->${nextStatus}`);
    }

    const now = Date.now();
    this.ctx.storage.sql.exec(
      "UPDATE auction_state SET status = ?, updated_at = ? WHERE id = ?",
      nextStatus,
      now,
      this.ctx.id.toString(),
    );

    await this.reconcileAlarmSchedule();

    return { status: nextStatus };
  }

  private async reconcileAlarmSchedule() {
    const now = Date.now();

    const state = this.ctx.storage.sql
      .exec<{ status: string; start_time: number | null; end_time: number | null }>(
        "SELECT status, start_time, end_time FROM auction_state WHERE id = ?",
        this.ctx.id.toString(),
      )
      .toArray()[0];

    if (!state) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    // Determine next alarm time based on current state
    if (state.status === "upcoming" && typeof state.start_time === "number") {
      await this.ctx.storage.setAlarm(Math.max(state.start_time, now));
      return;
    }

    if (state.status === "active" && typeof state.end_time === "number") {
      await this.ctx.storage.setAlarm(Math.max(state.end_time, now));
      return;
    }

    // No alarm needed for ended/settled/cancelled
    await this.ctx.storage.deleteAlarm();
  }

  async alarm(alarmInfo?: { retryCount: number; isRetry: boolean }) {
    try {
      const now = Date.now();
      const state = this.ctx.storage.sql
        .exec<{ status: string; start_time: number | null; end_time: number | null }>(
          "SELECT status, start_time, end_time FROM auction_state WHERE id = ?",
          this.ctx.id.toString(),
        )
        .toArray()[0];

      if (!state) return;

      if (state.status === "upcoming" && (state.start_time === null || state.start_time <= now)) {
        await this.transitionState("active");
        this.broadcast({ type: "auction_started", auctionId: this.ctx.id.toString() });
      }

      if (state.status === "active" && typeof state.end_time === "number" && state.end_time <= now) {
        await this.transitionState("ended");
        this.broadcast({ type: "auction_ended", auctionId: this.ctx.id.toString() });
      }
    } catch (error) {
      // After 5 retries, schedule a fresh alarm instead of relying on built-in backoff
      if ((alarmInfo?.retryCount ?? 0) >= 5) {
        await this.ctx.storage.setAlarm(Date.now() + 30_000);
        return;
      }

      throw error;
    }
  }
}
