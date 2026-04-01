# do-auction

`do-auction` is a compendium for the Durable Objects series at
<https://databaseschool.com/series/durable-objects>.

This repository contains a Cloudflare Workers + Durable Objects auction
implementation built up over the course of the series, including:

- authenticated bid placement
- Durable Object state persisted to SQLite
- alarm-driven auction lifecycle transitions
- WebSocket updates for live watchers
- Vitest coverage for the auction behavior

## What are Durable Objects?

Durable Objects are Cloudflare's stateful compute primitive. Each object gives
you a globally addressable coordination point with strongly consistent storage,
which makes them a good fit for auctions, chat rooms, multiplayer state, and
other real-time workflows where one logical thing needs a single source of
truth.

## Cloudflare docs

- [Cloudflare Workers overview](https://developers.cloudflare.com/workers/)
- [Durable Objects overview](https://developers.cloudflare.com/durable-objects/)
- [Get started with Durable Objects](https://developers.cloudflare.com/durable-objects/get-started/)
- [Durable Objects storage and SQLite](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)
- [Durable Objects alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
- [Workers WebSockets](https://developers.cloudflare.com/workers/runtime-apis/websockets/)

## Development

Install dependencies:

```bash
npm install
```

Run the worker locally:

```bash
npm run dev
```

Run the full verification suite:

```bash
npm run verify
```
