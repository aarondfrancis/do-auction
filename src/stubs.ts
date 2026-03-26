import type {AuctionRoom} from "./auction-room";

export async function callAuction<T>(
  env: Env,
  auctionId: string,
  fn: (stub: DurableObjectStub<AuctionRoom>) => Promise<T>,
): Promise<T> {
  try {
    const stub = env.AUCTION.getByName(auctionId);
    throw new Error("oh no")
    return await fn(stub);
  } catch (error) {
    // Stub may be broken after an exception — recreate before retry
    const retryStub = env.AUCTION.getByName(auctionId);
    return await fn(retryStub);
  }
}
