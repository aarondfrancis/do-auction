import {DurableObject} from "cloudflare:workers";

export class AuctionRoom extends DurableObject {
  async getStatus(): Promise<string> {
    return "auction not initialized";
  }
}

export default {
  async fetch(_request: Request, env: Env) {
    const stub = env.AUCTION.getByName("demo-auction");
    const status = await stub.getStatus();
    return new Response(status);
  },
} satisfies ExportedHandler<Env>;
