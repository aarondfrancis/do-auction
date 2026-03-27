import { AuthError, requireAuth } from "./auth";
import { callAuction } from "./stubs";

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

      await callAuction(env, body.auctionId, (stub) =>
        stub.initAuction({ title: body.title!, startingPrice: body.startingPrice! }),
      );
      return new Response(null, { status: 201 });
    }

    // GET /auctions/:id — auction details
    const detailsMatch = pathname.match(/^\/auctions\/([^/]+)$/);
    if (request.method === "GET" && detailsMatch) {
      try {
        const details = await callAuction(env, detailsMatch[1], (stub) =>
          stub.getDetails(),
        );
        return Response.json(details);
      } catch (e: any) {
        if (e.message?.includes("AUCTION_NOT_FOUND")) {
          return new Response("Not found", { status: 404 });
        }
        throw e;
      }
    }

    // POST /auctions/:id/bids — place a bid (authenticated)
    const bidMatch = pathname.match(/^\/auctions\/([^/]+)\/bids$/);
    if (request.method === "POST" && bidMatch) {
      const { userId } = requireAuth(request);

      const body = (await request.json()) as {
        amount?: number;
        idempotencyKey?: string;
      };
      if (!body.amount || !body.idempotencyKey) {
        return new Response("Invalid payload", { status: 400 });
      }

      try {
        const result = await callAuction(env, bidMatch[1], (stub) =>
          stub.placeBid({
            userId,
            amount: body.amount!,
            idempotencyKey: body.idempotencyKey!,
          }),
        );
        return Response.json(result);
      } catch (e: any) {
        if (e instanceof AuthError) return new Response(e.message, { status: e.status });
        if (e.message === "AUCTION_NOT_FOUND") return new Response("Not found", { status: 404 });
        if (e.message === "AUCTION_NOT_ACTIVE") return new Response("Auction not active", { status: 409 });
        if (e.message === "BID_TOO_LOW") return new Response("Bid too low", { status: 409 });
        throw e;
      }
    }

    // GET /auctions/:id/ws — WebSocket upgrade
    const wsMatch = pathname.match(/^\/auctions\/([^/]+)\/ws$/);
    if (wsMatch) {
      const { userId } = requireAuth(request);

      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected websocket", { status: 426 });
      }

      const stub = env.AUCTION.getByName(wsMatch[1]);
      const trustedRequest = new Request(request.url, request);
      trustedRequest.headers.set("x-authenticated-user-id", userId);
      return await stub.fetch(trustedRequest);
    }

    // POST /auctions/:id/state — transition auction state
    const stateMatch = pathname.match(/^\/auctions\/([^/]+)\/state$/);
    if (request.method === "POST" && stateMatch) {
      const body = (await request.json()) as { status?: string };
      if (!body.status) {
        return new Response("Invalid payload", { status: 400 });
      }

      try {
        const result = await callAuction(env, stateMatch[1], (stub) =>
          stub.transitionState(body.status!),
        );
        return Response.json(result);
      } catch (e: any) {
        if (e.message === "AUCTION_NOT_FOUND") return new Response("Not found", { status: 404 });
        if (e.message === "INVALID_AUCTION_STATUS") return new Response("Invalid status", { status: 400 });
        if (e.message?.startsWith("ILLEGAL_TRANSITION")) return new Response(e.message, { status: 409 });
        throw e;
      }
    }

    // GET /auctions/:id/history — bid history
    const historyMatch = pathname.match(/^\/auctions\/([^/]+)\/history$/);
    if (request.method === "GET" && historyMatch) {
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const history = await callAuction(env, historyMatch[1], (stub) =>
        stub.getHistory(limit, offset),
      );
      return Response.json(history);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
