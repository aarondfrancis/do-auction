import { DurableObject } from "cloudflare:workers";

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

  async initAuction(input: { title: string; startingPrice: number }) {
    const now = Date.now();

    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO auction_state
        (id, title, status, starting_price, reserve_price, current_price, created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?, ?, ?, ?)`,
      this.ctx.id.toString(),
      input.title,
      input.startingPrice,
      input.startingPrice,
      input.startingPrice,
      now,
      now,
    );
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

  placeBid(input: { userId: string; amount: number; idempotencyKey: string }) {
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

    return {
      accepted: true,
      currentPrice: input.amount,
      winnerUserId: input.userId,
    };
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
}
