import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

async function getScheduledAlarm(stub: any): Promise<number | null> {
  return runInDurableObject(
    stub,
    async (_instance, state) => state.storage.getAlarm()
  );
}

describe("auction lifecycle", () => {
  it("creates an auction and reads it back", async () => {
    const stub = env.AUCTION.getByName(`test-${crypto.randomUUID()}`);

    await stub.initAuction({ title: "Test Auction", startingPrice: 100 });

    const details = await stub.getDetails();

    expect(details.title).toBe("Test Auction");
    expect(details.status).toBe("active");
    expect(details.starting_price).toBe(100);
    expect(details.current_price).toBe(100);
  });

  it("places a bid and updates current price", async () => {
    const stub = env.AUCTION.getByName(`bid-${crypto.randomUUID()}`);
    await stub.initAuction({ title: "Bid Test", startingPrice: 100 });

    const result = await stub.placeBid({
      userId: "alice",
      amount: 150,
      idempotencyKey: crypto.randomUUID(),
    });

    expect(result.accepted).toBe(true);
    expect(result.currentPrice).toBe(150);
    expect(result.winnerUserId).toBe("alice");

    const details = await stub.getDetails();
    expect(details.current_price).toBe(150);
  });

  it("enforces legal state transitions", async () => {
    const stub = env.AUCTION.getByName(`state-${crypto.randomUUID()}`);
    await stub.initAuction({ title: "State Test", startingPrice: 100 });

    await stub.transitionState("ended");
    expect((await stub.getDetails()).status).toBe("ended");

    await stub.transitionState("settled");
    expect((await stub.getDetails()).status).toBe("settled");
  });
});

describe("auction alarms", () => {
  it("transitions upcoming to active when start time passes", async () => {
    const stub = env.AUCTION.getByName(`alarm-start-${crypto.randomUUID()}`);
    const now = Date.now();

    await stub.initAuction({
      title: "Timed Auction",
      startingPrice: 100,
      startTime: now + 60_000,
      endTime: now + 120_000,
    });

    expect((await stub.getDetails()).status).toBe("upcoming");
    expect(await getScheduledAlarm(stub)).toBe(now + 60_000);

    // Move start time to the past so alarm fires the transition
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE auction_state SET start_time = ?, updated_at = ?",
        Date.now() - 1_000,
        Date.now(),
      );
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await stub.getDetails()).status).toBe("active");
  });

  it("is safe to run alarm twice after auction has ended", async () => {
    const stub = env.AUCTION.getByName(`alarm-dup-${crypto.randomUUID()}`);

    await stub.initAuction({
      title: "Dup Alarm Test",
      startingPrice: 100,
      endTime: Date.now() - 1_000,
    });

    await runInDurableObject(stub, async (instance) => {
      await instance.alarm({ retryCount: 0, isRetry: false });
    });

    expect((await stub.getDetails()).status).toBe("ended");

    // Run again — should be a no-op
    await runInDurableObject(stub, async (instance) => {
      await instance.alarm({ retryCount: 1, isRetry: true });
    });
    
    expect((await stub.getDetails()).status).toBe("ended");
  });
});
