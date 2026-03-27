/// <reference path="../node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts" />

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}
