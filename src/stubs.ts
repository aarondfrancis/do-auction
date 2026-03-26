import type { AuctionRoom } from "./auction-room";

export async function callAuction<T>(
  env: Env,
  auctionId: string,
  fn: (stub: DurableObjectStub<AuctionRoom>) => Promise<T>,
  maxAttempts = 3,
): Promise<T> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const stub = env.AUCTION.getByName(auctionId);
    try {
      return await fn(stub);
    } catch (error) {
      const err = error as Error & { retryable?: boolean; overloaded?: boolean };
      const shouldRetry = err.retryable === true && err.overloaded !== true;

      if (!shouldRetry || attempt === maxAttempts - 1) {
        throw error;
      }

      const backoffMs = Math.min(20_000, 100 * Math.random() * 2 ** attempt);
      await scheduler.wait(backoffMs);
    }
  }

  throw new Error("unreachable");
}
