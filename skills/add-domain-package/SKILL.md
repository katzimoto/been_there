---
name: add-domain-package
description: Add a new domain package to the Been There monorepo, wired into the TypeScript solution, vitest, and the architecture docs. Use when adding a domain, splitting an existing one, or when a new `packages/*` folder is not being typechecked or tested.
---

# Adding a domain package

The repository is a TypeScript solution with one package per domain. A new
package is inert until four things are true, and only the first is obvious.

## 1. Package manifest

`packages/<name>/package.json` — copy the shape of `packages/core/package.json`:

```json
{
  "name": "@been-there/<name>",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } }
}
```

`workspaces: ["packages/*"]` and `vitest.config.ts`'s
`packages/*/test/**/*.test.ts` glob already pick the package up. Run
`npm install` to create the `node_modules/@been-there/<name>` symlink — without
it, any other package importing by name fails to resolve.

## 2. TypeScript config

`packages/<name>/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "composite": true, "outDir": "./dist", "rootDir": "./src" },
  "include": ["src/**/*.ts"]
}
```

`packages/<name>/test/tsconfig.json` is a separate project — tests are not part
of the build graph but must still typecheck:

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true, "types": ["node"] },
  "include": ["**/*.ts"]
}
```

## 3. Register in the solution

Add a reference to the root `tsconfig.json`. **This is the step that is easy to
miss**, because `tsc -p packages/<name>/tsconfig.json` succeeds without it while
`npm run build` silently skips the package:

```json
{ "files": [], "references": [{ "path": "./packages/<name>" }] }
```

## 4. Document the boundary

Add a design document to `docs/architecture/` and two rows to `docs/README.md`
(the domain table and, if the package emits events, the event catalogue). The
document must state what the domain **owns** and what it **never owns** as a
table, and it inherits the eight commitments from
`docs/architecture/00-overview.md`.

## Verify

```bash
npm install                                  # link the workspace
npx tsc --build                              # solution build, including the new package
npx tsc -p packages/<name>/test/tsconfig.json # test types
npx vitest run packages/<name>
```

## Traps

- **Imports resolve to `dist`, not `src`.** Cross-package imports in tests use
  the built output. After changing a package that another package imports, run
  `npx tsc --build` before running its consumers' tests, or you will test stale
  code and draw the wrong conclusion.
- **A domain package may import `@been-there/core` and nothing else.** Cross-
  domain data arrives as an event or a read-model projection type declared
  locally in the importing package. See ADR 0003.
- **Do not add a test tsconfig to the root solution file.** It is `noEmit` and
  would fight the composite build.
