import { DurableObject } from "cloudflare:workers";

export class AuctionRoom extends DurableObject {
  private title: string | null = null;

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
        `);
      } catch (error) {
        console.error("init failed", error);
        throw error;
      }
    });
  }

  async initAuction(input: { title: string }) {
    this.title = input.title;
  }

  async getDetails() {
    return {
      auctionId: this.ctx.id.toString(),
      title: this.title,
      status: this.title ? "active" : "not initialized",
    };
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

  listRecentBids() {
    return this.ctx.storage.sql
      .exec<{ user_id: string; amount: number; created_at: number }>(
        "SELECT user_id, amount, created_at FROM bids ORDER BY created_at DESC LIMIT 20"
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
      const body = (await request.json()) as { title?: string };
      if (!body.title) {
        return new Response("Invalid payload", { status: 400 });
      }

      const stub = env.AUCTION.getByName(auctionId);
      await stub.initAuction({ title: body.title });
      return new Response(null, { status: 204 });
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

    // GET /bids?auctionId=... — list recent bids
    if (url.pathname === "/bids") {
      const stub = env.AUCTION.getByName(auctionId);
      const bids = await stub.listRecentBids();
      return Response.json(bids);
    }

    const stub = env.AUCTION.getByName(auctionId);
    const details = await stub.getDetails();
    return Response.json(details);
  },
} satisfies ExportedHandler<Env>;
