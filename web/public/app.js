/**
 * Been There, in a browser.
 *
 * Chrome, routing and sign-in. Every screen lives in `views-*.js` and each one is
 * a rendering of a service response; this file only decides which is on screen and
 * who is signed in.
 *
 * ## Why several people share one browser
 *
 * A like only becomes a match when the other person likes back, and a block only
 * means anything when someone else blocks you. One person cannot walk either half
 * alone, so the page holds several signed-in personas — each with its own bearer
 * token, which is what a second phone would have had.
 *
 * ## Dependencies
 *
 * None. `node:http` serves the three files and forwards the API calls, so nothing
 * was added to the root `package.json` and there is no build step.
 */
import { call, log, onExchange } from './api.js';
import { el, empty, pretty, refusalPanel } from './dom.js';
import { adopt, all, detach, me, onChange, onChrome, select } from './session.js';
import { homeView, setAgeGate, setRerender, verifyView } from './views-account.js';
import { discoverView, profileView } from './views-dating.js';
import { matchesView, safetyView } from './views-relations.js';
import { moderatorView } from './views-moderator.js';

const TERMS_VERSION = '2026-09-01';
const PASSWORD_SAMPLE = 'correct-horse-battery-staple-42';

const TABS = [
  ['home', 'Account'],
  ['verify', 'Verification'],
  ['profile', 'Profile'],
  ['discover', 'Discovery'],
  ['matches', 'Matches'],
  ['safety', 'Block & report'],
  ['moderator', 'Moderator desk'],
];

const SCREENS = {
  home: homeView,
  verify: verifyView,
  profile: profileView,
  discover: discoverView,
  matches: matchesView,
  safety: safetyView,
  moderator: moderatorView,
};

const view = document.getElementById('view');
const tabsBar = document.getElementById('tabs');
const personasBar = document.getElementById('personas');
const healthLabel = document.getElementById('health');
const logBody = document.getElementById('log-body');

/** @type {string} */
let tab = 'home';
/** @type {{ ageGate?: { title: string, body: string }, ageBand?: string } | null} */
let lastSignUp = null;

// -------------------------------------------------------------------------- chrome

function renderChrome() {
  personasBar.replaceChildren(
    ...all().map((persona) =>
      el(
        'button',
        {
          class: 'persona',
          type: 'button',
          'aria-current': String(persona.id === me()?.id),
          title: `account ${String(persona.state)} · identity ${String(persona.identity)}`,
          onclick: () => {
            select(persona.id);
            tab = 'home';
          },
        },
        [
          el('span', { class: 'dot', 'data-state': String(persona.state ?? 'active') }),
          persona.name,
          persona.id === me()?.id ? el('span', { class: 'note', text: ' (you)' }) : null,
        ],
      ),
    ),
  );
  tabsBar.replaceChildren(
    ...TABS.map(([id, label]) =>
      el('button', {
        type: 'button',
        'aria-current': id === tab ? 'page' : 'false',
        onclick: () => {
          tab = id;
          render();
        },
        text: label,
      }),
    ),
  );
}

document.getElementById('new-persona').addEventListener('click', () => {
  detach();
  lastSignUp = null;
  tab = 'home';
  render();
});

document.getElementById('log-toggle').addEventListener('click', (event) => {
  const hidden = logBody.hasAttribute('hidden');
  logBody.toggleAttribute('hidden', !hidden);
  event.target.textContent = hidden ? 'Hide' : 'Show';
  if (hidden) {
    renderLog();
  }
});
logBody.setAttribute('hidden', '');

onExchange(renderLog);
onChange(render);
onChrome(renderChrome);

function renderLog() {
  if (logBody.hasAttribute('hidden')) {
    return;
  }
  const entries = log();
  if (entries.length === 0) {
    logBody.replaceChildren(empty('No calls yet.'));
    return;
  }
  logBody.replaceChildren(
    ...entries.slice(0, 60).map((entry) =>
      el('div', { class: 'log-row' }, [
        el('div', { class: 'head' }, [
          el('span', { class: 'status s' + String(entry.status)[0], text: String(entry.status) }),
          el('code', { text: `${entry.method} ${entry.path}` }),
          el('span', { class: 'meta', text: entry.at }),
        ]),
        el('details', {}, [el('summary', { text: 'response' }), el('pre', { text: pretty(entry.response) })]),
      ]),
    ),
  );
}

async function pollHealth() {
  const once = async () => {
    try {
      const response = await fetch('/v1/health/ready');
      healthLabel.textContent = response.ok ? 'service ready' : `service not ready (${response.status})`;
    } catch {
      healthLabel.textContent = 'service unreachable';
    }
  };
  await once();
  setInterval(once, 15_000);
}

// --------------------------------------------------------------------------- render

function render() {
  renderChrome();
  if (me() === null) {
    view.replaceChildren(signInView());
    return;
  }
  view.replaceChildren(SCREENS[tab]());
}

setRerender(render);
render();
void pollHealth();

// -------------------------------------------------------------------------- sign in

function signInView() {
  const gate = lastSignUp?.ageGate;
  return el('div', {}, [
    el('h1', { text: 'Been There' }),
    el('p', {
      class: 'note',
      text:
        'Every person on this page is a real account in a real database, created through ' +
        'the service’s own endpoints. Sign up two, switch between them, and the whole ' +
        'journey is clickable: the age gate, verification, discovery, a like that becomes ' +
        'a match, a message, a block, a report, and a moderator restricting an account.',
    }),
    gate === undefined
      ? null
      : el('div', { class: 'allowed' }, [
          el('h3', { text: gate.title }),
          el('p', { text: gate.body }),
          el('p', { class: 'note', text: `Age band other members see: ${String(lastSignUp.ageBand)}` }),
        ]),
    el('div', { class: 'card' }, [el('h2', { text: 'Sign up' }), signupForm()]),
    el('div', { class: 'card' }, [el('h2', { text: 'Sign in' }), signInForm()]),
  ]);
}

function signupForm() {
  const name = el('input', { type: 'text', placeholder: 'Alice' });
  const contact = el('input', { type: 'email', placeholder: 'alice@example.test' });
  const dob = el('input', { type: 'date', value: '1996-06-15' });
  const password = el('input', { type: 'password', value: PASSWORD_SAMPLE });
  const status = el('div');
  return el('div', {}, [
    el('div', { class: 'grid' }, [
      field('Name on this browser', name),
      field('Contact', contact),
      field('Date of birth — the age gate', dob),
      field('Password', password),
    ]),
    el('button', {
      type: 'button',
      text: 'Create the account',
      onclick: async () => {
        const outcome = await call({
          token: null,
          method: 'POST',
          path: '/accounts',
          label: 'sign up',
          body: {
            contact: contact.value,
            password: password.value,
            dateOfBirth: dob.value,
            termsVersion: TERMS_VERSION,
          },
        });
        if (!outcome.ok) {
          status.replaceChildren(refusalPanel(outcome));
          return;
        }
        lastSignUp = outcome.body;
        setAgeGate({
          title: String(outcome.body.ageGate?.title ?? ''),
          body: String(outcome.body.ageGate?.body ?? ''),
          ageBand: String(outcome.body.ageBand ?? ''),
        });
        adopt({
          id: crypto.randomUUID(),
          name: name.value === '' ? contact.value : name.value,
          token: outcome.body.session.token,
          userId: outcome.body.userId,
          ageBand: String(outcome.body.ageBand ?? ''),
          state: 'active',
          identity: String(outcome.body.identity?.state ?? 'unverified'),
        });
        tab = 'home';
        render();
      },
    }),
    el('p', {
      class: 'note',
      text:
        'The service rate-limits sign-ups to five an hour per address, and when it does ' +
        'it says so here with the time it lifts rather than failing quietly.',
    }),
    status,
  ]);
}

function signInForm() {
  const contact = el('input', { type: 'email', placeholder: 'alice@example.test' });
  const password = el('input', { type: 'password' });
  const status = el('div');
  return el('div', {}, [
    el('div', { class: 'grid' }, [field('Contact', contact), field('Password', password)]),
    el('button', {
      type: 'button',
      text: 'Sign in',
      onclick: async () => {
        const outcome = await call({
          token: null,
          method: 'POST',
          path: '/account-sessions',
          label: 'sign in',
          body: { contact: contact.value, password: password.value },
        });
        if (!outcome.ok) {
          status.replaceChildren(refusalPanel(outcome));
          return;
        }
        const account = outcome.body?.user ?? outcome.body?.account ?? outcome.body;
        adopt({
          id: crypto.randomUUID(),
          name: contact.value,
          token: outcome.body.session.token,
          userId: account.userId,
          ageBand: String(account.ageBand ?? ''),
          state: 'active',
          identity: String(account.identity?.state ?? 'unverified'),
        });
        tab = 'home';
        render();
      },
    }),
    status,
  ]);
}

/** @param {string} label @param {HTMLElement} control */
function field(label, control) {
  return el('div', { class: 'field' }, [el('label', { text: label }), control]);
}

