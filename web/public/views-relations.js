/**
 * Matches, conversations, blocking and reporting.
 *
 * The send box never decides whether a message may go. It sends, and then prints
 * whatever came back: `201` with the stored message, or `403` with the
 * communication domain's reason and the rule that refused it. That refusal is the
 * product's claim about blocking, so the UI puts it on screen in full rather than
 * greying out a button and leaving the reader to guess.
 *
 * Reporting works the same way. The reason list is not written here — it is read
 * from the service's own edge validator, which publishes the permitted values when
 * it refuses an unrecognised one.
 */
import { call, reportReasons } from './api.js';
import { allowedPanel, el, empty, refusalPanel } from './dom.js';
import { act, conversationFor, me, rememberConversation } from './session.js';
import { rerender } from './views-account.js';

// -------------------------------------------------------------------- matches tab

/** @returns {HTMLElement} */
export function matchesView() {
  const node = el('div', { class: 'card' }, [el('p', { class: 'note', text: 'Reading matches…' })]);
  void (async () => {
    const persona = me();
    if (persona === null) {
      return;
    }
    const matches = await call({ token: persona.token, method: 'GET', path: '/matches', label: 'read matches' });
    if (!matches.ok) {
      node.replaceChildren(el('h1', { text: 'Matches' }), refusalPanel(matches));
      return;
    }
    const rows = matches.body?.matches ?? [];
    node.replaceChildren(
      el('h1', { text: 'Matches' }),
      el('p', { class: 'note', text: `${String(matches.body?.total ?? 0)} match(es).` }),
      rows.length === 0
        ? empty(
            'No matches yet. A like is only half of it — switch to the other persona and ' +
              'like back, and the service will create the match and open the conversation.',
          )
        : el('div', {}, rows.map((match) => matchCard(persona, match))),
    );
  })();
  return node;
}

/**
 * @param {{ userId: string, token: string }} persona
 * @param {{ matchId: string, participants: string[], standings: string[], endedAt: string | null, endedCause: string | null }} match
 * @returns {HTMLElement}
 */
function matchCard(persona, match) {
  const other = match.participants.find((id) => id !== persona.userId) ?? '';
  const known = conversationFor(persona.userId, other);
  const status = el('div');
  const ask = el('button', {
    type: 'button',
    class: 'ghost',
    text: 'Ask the service about this pair',
    onclick: async () => {
      const outcome = await act({
        label: 'ask the service about this pair',
        body: (bearer) =>
          call({
            token: bearer,
            method: 'POST',
            path: '/interactions/likes',
            body: { toUserId: other },
            label: 'ask the service about this pair',
          }),
      });
      if (outcome !== null && !outcome.ok) {
        status.replaceChildren(refusalPanel(outcome));
        rerender();
        return;
      }
      if (typeof outcome?.body?.conversationId === 'string') {
        rememberConversation(persona.userId, { conversationId: outcome.body.conversationId, match: outcome.body.match }, { userId: other, displayName: other });
        rerender();
        return;
      }
      status.replaceChildren(allowedPanel('The service answered:', outcome?.body));
    },
  });
  return el('div', { class: 'card' }, [
    el('h2', { text: 'Matched' }),
    el('p', { class: 'note', text: `With: ${other === '' ? '(unknown)' : other}` }),
    el('p', {
      class: 'meta',
      text: `Standings: ${match.standings.join(', ')} · ended: ${match.endedAt === null ? 'no' : `${match.endedAt} (${String(match.endedCause)})`}`,
    }),
    el('p', { class: 'meta', text: match.matchId }),
    known === null
      ? el('div', {}, [
          el('p', {
            class: 'note',
            text:
              'This page cannot open a conversation for this match. The only response ' +
              'that carries a conversationId is the like that created the match, and ' +
              'GET /v1/matches does not publish one. Rather than guess an id, ask the ' +
              'service — whatever it answers is shown below.',
          }),
          ask,
        ])
      : conversationPanel(known.conversationId),
    status,
  ]);
}

/**
 * A conversation this browser was told about, and a send box that asks.
 *
 * @param {string} conversationId
 * @returns {HTMLElement}
 */
function conversationPanel(conversationId) {
  const thread = el('div', { class: 'thread' });
  const status = el('div');
  const box = el('input', { type: 'text', placeholder: 'Say something' });

  const draw = async () => {
    const persona = me();
    if (persona === null) {
      return;
    }
    const outcome = await call({
      token: persona.token,
      method: 'GET',
      path: `/conversations/${conversationId}/messages`,
      label: 'read the conversation',
    });
    if (!outcome.ok) {
      thread.replaceChildren(refusalPanel(outcome));
      return;
    }
    const messages = outcome.body?.messages ?? [];
    thread.replaceChildren(
      ...(messages.length === 0
        ? [empty('No messages yet.')]
        : messages.map((message) =>
            el('div', { class: 'bubble' + (message.senderId === persona.userId ? ' mine' : '') }, [
              el('div', { text: message.body }),
              el('div', { class: 'meta', text: `${message.senderId === persona.userId ? 'you' : 'them'} · ${message.state}` }),
            ]),
          )),
    );
  };

  const send = async () => {
    const outcome = await act({
      label: 'send a message',
      body: (bearer) =>
        call({
          token: bearer,
          method: 'POST',
          path: `/conversations/${conversationId}/messages`,
          body: { body: box.value },
          label: 'send a message',
        }),
    });
    if (outcome === null) {
      return;
    }
    if (!outcome.ok) {
      status.replaceChildren(
        refusalPanel(outcome),
        el('p', {
          class: 'note',
          text:
            'That refusal came from the communication domain. This page checked nothing ' +
            'before pressing send — it asked, and this is the answer.',
        }),
      );
    } else {
      box.value = '';
      status.replaceChildren(allowedPanel('The service stored the message.', outcome.body));
    }
    await draw();
  };

  void draw();
  return el('div', {}, [
    el('p', { class: 'meta', text: `Conversation ${conversationId}` }),
    thread,
    el('div', { class: 'row' }, [box, el('button', { type: 'button', text: 'Send', onclick: () => void send() })]),
    status,
  ]);
}

// ---------------------------------------------------------------------- safety tab

/** @returns {HTMLElement} */
export function safetyView() {
  const node = el('div', { class: 'card' }, [el('p', { class: 'note', text: 'Reading discovery…' })]);
  void (async () => {
    const persona = me();
    if (persona === null) {
      return;
    }
    const status = el('div');
    const page = await call({
      token: persona.token,
      method: 'GET',
      path: '/discovery',
      query: { limit: '50', offset: '0' },
      label: 'read discovery',
    });
    if (!page.ok) {
      node.replaceChildren(el('h1', { text: 'Block and report' }), refusalPanel(page));
      return;
    }
    const candidates = page.body?.candidates ?? [];
    const target = el(
      'select',
      {},
      candidates.map((card) => el('option', { value: card.userId, text: `${card.displayName} — ${card.userId}` })),
    );
    const reason = el('select', {}, [el('option', { value: '', text: 'reading the service…' })]);
    const statement = el('textarea', { placeholder: 'What happened?' });
    void reportReasons(persona.token).then((reasons) => {
      reason.replaceChildren(
        ...reasons.map((slug) => el('option', { value: slug, text: slug.replaceAll('_', ' ') })),
      );
    });

    const submit = async (anonymous) => {
      const outcome = await act({
        label: 'submit a report',
        body: (bearer) =>
          call({
            token: bearer,
            method: 'POST',
            path: '/reports',
            body: { subjectUserId: target.value, reason: reason.value, statement: statement.value, anonymous },
            label: 'submit a report',
          }),
      });
      if (outcome !== null && !outcome.ok) {
        status.replaceChildren(refusalPanel(outcome));
      } else if (outcome !== null) {
        status.replaceChildren(allowedPanel('The service accepted the report.', outcome.body));
      }
    };

    node.replaceChildren(
      el('h1', { text: 'Block and report' }),
      el('p', {
        class: 'note',
        text:
          'A block is authored by one person and binds both: the service records who ' +
          'blocked whom, and after it neither party can send. Reporting survives the ' +
          'relationship — a report filed after an unmatch still reads the retained records.',
      }),
      el('div', { class: 'card' }, [
        el('h2', { text: 'Block' }),
        el('div', { class: 'field' }, [el('label', { text: 'Person' }), target]),
        el('p', {
          class: 'note',
          text:
            'Only people discovery returned are listed, because that is the only place ' +
            'this page has learned an id from. Switch personas to exercise the block from ' +
            'the other side, then try to send.',
        }),
        el('button', {
          type: 'button',
          class: 'danger',
          text: 'Block',
          onclick: async () => {
            const outcome = await act({
              label: 'block',
              body: (bearer) =>
                call({
                  token: bearer,
                  method: 'POST',
                  path: '/blocks',
                  body: { blockedUserId: target.value },
                  label: 'block',
                }),
            });
            if (outcome !== null && !outcome.ok) {
              status.replaceChildren(refusalPanel(outcome));
            } else if (outcome !== null) {
              status.replaceChildren(
                allowedPanel('The service recorded the block. Switch personas and try to send a message.', outcome.body),
              );
            }
          },
        }),
      ]),
      el('div', { class: 'card' }, [
        el('h2', { text: 'Report' }),
        el('p', {
          class: 'note',
          text:
            'The reason list was read from the service. It is not written in this page: ' +
            'an unrecognised value comes back as a validation failure naming what was ' +
            'allowed, and that is the list you see.',
        }),
        el('div', { class: 'field' }, [el('label', { text: 'Reason' }), reason]),
        el('div', { class: 'field' }, [el('label', { text: 'Statement' }), statement]),
        el('div', { class: 'row' }, [
          el('button', { type: 'button', text: 'Report anonymously', onclick: () => void submit(true) }),
          el('button', { type: 'button', class: 'ghost', text: 'Report under my name', onclick: () => void submit(false) }),
        ]),
      ]),
      status,
    );
  })();
  return node;
}

export { conversationPanel };
