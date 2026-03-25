import { DurableObject } from "cloudflare:workers";

export class AuctionRoom extends DurableObject {
  async getDetails() {
    return {
      auctionId: this.ctx.id.toString(),
      status: "not initialized",
    };
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    const auctionId = url.searchParams.get("auctionId");
    if (!auctionId) return new Response("Missing auctionId", { status: 400 });

    const stub = env.AUCTION.getByName(auctionId);
    const details = await stub.getDetails();
    return Response.json(details);
  },
} satisfies ExportedHandler<Env>;
