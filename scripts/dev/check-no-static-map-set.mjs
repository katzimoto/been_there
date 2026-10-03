#!/usr/bin/env node
/**
 * Fails when a `Map` or `Set` is used as a lookup over string keys that are all
 * written down in the source — the one case AGENTS.md reserves a `Record` for:
 *
 *   "No `Map`/`Set` for static string-keyed lookups. Use a `Record<K,V>`
 *    literal. `Map`/`Set` are for dynamic keys, runtime insertion or deletion, or
 *    when you need insertion order or `.size`."
 *
 * The rule was written down and nothing read it. There is no lint in this
 * repository and no test either, so the code stayed compliant by luck rather than
 * by check, which is the same failure class as a comment claiming a guard that is
 * not in the file.
 *
 * What this flags, and nothing else: a named `Map`/`Set` built from entries that
 * are all static literals in the source, never mutated in its file, whose `.size`
 * is never read, and which states no reason. Those four together are the
 * violation the rule describes, and each missing escape is one of the reasons the
 * rule itself gives for keeping the collection:
 *
 *   dynamic keys  the constructor argument is not a literal — `new Map(rows
 *                 .map(...))`, `new Set(ids)`, or a bare `new Map()` that only a
 *                 later `.set` can fill.
 *   mutation      `<name>.set/add/delete/clear(` appears in the file, or the
 *                 binding is reached through `this` or a `#private` field.
 *   `.size`       `<name>.size` is read — the count is the point.
 *   order         not decidable from an AST, so it is declared: a comment reading
 *                 `no-map: <why>` above the line or on it.
 *
 * Two deliberate limits, both of which let a violation through rather than
 * accusing a `Map` that has to stay a `Map`:
 *
 *   - mutation and `.size` are searched for by name across the whole file, so a
 *     same-named binding in a second scope excuses both;
 *   - only a *named* collection is flagged. An anonymous `new Set(['a'])` passed
 *     straight into an assertion or a spread is a value being written, not a
 *     table being consulted, and a `Record` would not be the same thing.
 *
 * Occurrences that predate the check are listed in
 * `check-no-static-map-set.baseline.json`, each with why it is left alone. A
 * baselined occurrence is reported but does not fail; an entry that no longer
 * matches anything *does* fail, because the allowlist is only allowed to shrink.
 * Baseline keys are `path#binding` rather than line numbers, so editing a file
 * above one does not expire it.
 *
 * Usage:
 *   node scripts/dev/check-no-static-map-set.mjs            # the gate
 *   node scripts/dev/check-no-static-map-set.mjs --list     # every finding
 *   node scripts/dev/check-no-static-map-set.mjs --help
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { exit } from 'node:process';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const BASELINE_PATH = join(ROOT, 'scripts', 'dev', 'check-no-static-map-set.baseline.json');
/** Membership by key. An array would also work here; a `Set` would not survive this check. */
const SKIP_DIRECTORIES = {
  '.build': true,
  '.demo': true,
  '.git': true,
  coverage: true,
  dist: true,
  node_modules: true,
};
const SOURCE_EXTENSIONS = {
  '.cjs': true,
  '.cts': true,
  '.js': true,
  '.mjs': true,
  '.mts': true,
  '.ts': true,
  '.tsx': true,
};

/** Mutation methods that mean the collection is filled or emptied at runtime. */
const MUTATION_METHOD = '(?:set|add|delete|clear)';
/** The one comment spelling that states the one reason an AST cannot decide. */
const REASON_COMMENT = /\bno-(?:map|map-set|set)\b\s*:\s*\S/;

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(
    [
      'Usage: node scripts/dev/check-no-static-map-set.mjs [--list]',
      '',
      'Fails when a named Map or Set holds only statically written keys, is never',
      'mutated in its file, has its .size never read, and states no reason.',
      '',
      '  --list   print every finding, including the baselined ones',
    ].join('\n'),
  );
  exit(0);
}
const listEverything = args.includes('--list');

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!Object.hasOwn(SKIP_DIRECTORIES, entry.name)) {
        files.push(...walk(join(dir, entry.name)));
      }
    } else if (entry.isFile() && Object.hasOwn(SOURCE_EXTENSIONS, extname(entry.name))) {
      files.push(join(dir, entry.name));
    }
  }
  return files;
}

function scriptKindFor(file) {
  const extension = extname(file);
  if (extension === '.tsx' || extension === '.jsx') {
    return ts.ScriptKind.TSX;
  }
  return extension === '.ts' || extension === '.mts' || extension === '.cts'
    ? ts.ScriptKind.TS
    : ts.ScriptKind.JS;
}

/** `x as const`, `x satisfies T` and parentheses are not part of the value. */
function unwrap(node) {
  let current = node;
  for (;;) {
    if (
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

/**
 * True when the expression is built entirely from values written in the source.
 * One identifier, one call, or one spread of something computed makes the whole
 * thing dynamic, which is the first of the rule's legitimate reasons.
 */
function isStaticValue(node) {
  const value = unwrap(node);
  if (
    ts.isStringLiteral(value) ||
    ts.isNoSubstitutionTemplateLiteral(value) ||
    ts.isNumericLiteral(value) ||
    value.kind === ts.SyntaxKind.TrueKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword ||
    value.kind === ts.SyntaxKind.NullKeyword
  ) {
    return true;
  }
  if (ts.isArrayLiteralExpression(value)) {
    return value.elements.every((element) =>
      ts.isSpreadElement(element) ? isStaticValue(element.expression) : isStaticValue(element),
    );
  }
  if (ts.isObjectLiteralExpression(value)) {
    // A shorthand property has no initialiser, and neither does a method or a
    // getter: none of them is a value written out in the source.
    return value.properties.every(
      (property) => ts.isPropertyAssignment(property) && isStaticValue(property.initializer),
    );
  }
  return false;
}

/**
 * The name the collection is bound to, structurally rather than by node type: a
 * variable declaration, an object-literal property and a class field all name
 * the binding they initialise, and nothing else does.
 */
function bindingName(newExpression) {
  const { parent } = newExpression;
  if (parent === undefined || parent.initializer !== newExpression) {
    return null;
  }
  return typeof parent.name?.text === 'string' ? parent.name.text : null;
}

function isMutated(text, name) {
  const bare = name.replace(/^#/, '');
  return (
    new RegExp(`\\b${bare}\\s*\\.\\s*${MUTATION_METHOD}\\s*\\(`).test(text) ||
    new RegExp(`(?:this\\s*\\.\\s*|#)${bare}\\s*\\.\\s*${MUTATION_METHOD}\\s*\\(`).test(text)
  );
}

function hasSizeRead(text, name) {
  return new RegExp(`\\b${name.replace(/^#/, '')}\\s*\\.\\s*size\\b`).test(text);
}

function reasonStated(lines, lineIndex) {
  return [lines[lineIndex], lines[lineIndex - 1]].some(
    (line) => line !== undefined && REASON_COMMENT.test(line),
  );
}

/** How many keys the literal writes down; 0 when there is no literal at all. */
function countWrittenKeys(newExpression) {
  const [argument] = newExpression.arguments ?? [];
  if (argument === undefined) {
    return 0;
  }
  const value = unwrap(argument);
  return ts.isArrayLiteralExpression(value) ? value.elements.length : 1;
}

function checkFile(file) {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindFor(file));
  const lines = text.split('\n');
  const findings = [];

  const visit = (node) => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      const kind = node.expression.text;
      const written = node.arguments ?? [];
      // An empty `new Map()` writes nothing down: it can only be a collection the
      // code fills later, which is the rule's second reason by construction.
      const allStatic = written.length > 0 && written.every((argument) => isStaticValue(argument));
      const name = bindingName(node);
      if ((kind === 'Map' || kind === 'Set') && allStatic && name !== null) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
        if (!isMutated(text, name) && !hasSizeRead(text, name) && !reasonStated(lines, line)) {
          findings.push({
            file: relative(ROOT, file),
            line: line + 1,
            kind,
            name,
            keys: countWrittenKeys(node),
            code: lines[line].trim(),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return findings;
}

function keyOf(finding) {
  return `${finding.file}#${finding.name}`;
}

function readBaseline() {
  if (!existsSync(BASELINE_PATH)) {
    return new Map();
  }
  const parsed = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  return new Map(parsed.entries.map((entry) => [entry.key, entry]));
}

function describe(finding) {
  console.log(
    `  [${finding.reason === undefined ? 'NEW' : 'baselined'}] ${finding.file}:${finding.line}  ` +
      `${finding.kind} ${finding.name} — ${finding.keys} statically written key` +
      `${finding.keys === 1 ? '' : 's'}`,
  );
  console.log(`      ${finding.code}`);
  if (finding.reason !== undefined) {
    console.log(`      reason: ${finding.reason}`);
  }
}

const files = walk(ROOT).sort();
const findings = files.flatMap(checkFile);
const baseline = readBaseline();
const stillPresent = new Set();
const fresh = [];

for (const finding of findings) {
  const key = keyOf(finding);
  if (baseline.has(key)) {
    stillPresent.add(key);
    finding.reason = baseline.get(key).reason;
  } else {
    fresh.push(finding);
  }
}

if (listEverything) {
  for (const finding of findings) {
    describe(finding);
  }
  console.log(`\nListed ${findings.length} finding(s) across ${files.length} source files.`);
  exit(0);
}

const expired = [...baseline.keys()].filter((key) => !stillPresent.has(key));
const problems = fresh.map(
  (finding) =>
    `${finding.file}:${finding.line}: ${finding.kind} ${finding.name} is a static string-keyed ` +
    'lookup; use a Record<K,V> literal, or state why the Map/Set is required.',
);
for (const key of expired) {
  problems.push(
    `${key}: baselined but no longer a finding — the Map/Set is gone or now states a reason; ` +
      'delete the entry from check-no-static-map-set.baseline.json.',
  );
}

console.log(
  `No static Map/Set check: ${files.length} source files, ${findings.length} finding(s), ` +
    `${findings.length - fresh.length} baselined, ${fresh.length} new.`,
);
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems) {
    console.error(`  ${problem}`);
  }
  console.error(
    '\nThe rule (AGENTS.md, House style): no Map/Set for static string-keyed lookups; use a\n' +
      'Record<K,V> literal. A Map/Set is correct for dynamic keys, for runtime insertion\n' +
      'or deletion, and where insertion order or .size is needed. For the last of those,\n' +
      'write `no-map: <reason>` above it and this check will leave it alone.',
  );
  exit(1);
}
console.log('  No Map or Set holds a statically written key that a Record would serve better.');
