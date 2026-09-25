/**
 * What the development dataset asserts about itself.
 *
 * The seed builds states by running machines, so the interesting failure is not
 * "a transition was rejected" — that throws at build time. It is "a state in
 * the dataset that no transition could have produced": a hand-edited `verified`,
 * a ban with no case behind it, a trail that no longer replays because the
 * machine was edited underneath it. Those are silent, they are exactly the kind
 * of thing this repository exists to prevent, and nothing else catches them.
 *
 * Every check below replays the recorded trail through the live machine and
 * compares, so a change to a transition table that invalidates the seed fails
 * here rather than making the dataset quietly untrue.
 */
import { capabilitiesFor, identityMachine, accountMachine, riskMachine } from '@been-there/core';
import { CLEARANCE_BY_ROLE, authorize, isWithinClearance } from '@been-there/platform';
import { asUser } from './dataset-steps.mjs';

/** The confidence floor the identity machine's provider guard enforces. */
const CONFIDENCE_FLOOR = 0.9;

function replay(machine, trail, recorded) {
  let state = machine.initial;
  for (const entry of trail) {
    if (entry.from !== state) {
      return { state: null, problem: `step ${entry.event} claims it started at ${entry.from}, replay is at ${state}` };
    }
    const next = machine.next(state, entry.event, entry.context);
    if (!next.ok) {
      return { state: null, problem: `step ${entry.event} is no longer legal from ${state}: ${next.error.code}` };
    }
    if (next.value !== entry.to) {
      return { state: null, problem: `step ${entry.event} now lands on ${next.value}, the trail says ${entry.to}` };
    }
    state = next.value;
  }
  return { state, problem: state === recorded ? null : `replaying the trail ends at ${state}, the dataset says ${recorded}` };
}

export function verifyDataset(dataset) {
  const problems = [];
  const caseIds = new Set(dataset.cases.map((entry) => entry.caseId));

  for (const person of dataset.users) {
    const identity = replay(identityMachine, person.identityTrail, person.identityState);
    if (identity.problem !== null) {
      problems.push(`${person.userId}: identity trail — ${identity.problem}`);
    }
    if (person.identityTrail.length === 0) {
      problems.push(`${person.userId}: no identity trail at all; a state nobody transitioned to is not a state`);
    }
    if (person.identityState === 'verified') {
      const last = person.identityTrail.at(-1);
      const viaReview = last?.event === 'review_cleared' && last.context?.reviewerId !== undefined;
      const viaProvider =
        last?.event === 'provider_result_received' && (last.context?.confidence ?? 0) >= CONFIDENCE_FLOOR;
      if (!viaReview && !viaProvider) {
        problems.push(
          `${person.userId}: is verified without a provider result at or above ${CONFIDENCE_FLOOR} or a named reviewer`,
        );
      }
    }
    if (person.identityTrail.at(-1)?.to !== person.identityState) {
      problems.push(`${person.userId}: the last recorded transition does not end at ${person.identityState}`);
    }

    const account = replay(accountMachine, person.accountTrail, person.accountState);
    if (account.problem !== null) {
      problems.push(`${person.userId}: account trail — ${account.problem}`);
    }
    for (const entry of person.accountTrail) {
      if (entry.context?.caseId === undefined || !caseIds.has(entry.context.caseId)) {
        problems.push(`${person.userId}: ${entry.event} names no case in the dataset (${entry.context?.caseId})`);
      }
      if (entry.context?.moderatorId === undefined) {
        problems.push(`${person.userId}: ${entry.event} names no moderator, so automation could have done it`);
      }
    }

    // A restricted or banned account keeps the two capabilities that must never
    // be taken away: a sanctioned user still has to be able to report and to
    // block, and a banned user still has to be able to leave.
    const capabilities = capabilitiesFor(person.accountState, person.accountContext);
    for (const required of ['report', 'block']) {
      if (!capabilities.includes(required)) {
        problems.push(`${person.userId}: ${person.accountState} no longer grants ${required}`);
      }
    }
    if (capabilities.join() !== person.capabilities.join()) {
      problems.push(`${person.userId}: the recorded capabilities differ from the kernel's for ${person.accountState}`);
    }
  }

  for (const assessment of dataset.riskAssessments) {
    const risk = replay(riskMachine, assessment.trail, assessment.state);
    if (risk.problem !== null) {
      problems.push(`${assessment.subjectId}: risk trail — ${risk.problem}`);
    }
    if (assessment.state !== 'normal' && assessment.trail.length === 0) {
      problems.push(`${assessment.subjectId}: risk is ${assessment.state} with no signal behind it`);
    }
  }

  // The report and the ban must belong to the same story: a ban whose case came
  // from a different report is a sanction with no allegation behind it.
  const banned = dataset.users.find((person) => person.accountState === 'banned');
  if (banned === undefined) {
    problems.push('the dataset has no banned account, so the enforcement path is not exercised');
  } else {
    if (banned.userId !== dataset.report.subjectId) {
      problems.push(`the banned user is not the user the report is about (${dataset.report.subjectId})`);
    }
    const enforcementCase = dataset.cases.find((entry) => entry.caseId === dataset.caseId);
    if (enforcementCase === undefined || !enforcementCase.reportIds.includes(dataset.report.reportId)) {
      problems.push(`the ban names case ${dataset.caseId}, which is not the case opened from ${dataset.report.reportId}`);
    }
    if (dataset.contact['riley/frankie'].allowed !== false) {
      problems.push('the blocked pair is still allowed to make contact');
    }
  }
  if (dataset.contact['avery/blair'].allowed !== true) {
    problems.push('an unblocked, matched pair is not allowed to make contact');
  }

  // The audit log must actually gate: a restricted record is invisible below
  // `restricted` and visible at it, and the role that may read the log at all is
  // the one with the restricted permission.
  const internal = dataset.platformAuditLog.read(CLEARANCE_BY_ROLE.moderator);
  const restricted = dataset.platformAuditLog.read(CLEARANCE_BY_ROLE.senior_moderator);
  if (restricted.length <= internal.length) {
    problems.push('reading the audit log at restricted clearance shows no more than reading it as a moderator');
  }
  for (const record of internal) {
    if (!isWithinClearance(CLEARANCE_BY_ROLE.moderator, record.sensitivity)) {
      problems.push(`audit record ${record.auditId} is ${record.sensitivity} but a moderator could read it`);
    }
  }
  const cleared = authorize({ userId: asUser('mod-okonkwo'), role: 'senior_moderator' }, 'audit.read');
  const refused = authorize({ userId: asUser('support-lane'), role: 'support' }, 'audit.read');
  if (!cleared.ok) {
    problems.push(`a senior moderator cannot read the audit log: ${cleared.error.code}`);
  }
  if (refused.ok) {
    problems.push('support was allowed to read the audit log, which is the boundary this check exists for');
  }

  return problems;
}
