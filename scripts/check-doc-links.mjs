#!/usr/bin/env node
/**
 * Verifies that every relative link in the documentation resolves to a file that
 * exists, and that the documentation map lists the documents that exist.
 *
 * Six agents wrote documentation in parallel without seeing each other's work,
 * which is exactly how a spec ends up linking a document that was never written.
 * This is the cheap check that catches it before review does.
 *
 *   node scripts/check-doc-links.mjs
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { exit } from 'node:process';

const ROOT = resolve(import.meta.dirname, '..');
const DOC_DIRS = ['docs', '.'];

function markdownFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...markdownFiles(full));
    } else if (entry.endsWith('.md')) {
      found.push(full);
    }
  }
  return found;
}

const files = DOC_DIRS.flatMap((dir) => {
  const full = join(ROOT, dir);
  return existsSync(full) ? markdownFiles(full) : [];
});

const problems = [];
let linkCount = 0;

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1];
    // External, anchor-only and mailto links are not ours to verify.
    if (/^(https?:|mailto:|#)/.test(target)) {
      continue;
    }
    const [pathPart] = target.split('#');
    if (pathPart === '') {
      continue;
    }
    linkCount += 1;
    const resolved = resolve(dirname(file), pathPart);
    if (!existsSync(resolved)) {
      problems.push(`dead link: ${relative(ROOT, file)} -> ${target}`);
    }
  }
}

// docs/README.md is the map; every document it lists should exist, and every
// architecture or feature document should be reachable from it.
const map = join(ROOT, 'docs/README.md');
if (existsSync(map)) {
  const mapText = readFileSync(map, 'utf8');
  const listed = new Set(
    [...mapText.matchAll(/\]\((\.\/[^)#]+\.md)\)/g)].map((m) =>
      resolve(dirname(map), m[1]),
    ),
  );
  for (const file of files) {
    const rel = relative(ROOT, file);
    if (rel.startsWith('docs/architecture/') || rel.startsWith('docs/features/')) {
      if (!listed.has(file) && rel !== 'docs/README.md') {
        problems.push(`not listed in docs/README.md: ${rel}`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`Documentation check failed (${problems.length} problem(s)):\n`);
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  exit(1);
}

console.log(`Documentation check passed: ${files.length} files, ${linkCount} relative links resolved.`);
