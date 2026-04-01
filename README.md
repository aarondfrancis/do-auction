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
