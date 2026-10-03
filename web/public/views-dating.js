/**
 * Profile and discovery.
 *
 * The profile screen never says "your bio is too short". It sends what the person
 * typed and renders the `missing` array the service answered with, because that
 * array is the domain's completeness rule and a second copy in the browser would
 * be one more place for the two to disagree.
 *
 * Discovery pages the population, because that is what the endpoint does: it takes
 * an `offset` over `app.users` ordered by creation and asks the dating domain
 * about each candidate. The UI shows the offset it asked for so a person can see
 * why their colleague is on page four.
 */
import { call } from './api.js';
import { allowedPanel, checklist, el, empty, refusalPanel } from './dom.js';
import { act, me, rememberConversation } from './session.js';
import { rerender } from './views-account.js';

/** @returns {HTMLElement} */
export function profileView() {
  const node = el('div', { class: 'card' }, [el('p', { class: 'note', text: 'Reading the profile…' })]);
  void (async () => {
    const persona = me();
    if (persona === null) {
      return;
    }
    const [profile, preferences, photos] = await Promise.all([
      call({ token: persona.token, method: 'GET', path: '/profiles/me', label: 'read the profile' }),
      call({ token: persona.token, method: 'GET', path: '/profiles/me/preferences', label: 'read preferences' }),
      call({ token: persona.token, method: 'GET', path: '/profiles/me/photos', label: 'read photos' }),
    ]);
    if (!profile.ok) {
      node.replaceChildren(el('h1', { text: 'Profile' }), refusalPanel(profile));
      return;
    }
    const fields = el('div', { class: 'grid' });
    const status = el('div');

    const save = async (label, path, body) => {
      const outcome = await act({
        label,
        body: (bearer) => call({ token: bearer, method: 'PUT', path, body, label }),
      });
      if (outcome !== null && !outcome.ok) {
        status.replaceChildren(refusalPanel(outcome));
      } else if (outcome !== null) {
        status.replaceChildren(allowedPanel(label, outcome.body));
      }
      rerender();
    };
    renderFields(fields, persona.name);

    node.replaceChildren(
      el('h1', { text: 'Profile' }),
      el('div', { class: 'card' }, [
        el('h2', { text: 'What the service says is missing' }),
        checklist(profile.body.missing ?? [], []),
        el('p', { class: 'note', text: `State: ${String(profile.body.state)}` }),
      ]),
      el('div', { class: 'card' }, [
        el('h2', { text: 'Profile fields' }),
        fields,
        el('button', { type: 'button', text: 'Save fields', onclick: () => save('save the profile fields', '/profiles/me', readFields(fields)) }),
        status,
      ]),
      el('div', { class: 'card' }, [
        el('h2', { text: 'Photos' }),
        photosPanel(photos),
      ]),
      el('div', { class: 'card' }, [
        el('h2', { text: 'Preferences' }),
        el('pre', { text: prettyOr(preferences.body) }),
        el('button', {
          type: 'button',
          text: 'Open to everyone, 18–99, within 50 km',
          onclick: () =>
            save('save preferences', '/profiles/me/preferences', {
              seekingGenders: ['woman', 'man', 'non_binary'],
              ageRange: { min: 18, max: 99 },
              maxDistanceKm: 50,
            }),
        }),
      ]),
    );
  })();
  return node;
}

/**
 * @param {HTMLElement} container
 * @returns {Record<string, unknown>}
 */
function readFields(container) {
  const value = (name) => container.querySelector(`[name="${name}"]`)?.value ?? '';
  const genders = [...container.querySelectorAll('[name="gender"]')]
    .filter((box) => box.checked)
    .map((box) => box.value);
  return {
    displayName: value('displayName'),
    bio: value('bio'),
    genderIdentities: genders,
    prompts: [{ promptId: 'prompt.weekend', text: value('prompt') }],
    location: value('location'),
  };
}

/**
 * @param {HTMLElement} container
 * @param {string} displayName
 */
function renderFields(container, displayName) {
  container.replaceChildren(
    labelled('Display name', el('input', { type: 'text', name: 'displayName', value: displayName })),
    labelled('Bio', el('textarea', { name: 'bio', value: 'Long walks, short pub closing times.' })),
    labelled(
      'Gender identities',
      el(
        'div',
        { class: 'row' },
        ['woman', 'man', 'non_binary', 'self_described'].map((identity) =>
          el('label', { class: 'row' }, [
            el('input', { type: 'checkbox', name: 'gender', value: identity }),
            identity.replaceAll('_', ' '),
          ]),
        ),
      ),
    ),
    labelled('Prompt answer', el('input', { type: 'text', name: 'prompt', value: 'Ceramics on Sundays.' })),
    labelled(
      'Distance band',
      el(
        'select',
        { name: 'location' },
        ['lt_5_km', '5_25_km', '25_50_km', '50_100_km', 'gt_100_km', 'unknown'].map((band) =>
          el('option', { value: band, text: band }),
        ),
      ),
    ),
  );
}

/**
 * @param {{ ok: boolean, body: { photos?: readonly { photoId: string, state: string, altText: string }[] } }} photos
 * @returns {HTMLElement}
 */
function photosPanel(photos) {
  const status = el('div');
  const list = el('div');
  const draw = () => {
    const held = photos.body?.photos ?? [];
    list.replaceChildren(
      ...held.map((photo) =>
        el('div', { class: 'row' }, [
          el('span', { text: `${photo.altText} (${photo.state})` }),
          photo.state === 'scanning'
            ? el('button', {
                type: 'button',
                class: 'ghost',
                text: 'Screening verdict: clean',
                onclick: async () => {
                  const outcome = await act({
                    label: 'record the screening verdict',
                    body: (bearer) =>
                      call({
                        token: bearer,
                        method: 'PUT',
                        path: `/profiles/me/photos/${photo.photoId}/screening`,
                        body: { verdict: 'clean' },
                        label: 'record the screening verdict',
                      }),
                  });
                  if (outcome !== null && !outcome.ok) {
                    status.replaceChildren(refusalPanel(outcome));
                  } else if (outcome !== null) {
                    status.replaceChildren(allowedPanel('The service recorded the verdict.', outcome.body));
                  }
                  rerender();
                },
              })
            : null,
        ]),
      ),
    );
  };
  draw();
  return el('div', {}, [
    el('p', {
      class: 'note',
      text:
        'A photo only joins the profile once the screening verdict is recorded, so the ' +
        'two steps are separate here exactly as they are on the service.',
    }),
    el('button', {
      type: 'button',
      text: 'Add a photo',
      onclick: async () => {
        const outcome = await act({
          label: 'add a photo',
          body: (bearer) =>
            call({
              token: bearer,
              method: 'POST',
              path: '/profiles/me/photos',
              body: {
                mediaAssetId: `asset-${crypto.randomUUID().slice(0, 8)}`,
                altText: 'A portrait photo',
              },
              label: 'add a photo',
            }),
        });
        if (outcome !== null && !outcome.ok) {
          status.replaceChildren(refusalPanel(outcome));
        } else if (outcome !== null) {
          status.replaceChildren(allowedPanel('The service accepted the photo.', outcome.body));
        }
        rerender();
      },
    }),
    list,
    status,
  ]);
}

/** @param {string} label @param {HTMLElement} control */
function labelled(label, control) {
  return el('div', { class: 'field' }, [el('label', { text: label }), control]);
}

/** @param {unknown} value @returns {string} */
function prettyOr(value) {
  return JSON.stringify(value, null, 2) ?? 'null';
}

// ------------------------------------------------------------------ discovery tab

/**
 * @param {{ kind: 'like', userId: string, displayName: string }[]} seen
 * @returns {HTMLElement}
 */
export function discoverView() {
  const node = el('div', { class: 'card' }, [el('p', { class: 'note', text: 'Reading discovery…' })]);
  void (async () => {
    const persona = me();
    if (persona === null) {
      return;
    }
    const result = el('div');
    const status = el('div');
    let offset = 0;

    const load = async () => {
      const outcome = await call({
        token: persona.token,
        method: 'GET',
        path: '/discovery',
        query: { limit: '50', offset: String(offset) },
        label: `read discovery at offset ${offset}`,
      });
      if (!outcome.ok) {
        result.replaceChildren(refusalPanel(outcome));
        return;
      }
      const candidates = outcome.body?.candidates ?? [];
      result.replaceChildren(
        el('p', {
          class: 'note',
          text: `Population page at offset ${offset}: ${candidates.length} card(s) of ${String(outcome.body?.total ?? 0)} on this page.`,
        }),
        candidates.length === 0
          ? empty(
              'No cards on this page. Discovery pages the whole population and asks the ' +
                'dating domain about each candidate, so people who are not verified, or ' +
                'whose profile is not complete, or whom you have blocked, are simply not ' +
                'here — the service does not say which, and neither does this page.',
            )
          : el(
              'div',
              {},
              candidates.map((card) => candidateCard(card, persona.userId, status)),
            ),
      );
    };

    await load();
    node.replaceChildren(
      el('h1', { text: 'Discovery' }),
      el('p', {
        class: 'note',
        text:
          'Every card here passed `evaluateEligibility` on the server. The client ' +
          'cannot add one that did not, and cannot remove one that did.',
      }),
      el('div', { class: 'row' }, [
        el('button', { type: 'button', class: 'ghost', text: 'Previous page', onclick: () => { offset = Math.max(0, offset - 50); void load(); } }),
        el('button', { type: 'button', class: 'ghost', text: 'Next page', onclick: () => { offset += 50; void load(); } }),
      ]),
      result,
      status,
    );
  })();
  return node;
}

/**
 * @param {{ userId: string, displayName: string, age: number, bio: string, genderIdentities: string[], distance: string, photoIds: string[] }} card
 * @param {string} viewerId
 * @param {HTMLElement} status
 */
function candidateCard(card, viewerId, status) {
  const node = el('div', { class: 'candidate' }, [
    el('div', { class: 'name', text: `${card.displayName}, ${String(card.age)}` }),
    el('div', { class: 'meta', text: `${card.genderIdentities.join(', ')} · distance ${card.distance} · ${card.photoIds.length} photo(s)` }),
    el('p', { text: card.bio }),
    el('p', { class: 'meta', text: card.userId }),
    el('div', { class: 'row' }, [
      el('button', {
        type: 'button',
        text: 'Like',
        onclick: () => interact('/interactions/likes', { toUserId: card.userId }, `like ${card.displayName}`),
      }),
      el('button', {
        type: 'button',
        class: 'ghost',
        text: 'Pass',
        onclick: () => interact('/interactions/passes', { toUserId: card.userId }, `pass ${card.displayName}`),
      }),
      el('button', {
        type: 'button',
        class: 'danger',
        text: 'Block',
        onclick: () => interact('/blocks', { blockedUserId: card.userId }, `block ${card.displayName}`),
      }),
      viewerId === card.userId ? el('span', { class: 'note', text: 'this is you' }) : null,
    ]),
  ]);

  /**
   * Send the interaction, show what came back, and take the card away in place.
   *
   * The card is removed rather than the screen re-rendered, because the answer —
   * `awaiting_counterpart` or `match_created` — is the interesting part and a
   * re-render would replace it with an empty panel. The service decides whether
   * the card is still eligible; this is only taking down one the service has
   * just acted on.
   *
   * @param {string} path
   * @param {Record<string, unknown>} body
   * @param {string} label
   */
  const interact = async (path, body, label) => {
    const outcome = await act({
      label,
      body: (bearer) => call({ token: bearer, method: 'POST', path, body, label }),
    });
    if (outcome === null) {
      return;
    }
    status.replaceChildren(
      outcome.ok ? allowedPanel(label, outcome.body) : refusalPanel(outcome),
      outcome.ok
        ? el('p', {
            class: 'note',
            text:
              outcome.body?.resolution === 'awaiting_counterpart'
                ? 'The service recorded the like and is waiting for the other person. Switch ' +
                  'personas and like back to see it become a match.'
                : outcome.body?.resolution === 'match_created'
                  ? 'The service created the match and opened the conversation. It is on the ' +
                    'Matches tab.'
                  : 'The service recorded this interaction. See the response above for the ' +
                    'resolution it gave.',
          })
        : null,
    );
    if (outcome.ok) {
      if (typeof outcome.body?.conversationId === 'string') {
        rememberConversation(viewerId, { conversationId: outcome.body.conversationId, match: outcome.body.match }, card);
      }
      node.remove();
    }
  };

  return node;
}
