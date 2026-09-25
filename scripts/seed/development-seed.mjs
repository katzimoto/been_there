#!/usr/bin/env node
/**
 * The development dataset, on the terminal.
 *
 *   node scripts/seed/development-seed.mjs                  # the summary
 *   node scripts/seed/development-seed.mjs --format json    # the whole dataset
 *   node scripts/seed/development-seed.mjs --check          # assert its invariants
 *   node scripts/seed/development-seed.mjs --audit --as senior_moderator
 *   node scripts/seed/development-seed.mjs --audit --as support
 *
 * The last two are the point of the audit mode. Reading the audit log is a
 * protected action: only a role that holds `audit.read.restricted` *and* carries
 * `restricted` clearance may do it, and the log then hides every record above
 * that reader's clearance. Run it as `support` or `system` and the domain
 * refuses, with the reason, rather than the CLI deciding on its own what a
 * support agent is allowed to see.
 *
 * The dataset is loaded in process. There is no schema behind it, so nothing is
 * written anywhere; `make seed` is the target that will load it, and it refuses
 * until a schema exists.
 */
import { CLEARANCE_BY_ROLE, authorize, readAuditRecord } from '@been-there/platform';
import { loadDevelopmentDataset } from './development-dataset.mjs';
import { verifyDataset } from './dataset-invariants.mjs';
import { asUser } from './dataset-steps.mjs';

const USAGE = `usage: node scripts/seed/development-seed.mjs [options]

  --format <summary|json>   what to print (default: summary)
  --check                   assert the dataset's invariants and exit non-zero on failure
  --audit                   read the seeded audit log through the domain's authorisation
  --as <role>               the role to read as: ${Object.keys(CLEARANCE_BY_ROLE).join(', ')}

Nothing is written to a database: this repository has no schema yet.`;

function parseArguments(argv) {
  const options = { format: 'summary', check: false, audit: false, role: 'senior_moderator' };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--check') {
      options.check = true;
    } else if (argument === '--audit') {
      options.audit = true;
    } else if (argument === '--format') {
      options.format = argv[++index] ?? '';
    } else if (argument === '--as') {
      options.role = argv[++index] ?? '';
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown argument "${argument}"`);
    }
  }
  if (!Object.hasOwn(CLEARANCE_BY_ROLE, options.role)) {
    throw new Error(`"${options.role}" is not a role; expected one of ${Object.keys(CLEARANCE_BY_ROLE).join(', ')}`);
  }
  if (options.format !== 'summary' && options.format !== 'json') {
    throw new Error(`unknown format "${options.format}"; expected summary or json`);
  }
  return options;
}

function summary(dataset) {
  const lines = [];
  lines.push(`Development dataset, built at ${dataset.epoch} (deterministic: same output every run)`);
  lines.push('');
  lines.push('Users — identity, standing, and whether discovery can see them');
  lines.push(`  ${'user'.padEnd(10)}${'identity'.padEnd(17)}${'account'.padEnd(9)}${'discoverable'.padEnd(13)}how the state was reached`);
  for (const person of dataset.users) {
    const via = person.identityTrail.map((entry) => entry.event).join(' -> ');
    lines.push(
      `  ${person.userId.padEnd(10)}${person.identityState.padEnd(17)}${person.accountState.padEnd(9)}${String(person.discoverable).padEnd(13)}${via}`,
    );
  }
  lines.push('');
  lines.push('Risk assessments — evidence replayed, never assigned');
  for (const assessment of dataset.riskAssessments) {
    lines.push(`  ${assessment.subjectId.padEnd(10)}${assessment.state.padEnd(10)}${assessment.trail.length} signal(s): ${assessment.trail.map((entry) => entry.event).join(', ')}`);
  }
  lines.push('');
  lines.push('Dating');
  for (const match of dataset.matches) {
    const state = match.ended === null ? 'open' : `ended (${match.ended.cause})`;
    lines.push(`  ${match.matchId.padEnd(26)}${state}`);
  }
  for (const entry of dataset.passes) {
    lines.push(`  pass ${entry.passId.padEnd(26)}${entry.state} (${entry.from} -> ${entry.to})`);
  }
  for (const conversation of dataset.conversations) {
    lines.push(`  conversation ${conversation.conversationId}: ${conversation.state}, ${conversation.messages.length} message(s)`);
    for (const message of conversation.messages) {
      lines.push(`    ${message.senderId.padEnd(10)}${message.body}`);
    }
  }
  for (const [pair, permission] of Object.entries(dataset.contact)) {
    lines.push(`  contact ${pair}: ${permission.allowed ? 'allowed' : `refused (${permission.reason})`}`);
  }
  lines.push('');
  lines.push('Moderation');
  lines.push(`  report ${dataset.report.reportId} about ${dataset.report.subjectId} by ${dataset.report.reporterId} (${dataset.report.reason}, ${dataset.report.state})`);
  for (const entry of dataset.cases) {
    lines.push(`  case ${entry.caseId}: ${entry.state}, ${entry.queue} queue, priority ${entry.priority}, ${entry.reportIds.length} report(s)`);
  }
  for (const artefact of dataset.evidence) {
    lines.push(`  evidence ${artefact.evidenceId}: ${artefact.kind}, needs ${artefact.access}`);
  }
  const views = dataset.evidenceViews;
  lines.push(`    the identity artefact as a moderator: ${views.identityArtefact.asModerator.visibility} — "${views.identityArtefact.asModerator.redactedSummary}"`);
  lines.push(`    the same artefact as the identity privacy officer: ${views.identityArtefact.asOfficer.visibility} — ${views.identityArtefact.asOfficer.artefactReference}`);
  lines.push(`    the message snapshot as a moderator: ${views.messageSnapshot.asModerator.visibility} — ${views.messageSnapshot.asModerator.artefactReference}`);
  lines.push('');
  lines.push(`Audit: ${dataset.moderationAuditEntries.length} row(s) in the case log, ${dataset.platformAuditLog.read(CLEARANCE_BY_ROLE.senior_moderator).length} row(s) in the platform log at restricted clearance.`);
  lines.push('Run `make audit-log AUDIT_AS=<role>` to see who may read the platform log, and who is refused.');
  return lines.join('\n');
}

function auditView(dataset, role) {
  const principal = { userId: asUser(`seed-${role}`), role };
  const authorized = authorize(principal, 'audit.read');
  if (!authorized.ok) {
    return [
      `Reading the audit log as "${role}" is refused.`,
      `  ${authorized.error.code}: ${authorized.error.message}`,
      `  clearance held by this role: ${CLEARANCE_BY_ROLE[role].upTo}; the action requires restricted`,
      '  This refusal is the domain deciding, not this script. Try --as senior_moderator.',
    ].join('\n');
  }
  const clearance = authorized.value.clearance;
  const records = dataset.platformAuditLog.read(clearance);
  const withheld = dataset.platformAuditLog.read({ upTo: 'restricted' }).length - records.length;
  const lines = [
    `Reading the audit log as "${role}" (clearance ${clearance.upTo}).`,
    `${records.length} record(s) visible, ${withheld} withheld because they are classified above this clearance.`,
    '',
  ];
  for (const record of records) {
    const view = readAuditRecord(record, clearance);
    const fields = Object.entries(view.visible)
      .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
      .join(' ');
    lines.push(`  #${record.sequence} ${record.action} (${record.sensitivity}) ${fields}`);
  }
  lines.push('');
  lines.push('Every field above is classified; a field above this reader’s clearance was dropped, not blanked.');
  return lines.join('\n');
}

/** The dataset minus the live objects, for `--format json`. */
function jsonView(dataset) {
  return JSON.stringify(
    {
      epoch: dataset.epoch,
      users: dataset.users,
      riskAssessments: dataset.riskAssessments,
      matches: dataset.matches,
      passes: dataset.passes,
      conversations: dataset.conversations,
      blocks: dataset.blocks,
      contact: dataset.contact,
      report: dataset.report,
      cases: dataset.cases,
      evidence: dataset.evidence.map(({ retentionExpiresAt, ...rest }) => rest),
      moderationAuditEntries: dataset.moderationAuditEntries,
      platformAuditByClearance: Object.fromEntries(
        Object.entries(CLEARANCE_BY_ROLE).map(([role, clearance]) => [
          role,
          dataset.platformAuditLog.read(clearance).map((record) => ({
            sequence: record.sequence,
            action: record.action,
            sensitivity: record.sensitivity,
            actorId: record.actorId,
            subjectId: record.subjectId,
            caseId: record.caseId,
          })),
        ]),
      ),
    },
    null,
    2,
  );
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const dataset = loadDevelopmentDataset();

  if (options.check) {
    const problems = verifyDataset(dataset);
    if (problems.length > 0) {
      console.error(`The dataset violates ${problems.length} invariant(s):\n`);
      for (const problem of problems) {
        console.error(`  - ${problem}`);
      }
      process.exit(1);
    }
    console.log(
      `Dataset invariants hold: ${dataset.users.length} users, ${dataset.riskAssessments.length} risk assessments, ` +
        `${dataset.cases.length} cases, ${dataset.platformAuditLog.read({ upTo: 'restricted' }).length} audit records.`,
    );
  } else if (options.audit) {
    console.log(auditView(dataset, options.role));
  } else if (options.format === 'json') {
    console.log(jsonView(dataset));
  } else {
    console.log(summary(dataset));
  }
} catch (error) {
  console.error(`seed: ${error.message}`);
  process.exit(1);
}
