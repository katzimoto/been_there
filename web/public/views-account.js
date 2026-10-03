/**
 * The screens, each one a rendering of what the service returned.
 *
 * The rule this file follows without exception: a button sends a request, and the
 * panel underneath shows the response. There is no client-side eligibility test,
 * no local list of what a restricted account may do, and no wording that the
 * service did not produce. Where the UI needs to know something — which
 * onboarding steps are outstanding, whether a profile is complete, what an
 * account is allowed to do — it is reading a projection the service publishes.
 */
import { call, reportReasons } from './api.js';
import { allowedPanel, capabilityPanel, checklist, el, empty, pretty, refusalPanel } from './dom.js';
import { act, me } from './session.js';

const TERMS_VERSION = '2026-09-01';

/** Re-render the current screen. Supplied by `app.js` at start-up. */
export let rerender = () => {};
/** @param {() => void} fn */
export function setRerender(fn) {
  rerender = fn;
}

// ------------------------------------------------------------------- account tab

/** The age gate the service returned at sign-up, shown once on the account screen. */
export function setAgeGate(body) {
  ageGate = body;
}

/** @type {{ title: string, body: string, ageBand: string } | null} */
let ageGate = null;

/** @returns {HTMLElement} */
export function homeView() {
  const node = el('div', { class: 'card' }, [el('p', { class: 'note', text: 'Reading the account projection…' })]);
  void (async () => {
    const persona = me();
    if (persona === null) {
      return;
    }
    const [onboarding, account] = await Promise.all([
      call({
        token: persona.token,
        method: 'GET',
        path: `/accounts/${persona.userId}/onboarding`,
        label: 'read the onboarding checklist',
      }),
      call({
        token: persona.token,
        method: 'GET',
        path: `/accounts/${persona.userId}`,
        label: 'read the account projection',
      }),
    ]);
    node.replaceChildren(
      el('h1', { text: persona.name }),
      el('p', { class: 'note', text: persona.userId }),
      ageGate === null
        ? null
        : el('div', { class: 'allowed' }, [
            el('h3', { text: ageGate.title }),
            el('p', { text: ageGate.body }),
            el('p', { class: 'note', text: `Age band other members see: ${ageGate.ageBand}` }),
          ]),
      onboarding.ok
        ? el('div', { class: 'card' }, [
            el('h2', { text: 'Onboarding' }),
            el('p', {
              class: 'note',
              text: `Next step the service names: ${String(onboarding.body.nextStep)}`,
            }),
            checklist(onboarding.body.outstanding ?? [], []),
            el('p', {
              class: 'note',
              text:
                'This list is the service’s. The client does not know what onboarding ' +
                'requires; it prints what it was handed.',
            }),
          ])
        : refusalPanel(onboarding),
      account.ok
        ? el('div', { class: 'card' }, [
            el('h2', { text: 'What this account may do' }),
            el('p', {
              class: 'note',
              text: `Identity: ${String(account.body.identity?.state)} · discoverable: ${String(account.body.identity?.discoverable)}`,
            }),
            capabilityPanel(account.body.account),
          ])
        : refusalPanel(account),
      identityNote(onboarding),
    );
  })();
  return node;
}

/**
 * The onboarding projection names `contact_verification` as outstanding, and this
 * repository has no mail relay, so there is no button that could clear it.
 *
 * @param {{ ok: boolean, body: unknown }} onboarding
 */
function identityNote(onboarding) {
  const outstanding = onboarding.ok ? (onboarding.body.outstanding ?? []) : [];
  if (!outstanding.includes('contact_verification')) {
    return null;
  }
  return el('div', { class: 'card' }, [
    el('h2', { text: 'Contact verification' }),
    el('p', {
      class: 'note',
      text:
        'The service still lists this as outstanding, and it will until a contact ' +
        'confirmation lands. This repository configures no mail relay, so the message ' +
        'is composed and printed to the server’s stdout rather than sent. There is no ' +
        'button here because there is nothing this client could honestly do.',
    }),
  ]);
}

// -------------------------------------------------------------- verification tab

/** @returns {HTMLElement} */
export function verifyView() {
  const node = el('div', { class: 'card' }, [el('p', { class: 'note', text: 'Reading the identity state…' })]);
  let attemptId = null;

  const status = el('div');
  const step = async (label, fn) => {
    const outcome = await act({ label, body: fn });
    if (outcome === null) {
      return null;
    }
    if (!outcome.ok) {
      status.replaceChildren(refusalPanel(outcome));
      return null;
    }
    status.replaceChildren(allowedPanel(label, outcome.body));
    return outcome.body;
  };

  void (async () => {
    const persona = me();
    if (persona === null) {
      return;
    }
    const account = await call({
      token: persona.token,
      method: 'GET',
      path: `/accounts/${persona.userId}`,
      label: 'read the identity state',
    });
    const state = account.ok ? String(account.body?.identity?.state) : 'unknown';
    node.replaceChildren(
      el('h1', { text: 'Identity verification' }),
      el('p', { class: 'note', text: `The service says this account is: ${state}` }),
      el('p', {
        class: 'note',
        text:
          'These three names are the domain’s vocabulary, not something this page ' +
          'invented, and nothing here decides whether they are enough: the service ' +
          'refuses a submit until every required check is captured and refuses an ' +
          'unrecognised check or evidence kind by naming what it does allow. Press the ' +
          'steps out of order and you will see both refusals rather than a local warning.',
      }),
      el('div', { class: 'row' }, [
        el('button', {
          type: 'button',
          text: '1. Start an attempt',
          onclick: async () => {
            const started = await step('start a verification attempt', (bearer) =>
              call({
                token: bearer,
                method: 'POST',
                path: `/accounts/${persona.userId}/verification/attempts`,
                body: { reason: 'onboarding' },
                label: 'start a verification attempt',
              }),
            );
            if (started !== null) {
              attemptId = started.verificationId;
            }
          },
        }),
        el('button', {
          type: 'button',
          text: '2. Capture all three checks',
          onclick: async () => {
            if (attemptId === null) {
              status.replaceChildren(
                el('p', { class: 'note', text: 'Start an attempt first — the service mints the id.' }),
              );
              return;
            }
            for (const [check, kind] of [
              ['document_authenticity', 'government_id_image'],
              ['liveness', 'liveness_video'],
              ['likeness', 'selfie_image'],
            ]) {
              const outcome = await act({
                label: `capture ${check}`,
                body: (bearer) =>
                  call({
                    token: bearer,
                    method: 'POST',
                    path: `/accounts/${persona.userId}/verification/attempts/${attemptId}/captures`,
                    body: { check, kind, storageRef: `demo/${check}`, digest: `sha256:${check}` },
                    label: `capture ${check}`,
                  }),
              });
              if (outcome !== null && !outcome.ok) {
                status.replaceChildren(refusalPanel(outcome));
                return;
              }
            }
            status.replaceChildren(
              allowedPanel('The service accepted all three captures.', {
                requiredChecks: ['document_authenticity', 'liveness', 'likeness'],
              }),
            );
          },
        }),
        el('button', {
          type: 'button',
          text: '3. Submit to the provider',
          onclick: () =>
            step('submit the attempt to the provider', (bearer) =>
              call({
                token: bearer,
                method: 'POST',
                path: `/accounts/${persona.userId}/verification/attempts/${attemptId}/submit`,
                body: {},
                label: 'submit the attempt',
              }),
            ),
        }),
        el('button', {
          type: 'button',
          text: '4. Deliver the provider result',
          onclick: () =>
            step('deliver the provider result', (bearer) =>
              call({
                token: bearer,
                method: 'POST',
                path: `/accounts/${persona.userId}/verification/attempts/${attemptId}/provider-result`,
                body: {
                  providerReference: `demo-ref-${persona.userId.slice(0, 8)}`,
                  confidence: 0.97,
                  checks: [
                    { check: 'document_authenticity', outcome: 'passed', score: 0.98 },
                    { check: 'liveness', outcome: 'passed', score: 0.95 },
                    { check: 'likeness', outcome: 'passed', score: 0.93 },
                  ],
                },
                label: 'deliver the provider result',
              }),
            ),
        }),
        el('button', {
          type: 'button',
          class: 'ghost',
          text: 'Deliver a failed result',
          onclick: () =>
            step('deliver a failed provider result', (bearer) =>
              call({
                token: bearer,
                method: 'POST',
                path: `/accounts/${persona.userId}/verification/attempts/${attemptId}/provider-result`,
                body: {
                  providerReference: `demo-ref-${persona.userId.slice(0, 8)}`,
                  confidence: 0.21,
                  checks: [
                    { check: 'document_authenticity', outcome: 'failed', score: 0.1 },
                    { check: 'liveness', outcome: 'passed', score: 0.9 },
                    { check: 'likeness', outcome: 'failed', score: 0.1 },
                  ],
                },
                label: 'deliver a failed provider result',
              }),
            ),
        }),
      ]),
      status,
    );
  })();
  return node;
}

export { TERMS_VERSION };
