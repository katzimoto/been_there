/**
 * The moderator desk.
 *
 * A report does not restrict anybody by itself. It is triaged, a case is opened
 * from it, the case is assigned and reviewed, and only then does a decision take
 * effect — with a named human behind it, which the service enforces by refusing
 * an `automated` actor and a missing `moderatorId`. This screen walks those four
 * steps with the real endpoints, signing in as the moderator the server
 * provisioned at boot.
 *
 * ## Why the token is fetched rather than written here
 *
 * This file used to declare `const STAFF_TOKEN = 'web-senior-moderator'`, which
 * put the desk's credential in a shipped asset and therefore in the repository —
 * and made that string the acting identity of every decision the desk took. The
 * desk now reads the session the server minted (`/staff-session.json`), which
 * carries a real `staffId`.
 *
 * That `staffId` matters as much as the token. The service refuses a decision
 * whose body names a moderator other than the one the session belongs to, so the
 * page sends the identity it signed in as rather than typing one into a field.
 * The moderator field is gone for the same reason it used to be a text input: it
 * was a way to write someone else's name into a permanent record.
 *
 * The panel afterwards is the point of the screen. A restricted account keeps
 * `report` and `block`; the strike-through in that list is not this page's
 * opinion, it is `account.capabilities` as the service published it a moment ago.
 */
import { call } from './api.js';
import { allowedPanel, capabilityPanel, el, empty, refusalPanel } from './dom.js';
import { act, me } from './session.js';

const ACTIONS = ['warn', 'restrict', 'suspend', 'ban', 'clear'];

/**
 * The session the server provisioned, or `null` when it could not sign in.
 *
 * Fetched once and reused, so every request on this screen is made by the same
 * identity — which is the property the service now checks.
 *
 * @returns {Promise<{token: string, staffId: string, displayName: string, role: string} | null>}
 */
async function staffSession() {
  const response = await fetch('/staff-session.json', { cache: 'no-store' });
  if (!response.ok) {
    return null;
  }
  return await response.json();
}

/** @returns {HTMLElement} */
export function moderatorView() {
  const node = el('div', { class: 'card' }, [el('p', { class: 'note', text: 'Reading the queue…' })]);
  void (async () => {
    const staff = await staffSession();
    if (staff === null) {
      node.replaceChildren(
        el('h1', { text: 'Moderator desk' }),
        refusalPanel({ ok: false, body: { error: { message: 'the server could not sign the desk in' } } }),
      );
      return;
    }
    const queue = await call({
      token: staff.token,
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
          `Signed in as ${staff.displayName} (${staff.role}). Every action below is ` +
          'recorded under that identity; the service refuses a decision that names ' +
          'a different moderator, and refuses one from an automated actor whatever ' +
          'the request says.',
      }),
      el('div', { class: 'card' }, [
        el('h2', { text: 'Open cases' }),
        cases.length === 0
          ? empty(
              'No open cases. File a report from the Safety tab as one persona, then come ' +
                'back here — a case is opened from a report, never straight from a user.',
            )
          : el('div', {}, cases.map((entry) => caseCard(entry, staff))),
      ]),
      el('div', { class: 'card' }, [el('h2', { text: 'Open a case' }), openCaseForm(staff)]),
    );
  })();
  return node;
}

/** @returns {HTMLElement} */
function openCaseForm(staff) {
  const reportId = el('input', { type: 'text', placeholder: 'report id' });
  const status = el('div');
  return el('div', {}, [
    el('div', { class: 'grid' }, [
      el('div', { class: 'field' }, [el('label', { text: 'Report id (from the Safety tab)' }), reportId]),
      el('div', { class: 'field' }, [
        el('label', { text: 'Opening as' }),
        // Read-only, because it is not the operator's to choose: the service
        // refuses a case whose moderator is anyone but the session's holder, and
        // a field that looked editable would invite exactly that.
        el('input', { type: 'text', value: staff.displayName, readonly: true }),
      ]),
    ]),
    el('button', {
      type: 'button',
      text: 'Triage the report and open a case',
      onclick: async () => {
        const outcome = await call({
          token: staff.token,
          method: 'POST',
          path: '/moderation/cases',
          body: { reportId: reportId.value, moderatorId: staff.staffId },
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
function caseCard(entry, staff) {
  const status = el('div');
  const action = el('select', {}, ACTIONS.map((name) => el('option', { value: name, text: name })));
  const removed = el('input', { type: 'text', value: 'browse_discovery,like,send_message' });
  const rationale = el('input', { type: 'text', value: 'Messages continued after a block.' });
  const subject = el('div');

  const showSubject = async () => {
    const outcome = await call({
      token: staff.token,
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
            token: staff.token,
            method: 'POST',
            path: `/moderation/cases/${entry.caseId}/decisions`,
            body: {
              // The identity this session belongs to. Not a typed value: the
              // service refuses a decision naming anyone else.
              moderatorId: staff.staffId,
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

