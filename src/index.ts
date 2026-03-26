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

  async initAuction(input: { title: string; startingPrice: number }) {
    const now = Date.now();

    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO auction_state
        (id, title, status, starting_price, reserve_price, current_price, created_at, updated_at)
       VALUES (?, ?, 'draft', ?, ?, ?, ?, ?)`,
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

  addBid(userId: string, amount: number) {
    this.ctx.storage.sql.exec(
      `INSERT INTO bids (id, auction_id, user_id, amount, created_at, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(),
      this.ctx.id.toString(),
      userId,
      amount,
      Date.now(),
      `demo-${crypto.randomUUID()}`,
    );
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

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    const auctionId = url.searchParams.get("auctionId");
    if (!auctionId) return new Response("Missing auctionId", { status: 400 });

    // POST /?auctionId=... — initialize an auction
    if (request.method === "POST" && url.pathname === "/") {
      const body = (await request.json()) as { title?: string; startingPrice?: number };
      if (!body.title || !body.startingPrice) {
        return new Response("Invalid payload", { status: 400 });
      }

      const stub = env.AUCTION.getByName(auctionId);
      await stub.initAuction({ title: body.title, startingPrice: body.startingPrice });
      return new Response(null, { status: 201 });
    }

    // POST /bids?auctionId=... — seed a demo bid
    if (request.method === "POST" && url.pathname === "/bids") {
      const body = (await request.json()) as { userId?: string; amount?: number };
      if (!body.userId || !body.amount) {
        return new Response("Invalid payload", { status: 400 });
      }

      const stub = env.AUCTION.getByName(auctionId);
      await stub.addBid(body.userId, body.amount);
      return new Response(null, { status: 204 });
    }

    // GET /history?auctionId=...&limit=50 — paginated bid history
    if (url.pathname === "/history") {
      const stub = env.AUCTION.getByName(auctionId);
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const history = await stub.getHistory(limit, offset);
      return Response.json(history);
    }

    const stub = env.AUCTION.getByName(auctionId);
    const details = await stub.getDetails();
    return Response.json(details);
  },
} satisfies ExportedHandler<Env>;
