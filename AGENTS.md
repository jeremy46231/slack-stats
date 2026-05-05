# AGENTS.md

## Commands
- Runtime: Bun (TypeScript + JSX, ESM). Entry: `bun run src/main.ts`.
- Prisma: `bun run generate` (prisma generate), `bun run migrate` (prisma migrate dev).
- Scripts: `bun run scripts/getRecords.ts`, `bun run scripts/updateUsers.ts`.
- For type checks run `bunx tsc --noEmit`. Format with `bunx prettier -w <file>`.

## Style
- Prettier: 2-space, no semicolons, single quotes, ES5 trailing commas, consistent quoteProps.
- TS strict + `noUnusedLocals`/`noUnusedParameters`/`noPropertyAccessFromIndexSignature`; `verbatimModuleSyntax` (use `import type` for types).
- Always include `.ts`/`.tsx` extensions in relative imports. ESM only.
- Use `temporal-polyfill` (`Temporal.*`) for dates, not `Date`.
- camelCase for vars/functions, PascalCase for React components/types, snake_case for DB columns (matches Prisma schema).
- Errors: wrap top-level task calls in try/catch and `console.error`; let Bolt/Prisma errors bubble inside handlers.
