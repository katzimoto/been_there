#!/usr/bin/env node
/**
 * Verifies a subagent's delivery claims mechanically.
 *
 * The rule this exists to enforce: an agent's report is a hypothesis. Two agents
 * in one session reported deliverables that did not exist — a 68 KB research
 * file that was never written, and a finished document returned as prose because
 * the agent had no write tool. Both reports were detailed and plausible. A
 * language model asked whether a subagent's work exists is not a reliable
 * oracle for that question; a `stat` is.
 *
 * Usage:
 *   node scripts/dev/check-agent-claims.mjs claims.txt
 *   node scripts/dev/check-agent-claims.mjs --from-report report.md
 *
 * Claims file format, one per line, `#` for comments and blank lines ignored:
 *
 *   file      packages/foo/src/bar.ts
 *   symbol    packages/foo/src/bar.ts:42 verifyDomainContract
 *   command   npx vitest run packages/foo
 *
 * `symbol` checks that the file has at least that many lines and that the named
 * identifier appears at or after that line. `command` runs in a shell and fails
 * on a non-zero exit.
 */
import { execSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { exit } from 'node:process';

const ROOT = resolve(import.meta.dirname, '..', '..');

/**
 * Pull `path:line` and `path` references out of a free-text agent report so the
 * coordinator does not transcribe them by hand — transcription is where this
 * check would otherwise be skipped.
 */
function claimsFromReport(text) {
  const claims = [];
  const seen = new Set();
  for (const match of text.matchAll(
    /\b((?:packages|scripts|docs|skills)\/[\w./-]+\.(?:ts|tsx|mjs|js|md|json|yml))\b(?::(\d+))?/g,
  )) {
    const [, file, line] = match;
    const key = `${file}:${line ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    claims.push(line ? { kind: 'symbol', file, line: Number(line) } : { kind: 'file', file });
  }
  return claims;
}

function checkFile(file) {
  const full = join(ROOT, file);
  try {
    const stats = statSync(full);
    if (!stats.isFile()) {
      return `${file}: exists but is not a file`;
    }
    if (stats.size === 0) {
      return `${file}: exists but is empty — a zero-byte file is not a deliverable`;
    }
    return null;
  } catch {
    return `${file}: DOES NOT EXIST — this claim is false`;
  }
}

function checkSymbol(file, line, symbol) {
  const fileProblem = checkFile(file);
  if (fileProblem) {
    return fileProblem;
  }
  const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
  if (lines.length < line) {
    return `${file}:${line} ${symbol}: file has only ${lines.length} lines, so line ${line} cannot exist`;
  }
  const from = lines.slice(line - 1).join('\n');
  if (!from.includes(symbol)) {
    const foundAt = lines.findIndex((l) => l.includes(symbol));
    return (
      `${file}:${line} ${symbol}: not found at or after that line` +
      (foundAt >= 0 ? ` (it appears at line ${foundAt + 1})` : ' (it appears nowhere in the file)')
    );
  }
  return null;
}

function checkCommand(command) {
  try {
    execSync(command, { cwd: ROOT, stdio: 'pipe', timeout: 300_000 });
    return null;
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim().split('\n').slice(-6).join('\n');
    return `command failed: ${command}\n      ${output.replace(/\n/g, '\n      ')}`;
  }
}

const args = process.argv.slice(2);
if (args.length === 0 || args.includes('--help')) {
  console.log(
    [
      'Usage:',
      '  node scripts/dev/check-agent-claims.mjs <claims-file>',
      '  node scripts/dev/check-agent-claims.mjs --from-report <report-file>',
      '',
      'Claim kinds: file <path> | symbol <path>:<line> <identifier> | command <shell command>',
    ].join('\n'),
  );
  exit(args.length === 0 ? 1 : 0);
}

let claims = [];
const reportIndex = args.indexOf('--from-report');
if (reportIndex !== -1) {
  const reportPath = args[reportIndex + 1];
  if (!reportPath) {
    console.error('--from-report needs a file path.');
    exit(1);
  }
  claims = claimsFromReport(readFileSync(resolve(process.cwd(), reportPath), 'utf8'));
} else {
  const text = readFileSync(resolve(process.cwd(), args[0]), 'utf8');
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const [kind, ...rest] = line.split(/\s+/);
    if (kind === 'symbol') {
      const [location, symbol] = rest;
      const at = location.lastIndexOf(':');
      claims.push({
        kind: 'symbol',
        file: location.slice(0, at),
        line: Number(location.slice(at + 1)),
        symbol,
      });
    } else if (kind === 'file' || kind === 'command') {
      claims.push({ kind, value: rest.join(' ') });
    } else {
      console.error(`Unrecognised claim kind '${kind}' in: ${line}`);
      exit(1);
    }
  }
}

if (claims.length === 0) {
  console.error('No claims found. A claims file with nothing in it verifies nothing.');
  exit(1);
}

const problems = claims
  .map((claim) => {
    if (claim.kind === 'file') {
      return checkFile(claim.value);
    }
    if (claim.kind === 'symbol') {
      return checkSymbol(claim.file, claim.line, claim.symbol);
    }
    return checkCommand(claim.value);
  })
  .filter((problem) => problem !== null);

console.log(`Checked ${claims.length} claim(s) from ${reportIndex !== -1 ? 'a report' : 'a claims file'}.`);
if (problems.length > 0) {
  console.error(`\n${problems.length} claim(s) could not be verified:\n`);
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  console.error('\nThese claims are false. Do not report the work as delivered.');
  exit(1);
}
console.log('All claims verified.');
