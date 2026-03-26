import { AuctionRoom } from "./auction-room";

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    const { pathname } = url;

    // POST /auctions — create an auction
    if (request.method === "POST" && pathname === "/auctions") {
      const body = (await request.json()) as {
        auctionId?: string;
        title?: string;
        startingPrice?: number;
      };
      if (!body.auctionId || !body.title || !body.startingPrice) {
        return new Response("Invalid payload", { status: 400 });
      }

      const stub = env.AUCTION.getByName(body.auctionId);
      await stub.initAuction({ title: body.title, startingPrice: body.startingPrice });
      return new Response(null, { status: 201 });
    }

    // GET /auctions/:id — auction details
    const detailsMatch = pathname.match(/^\/auctions\/([^/]+)$/);
    if (request.method === "GET" && detailsMatch) {
      const stub = env.AUCTION.getByName(detailsMatch[1]);
      try {
        return Response.json(await stub.getDetails());
      } catch (e: any) {
        if (e.message?.includes("AUCTION_NOT_FOUND")) {
          return new Response("Not found", { status: 404 });
        }
        throw e;
      }
    }

    // POST /auctions/:id/bids — place a bid
    const bidMatch = pathname.match(/^\/auctions\/([^/]+)\/bids$/);
    if (request.method === "POST" && bidMatch) {
      const body = (await request.json()) as {
        userId?: string;
        amount?: number;
        idempotencyKey?: string;
      };
      if (!body.userId || !body.amount || !body.idempotencyKey) {
        return new Response("Invalid payload", { status: 400 });
      }

      const stub = env.AUCTION.getByName(bidMatch[1]);
      try {
        const result = await stub.placeBid({
          userId: body.userId,
          amount: body.amount,
          idempotencyKey: body.idempotencyKey,
        });
        return Response.json(result);
      } catch (e: any) {
        if (e.message === "AUCTION_NOT_FOUND") return new Response("Not found", { status: 404 });
        if (e.message === "AUCTION_NOT_ACTIVE") return new Response("Auction not active", { status: 409 });
        if (e.message === "BID_TOO_LOW") return new Response("Bid too low", { status: 409 });
        throw e;
      }
    }

    // GET /auctions/:id/history — bid history
    const historyMatch = pathname.match(/^\/auctions\/([^/]+)\/history$/);
    if (request.method === "GET" && historyMatch) {
      const stub = env.AUCTION.getByName(historyMatch[1]);
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      return Response.json(await stub.getHistory(limit, offset));
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
