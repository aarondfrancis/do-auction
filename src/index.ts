import { DurableObject } from "cloudflare:workers";

export class AuctionRoom extends DurableObject {
  private title: string | null = null;

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

    const stub = env.AUCTION.getByName(auctionId);
    const details = await stub.getDetails();
    return Response.json(details);
  },
} satisfies ExportedHandler<Env>;
