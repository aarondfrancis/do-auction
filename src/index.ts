import { DurableObject } from "cloudflare:workers";

export class AuctionRoom extends DurableObject {
  private title: string | null = null;
  private memoryCounter = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS lifecycle_counter (
          id INTEGER PRIMARY KEY,
          value INTEGER NOT NULL
        )
      `);
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

  async bumpLifecycleCounters(): Promise<{ memory: number; durable: number }> {
    this.memoryCounter += 1;

    const current =
      this.ctx.storage.sql
        .exec<{ value: number }>("SELECT value FROM lifecycle_counter WHERE id = 1")
        .toArray()[0]?.value ?? 0;

    const next = current + 1;
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO lifecycle_counter (id, value) VALUES (1, ?)",
      next,
    );

    return { memory: this.memoryCounter, durable: next };
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    const auctionId = url.searchParams.get("auctionId");
    if (!auctionId) return new Response("Missing auctionId", { status: 400 });

    if (request.method === "POST") {
      const body = (await request.json()) as { title?: string };
      if (!body.title) {
        return new Response("Invalid payload", { status: 400 });
      }

      const stub = env.AUCTION.getByName(auctionId);
      await stub.initAuction({ title: body.title });
      return new Response(null, { status: 204 });
    }

    // GET /bump?auctionId=... — lifecycle demo
    if (url.pathname === "/bump") {
      const stub = env.AUCTION.getByName(auctionId);
      const counters = await stub.bumpLifecycleCounters();
      return Response.json(counters);
    }

    const stub = env.AUCTION.getByName(auctionId);
    const details = await stub.getDetails();
    return Response.json(details);
  },
} satisfies ExportedHandler<Env>;
