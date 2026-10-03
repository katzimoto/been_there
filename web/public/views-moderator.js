/**
 * The moderator desk.
 *
 * A report does not restrict anybody by itself. It is triaged, a case is opened
 * from it, the case is assigned and reviewed, and only then does a decision take
 * effect — with a named human behind it, which the service enforces by refusing
 * an `automated` actor and a missing `moderatorId`. This screen walks those four
 * steps with the real endpoints, using the local staff token the server was
 * started with.
 *
 * The panel afterwards is the point of the screen. A restricted account keeps
 * `report` and `block`; the strike-through in that list is not this page's
 * opinion, it is `account.capabilities` as the service published it a moment ago.
 */
import { call } from './api.js';
import { allowedPanel, capabilityPanel, el, empty, refusalPanel } from './dom.js';
import { act, me } from './session.js';

const STAFF_TOKEN = 'web-senior-moderator';
const ACTIONS = ['warn', 'restrict', 'suspend', 'ban', 'clear'];

/** @returns {HTMLElement} */
export function moderatorView() {
  const node = el('div', { class: 'card' }, [el('p', { class: 'note', text: 'Reading the queue…' })]);
  void (async () => {
    const queue = await call({
      token: STAFF_TOKEN,
      method: 'GET',
      path: '/moderation/cases',
      label: 'read the moderation queue',
    });
    if (!queue.ok) {
      node.replaceChildren(el('h1', { text: 'Moderator desk' }), refusalPanel(queue));
      return;
    }
    const cases = queue.body?.cases ?? [];
    node.replaceChildren(
      el('h1', { text: 'Moderator desk' }),
      el('p', {
        class: 'note',
        text:
          `Signed in with the local staff token (${STAFF_TOKEN}). This is the ` +
          'senior_moderator role the server was started with; the service refuses ' +
          'decisions from an automated actor whatever the request says.',
      }),
      el('div', { class: 'card' }, [
        el('h2', { text: 'Open cases' }),
        cases.length === 0
          ? empty(
              'No open cases. File a report from the Safety tab as one persona, then come ' +
                'back here — a case is opened from a report, never straight from a user.',
            )
          : el('div', {}, cases.map((entry) => caseCard(entry))),
      ]),
      el('div', { class: 'card' }, [el('h2', { text: 'Open a case' }), openCaseForm()]),
    );
  })();
  return node;
}

/** @returns {HTMLElement} */
function openCaseForm() {
  const reportId = el('input', { type: 'text', placeholder: 'report id' });
  const moderatorId = el('input', { type: 'text', value: 'mod-senior-1' });
  const status = el('div');
  return el('div', {}, [
    el('div', { class: 'grid' }, [
      el('div', { class: 'field' }, [el('label', { text: 'Report id (from the Safety tab)' }), reportId]),
      el('div', { class: 'field' }, [el('label', { text: 'Moderator opening it' }), moderatorId]),
    ]),
    el('button', {
      type: 'button',
      text: 'Triage the report and open a case',
      onclick: async () => {
        const outcome = await call({
          token: STAFF_TOKEN,
          method: 'POST',
          path: '/moderation/cases',
          body: { reportId: reportId.value, moderatorId: moderatorId.value },
          label: 'open a case',
        });
        status.replaceChildren(outcome.ok ? allowedPanel('The service opened the case.', outcome.body) : refusalPanel(outcome));
      },
    }),
    status,
  ]);
}

/**
 * @param {{ caseId: string, subjectId: string, priority: string, queue: string, state: string, dueAt: string, reportIds: string[] }} entry
 * @returns {HTMLElement}
 */
function caseCard(entry) {
  const status = el('div');
  const action = el('select', {}, ACTIONS.map((name) => el('option', { value: name, text: name })));
  const removed = el('input', { type: 'text', value: 'browse_discovery,like,send_message' });
  const rationale = el('input', { type: 'text', value: 'Messages continued after a block.' });
  const subject = el('div');

  const showSubject = async () => {
    const outcome = await call({
      token: STAFF_TOKEN,
      method: 'GET',
      path: `/accounts/${entry.subjectId}`,
      label: 'read the subject account',
    });
    subject.replaceChildren(
      outcome.ok ? capabilityPanel(outcome.body.account) : refusalPanel(outcome),
      el('p', { class: 'meta', text: `Subject: ${entry.subjectId}` }),
    );
  };

  return el('div', { class: 'card' }, [
    el('h2', { text: `Case ${entry.caseId}` }),
    el('p', {
      class: 'note',
      text: `${entry.priority} · ${entry.queue} · ${entry.state} · due ${entry.dueAt} · reports ${entry.reportIds.join(', ')}`,
    }),
    el('div', { class: 'grid' }, [
      el('div', { class: 'field' }, [el('label', { text: 'Action' }), action]),
      el('div', { class: 'field' }, [el('label', { text: 'Capabilities to remove (comma separated)' }), removed]),
      el('div', { class: 'field' }, [el('label', { text: 'Rationale' }), rationale]),
    ]),
    el('div', { class: 'row' }, [
      el('button', { type: 'button', class: 'ghost', text: 'Read the subject account', onclick: () => void showSubject() }),
      el('button', {
        type: 'button',
        text: 'Record the decision',
        onclick: async () => {
          const outcome = await call({
            token: STAFF_TOKEN,
            method: 'POST',
            path: `/moderation/cases/${entry.caseId}/decisions`,
            body: {
              moderatorId: 'mod-senior-1',
              action: action.value,
              rationale: rationale.value,
              removedCapabilities: removed.value
                .split(',')
                .map((name) => name.trim())
                .filter((name) => name.length > 0),
            },
            label: 'record the decision',
          });
          status.replaceChildren(outcome.ok ? allowedPanel('The service applied the decision.', outcome.body) : refusalPanel(outcome));
          if (outcome.ok) {
            await showSubject();
          }
        },
      }),
    ]),
    status,
    subject,
  ]);
}

export { STAFF_TOKEN };
