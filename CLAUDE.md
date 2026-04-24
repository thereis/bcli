---
description: Use pnpm instead of Node.js, npm, or vite.
globs: '*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json'
alwaysApply: false
---

Default to using pnpm instead of Node.js.

- Use `pnpm <file>` instead of `node <file>` or `ts-node <file>`
- Use `pnpm test` instead of `jest` or `vitest`
- Use `pnpm build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `pnpm install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `pnpm run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `pnpmx <package> <command>` instead of `npx <package> <command>`
- pnpm automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Handler convention

Handlers under `src/commands/handlers/**` are pure functions that return `{ data, cta }` — where `data` is the payload and `cta` is the incur CTA object (`{ commands: [{ command, description }] }`). The registrar's `run(c)` block calls `return c.ok(result.data, { cta: result.cta })`. Never call `stdout()` / `process.stdout.write()` / `console.log` from handlers — incur serializes the returned data via `--format`. Use `logger.info/warn/error` (stderr) only for progress messages.

Commands without a meaningful follow-up return `cta: { commands: [] }`.

## Testing

Use `pnpm test` to run tests. Coverage should attend to 100% in all files, lines, branches, and functions.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```
