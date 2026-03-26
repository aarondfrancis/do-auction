import { DurableObject } from "cloudflare:workers";

export class AuctionRoom extends DurableObject {
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
    });
  }

  async fetch(request: Request): Promise<Response> {
    const upgrade = request.headers.get("Upgrade");
    if (!upgrade || upgrade.toLowerCase() !== "websocket") {
      return new Response("Expected websocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
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
