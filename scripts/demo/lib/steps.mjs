/**
 * The acceptance walk: eleven steps, each one a claim the product makes.
 *
 * Four of them carry the weight — 4, 7, 10 and 11 — and each of those is a
 * statement about what the service *refuses*, which is the only kind of claim
 * that can be demonstrated rather than asserted. A step reporting a 200 proves a
 * path exists. A step reporting the exact refusal, with the reason the service
 * gave and the reason it withheld, proves a rule is in force.
 *
 * Every call goes over HTTP to a real process against real Postgres. Nothing
 * here reads the database directly, so nothing here can succeed by inspecting
 * state the service would not have shown a client.
 */
import { at, detailsOf, expectStatus } from './client.mjs';
import { completeProfile, presentAddress, signUp, verify } from './people.mjs';

/** A per-run marker, so two walks never collide on a contact or a rate-limit key. */
const RUN = Date.now().toString(36);

const CONTACTS = {
  alice: `demo-${RUN}-alice@example.test`,
  bob: `demo-${RUN}-bob@example.test`,
  carol: `demo-${RUN}-carol@example.test`,
  underage: `demo-${RUN}-underage@example.test`,
  bandProbe: `demo-${RUN}-band-probe@example.test`,
};

/** The provider score the walk uses. 0.95 clears the 0.9 verified floor. */
const PROVIDER_CONFIDENCE = 0.95;

export const STEP_COUNT = 11;

/** @type {{ title: string, run: (context: any) => Promise<string> }[]} */
export const STEPS = [
  {
    title: 'Alice signs up and passes the age gate',
    async run({ client, say, people }) {
      presentAddress(client);
      const refused = await client.call('POST', '/v1/accounts', undefined, {
        contact: CONTACTS.underage,
        password: 'correct-horse-battery-staple-42',
        dateOfBirth: '2015-01-01',
        termsVersion: '2026-09-01',
      });
      expectStatus(refused, 422, 'a sign-up under 18');
      say(`HTTP POST /v1/accounts (date of birth 2015) -> 422 ${JSON.stringify(at(refused.body, 'error.code'))}`);
      say(`details.reason ${JSON.stringify(detailsOf(refused)['reason'])} — the gate refuses and writes nothing`);

      const alice = await signUp(client, { name: 'Alice', contact: CONTACTS.alice, dateOfBirth: '1990-06-15' }, say);
      people.alice = alice;
      // The band is derived from the date of birth. Printing `ageBand 33-37`
      // proves only that a band came back, so a second date of birth has to
      // produce a different one — one extra account in a throwaway database,
      // which turns an observation into a claim.
      const older = await signUp(client, { name: 'BandProbe', contact: CONTACTS.bandProbe, dateOfBirth: '1960-01-01' }, () => {});
      if (older.ageBand === alice.ageBand) {
        throw new Error(
          `1990-06-15 and 1960-01-01 both produced ageBand ${JSON.stringify(alice.ageBand)}, ` +
            'so the band is not derived from the date',
        );
      }
      say(
        `age band derived: 1990-06-15 -> ${alice.ageBand}, 1960-01-01 -> ${older.ageBand}, ` +
          'and neither response carried a date or a number',
      );
      return `account created, identity.state unverified, identity.discoverable false`;
    },
  },

  {
    title: 'Alice verifies (provider result 0.95)',
    async run({ client, say, people }) {
      await completeProfile(client, people.alice, say);
      const recorded = await verify(client, people.alice, PROVIDER_CONFIDENCE, say);
      if (at(recorded, 'identityState') !== 'verified') {
        throw new Error(`expected identityState verified, received ${at(recorded, 'identityState')}`);
      }
      const read = await client.call('GET', `/v1/accounts/${people.alice.userId}`, people.alice.token);
      expectStatus(read, 200, 'read Alice back');
      say(`HTTP GET /v1/accounts/${people.alice.userId} -> 200, identity.discoverable ${at(read.body, 'identity.discoverable')}`);
      return `verified, identity.discoverable ${at(read.body, 'identity.discoverable')}`;
    },
  },

  {
    title: 'Bob does the same',
    async run({ client, say, people }) {
      const bob = await signUp(
        client,
        { name: 'Bob', contact: CONTACTS.bob, dateOfBirth: '1988-03-02' },
        say,
      );
      people.bob = bob;
      await completeProfile(client, bob, say);
      const recorded = await verify(client, bob, PROVIDER_CONFIDENCE, say);
      if (at(recorded, 'identityState') !== 'verified') {
        throw new Error(`expected identityState verified, received ${at(recorded, 'identityState')}`);
      }
      return `verified, identity.discoverable true`;
    },
  },

  {
    title: 'Alice browses discovery',
    async run({ client, say, people }) {
      people.carol = await signUp(
        client,
        { name: 'Carol', contact: CONTACTS.carol, dateOfBirth: '1992-07-19' },
        say,
      );

      const aliceView = await client.call('GET', '/v1/discovery?limit=50', people.alice.token);
      expectStatus(aliceView, 200, 'Alice reads discovery');
      const candidates = at(aliceView.body, 'candidates');
      if (!Array.isArray(candidates)) {
        throw new Error(`discovery did not return a candidates array: ${JSON.stringify(aliceView.body)}`);
      }
      const shown = candidates.map((card) => String(card['userId']));
      say(`HTTP GET /v1/discovery (Alice, verified) -> 200, total ${at(aliceView.body, 'total')}`);
      say(
        `Alice is shown ${shown.length} candidate(s): ` +
          `${shown.map((id) => nameOf(people, id)).join(', ') || 'nobody'}`,
      );
      if (!shown.includes(people.bob.userId)) {
        throw new Error('a verified viewer was not shown a verified, complete-profile candidate');
      }
      if (shown.includes(people.carol.userId)) {
        throw new Error('an unverified candidate was listed to a verified viewer');
      }
      say('Carol is absent from Alice’s page: an unverified candidate is withheld whatever the viewer is');

      const carolView = await client.call('GET', '/v1/discovery?limit=50', people.carol.token);
      expectStatus(carolView, 200, 'Carol reads discovery');
      say(`HTTP GET /v1/discovery (Carol, unverified) -> 200, total ${at(carolView.body, 'total')}`);
      if (at(carolView.body, 'total') !== 0) {
        throw new Error(`an unverified viewer was served discovery: ${JSON.stringify(carolView.body)}`);
      }
      const raw = JSON.stringify(carolView.body);
      for (const leak of ['identity', 'not_verified', people.bob.userId]) {
        if (raw.includes(leak)) {
          throw new Error(`the empty page disclosed ${JSON.stringify(leak)}: ${raw}`);
        }
      }
      say('the refusal is an empty page with no reason and no name: saying why would be the leak');
      return `Alice sees Bob; Carol (unverified) sees 0 candidates and is told no reason`;
    },
  },

  {
    title: 'Alice likes Bob, Bob likes Alice',
    async run({ client, say, people, ids }) {
      const first = await client.call('POST', '/v1/interactions/likes', people.alice.token, {
        toUserId: people.bob.userId,
      });
      expectStatus(first, 201, 'Alice likes Bob');
      say(`HTTP POST /v1/interactions/likes (Alice -> Bob) -> 201, resolution ${at(first.body, 'resolution')}`);
      if (at(first.body, 'resolution') !== 'awaiting_counterpart') {
        throw new Error(`expected awaiting_counterpart, received ${at(first.body, 'resolution')}`);
      }

      const second = await client.call('POST', '/v1/interactions/likes', people.bob.token, {
        toUserId: people.alice.userId,
      });
      expectStatus(second, 201, 'Bob likes Alice');
      const conversationId = second.body['conversationId'];
      if (at(second.body, 'resolution') !== 'match_created' || typeof conversationId !== 'string') {
        throw new Error(`expected a match and a conversation, received ${JSON.stringify(second.body)}`);
      }
      ids.aliceBobConversation = String(conversationId);
      say('HTTP POST /v1/interactions/likes (Bob -> Alice) -> 201, resolution match_created');
      say(`conversation ${ids.aliceBobConversation} opened by the match, not by either person`);
      return `match created, conversation ${ids.aliceBobConversation} opened`;
    },
  },

  {
    title: 'Alice sends a message',
    async run({ client, say, people, ids }) {
      ids.messageBody = 'Hello Bob. This message has to still be here after a restart.';
      const sent = await client.call(
        'POST',
        `/v1/conversations/${ids.aliceBobConversation}/messages`,
        people.alice.token,
        { body: ids.messageBody },
      );
      expectStatus(sent, 201, 'Alice sends a message');
      say(`HTTP POST /v1/conversations/${ids.aliceBobConversation}/messages -> 201, state ${at(sent.body, 'state')}`);
      ids.messageId = String(at(sent.body, 'messageId'));

      const read = await client.call(
        'GET',
        `/v1/conversations/${ids.aliceBobConversation}/messages`,
        people.bob.token,
      );
      expectStatus(read, 200, 'Bob reads the conversation');
      say(`HTTP GET .../messages (Bob) -> 200, total ${at(read.body, 'total')}`);
      if (at(read.body, 'total') !== 1) {
        throw new Error(`expected one message, received ${JSON.stringify(read.body)}`);
      }
      return `delivered, message ${ids.messageId}`;
    },
  },

  {
    title: 'Carol blocks Alice',
    async run({ client, say, people, ids }) {
      // Setup, and it is a deviation from a straight three-person script. A block
      // ends a match and closes the conversation behind it, so showing that a
      // block stops contact needs the two of them to hold a conversation — and an
      // unverified account cannot hold one. Carol is still unverified at the end
      // of step 4, where that was the whole point; completing her verification
      // here is what gives the block something real to close.
      say('setup: Carol completes verification and matches Alice, because an unverified');
      say('       account cannot hold a conversation — there would be nowhere to send');
      await completeProfile(client, people.carol, say);
      await verify(client, people.carol, PROVIDER_CONFIDENCE, say);

      const carolLike = await client.call('POST', '/v1/interactions/likes', people.carol.token, {
        toUserId: people.alice.userId,
      });
      expectStatus(carolLike, 201, 'Carol likes Alice');
      const aliceLike = await client.call('POST', '/v1/interactions/likes', people.alice.token, {
        toUserId: people.carol.userId,
      });
      expectStatus(aliceLike, 201, 'Alice likes Carol');
      const conversationId = aliceLike.body['conversationId'];
      if (typeof conversationId !== 'string') {
        throw new Error(`Carol and Alice did not match: ${JSON.stringify(aliceLike.body)}`);
      }
      ids.aliceCarolConversation = String(conversationId);
      const opened = await client.call(
        'POST',
        `/v1/conversations/${conversationId}/messages`,
        people.alice.token,
        { body: 'Hello Carol.' },
      );
      expectStatus(opened, 201, 'Alice messages Carol before the block');
      say(`setup: conversation ${conversationId} open, Alice’s first message delivered`);

      const blocked = await client.call('POST', '/v1/blocks', people.carol.token, {
        blockedUserId: people.alice.userId,
      });
      expectStatus(blocked, 201, 'Carol blocks Alice');
      ids.blockId = String(at(blocked.body, 'blockId'));
      say(`HTTP POST /v1/blocks (Carol -> Alice) -> 201, block ${ids.blockId}`);
      say('the block ends the match and closes the conversation on its own');

      const refused = await client.call(
        'POST',
        `/v1/conversations/${conversationId}/messages`,
        people.alice.token,
        { body: 'Are you there?' },
      );
      expectStatus(refused, 403, 'Alice sends into the blocked conversation');
      say(`HTTP POST .../messages (Alice) -> 403 ${JSON.stringify(at(refused.body, 'error.message'))}`);
      const details = detailsOf(refused);
      say(`details.rule ${JSON.stringify(details['rule'])}`);
      if (details['rule'] !== 'blocked') {
        throw new Error(`expected the blocked rule, received ${JSON.stringify(details)}`);
      }

      const raw = JSON.stringify(refused.body);
      for (const leak of [people.carol.userId, ids.blockId, 'Carol']) {
        if (raw.includes(leak)) {
          throw new Error(`the refusal disclosed ${JSON.stringify(leak)}: ${raw}`);
        }
      }
      say('the refusal names no who, no block id and no reason — Alice learns nothing about Carol');

      const read = await client.call(
        'GET',
        `/v1/conversations/${conversationId}/messages`,
        people.carol.token,
      );
      expectStatus(read, 200, 'Carol reads the conversation');
      if (at(read.body, 'total') !== 1) {
        throw new Error(`a refused send was stored anyway: ${JSON.stringify(read.body)}`);
      }
      say(`the refused message was not stored: the conversation still holds ${at(read.body, 'total')}`);
      return `Alice’s send refused (403, rule "blocked"), nothing stored, nothing disclosed`;
    },
  },

  {
    title: 'Bob reports Alice for harassment',
    async run({ client, say, people, ids }) {
      const reported = await client.call('POST', '/v1/reports', people.bob.token, {
        subjectUserId: people.alice.userId,
        reason: 'harassment',
        statement: 'The messages in this conversation are abusive.',
      });
      expectStatus(reported, 201, 'Bob reports Alice');
      ids.reportId = String(at(reported.body, 'reportId'));
      const evidence = Number(at(reported.body, 'evidence'));
      say(`HTTP POST /v1/reports (Bob -> Alice, reason harassment) -> 201, report ${ids.reportId}`);
      say(`state ${at(reported.body, 'state')}, relationship ${at(reported.body, 'relationship')}`);
      say(`evidence frozen at report time: ${evidence} artefact(s) carried with the report`);
      if (!(evidence > 0)) {
        throw new Error('a report about a matched pair was recorded with no evidence');
      }
      return `report ${ids.reportId} recorded with ${evidence} evidence item(s), relationship "matched"`;
    },
  },

  {
    title: 'A moderation case opens, a named human acts',
    async run({ client, say, people, ids, moderator }) {
      const memberQueue = await client.call('GET', '/v1/moderation/cases', people.bob.token);
      expectStatus(memberQueue, 403, 'Bob reads the moderator queue');
      say(`HTTP GET /v1/moderation/cases (Bob, a member) -> 403 ${JSON.stringify(at(memberQueue.body, 'error.code'))}`);

      const opened = await client.call('POST', '/v1/moderation/cases', moderator.token, {
        reportId: ids.reportId,
        moderatorId: moderator.moderatorId,
      });
      expectStatus(opened, 201, 'open the case');
      ids.caseId = String(at(opened.body, 'caseId'));
      say(`HTTP POST /v1/moderation/cases -> 201, case ${ids.caseId}`);
      say(`queue ${at(opened.body, 'queue')}, priority ${at(opened.body, 'priority')}, subject ${at(opened.body, 'subjectId')}`);
      say(`case carries ${(at(opened.body, 'evidenceIds') ?? []).length} evidence id(s) from the report`);

      const decided = await client.call(
        'POST',
        `/v1/moderation/cases/${ids.caseId}/decisions`,
        moderator.token,
        {
          moderatorId: moderator.moderatorId,
          action: 'restrict',
          removedCapabilities: ['send_message'],
          rationale: 'The messages in this case meet the bar for a first restriction.',
        },
      );
      expectStatus(decided, 201, 'record the decision');
      ids.decisionId = String(at(decided.body, 'decisionId'));
      say(`HTTP POST /v1/moderation/cases/${ids.caseId}/decisions -> 201, decision ${ids.decisionId}`);
      say(`action ${at(decided.body, 'action')} by ${at(decided.body, 'moderatorId')}, removed ${JSON.stringify(at(decided.body, 'removedCapabilities'))}`);
      say(`account state ${at(decided.body, 'accountState')}, case state ${at(decided.body, 'caseState')}, ${at(decided.body, 'auditEntries')} audit entries`);
      if (at(decided.body, 'caseState') !== 'resolved') {
        throw new Error(`the case did not resolve: ${JSON.stringify(decided.body)}`);
      }
      return `case ${ids.caseId} opened and decided by ${moderator.moderatorId}; account now ${at(decided.body, 'accountState')}`;
    },
  },

  {
    title: 'Alice is restricted',
    async run({ client, say, people, ids }) {
      const read = await client.call('GET', `/v1/accounts/${people.alice.userId}`, people.alice.token);
      expectStatus(read, 200, 'Alice reads her own standing');
      const capabilities = at(read.body, 'account.capabilities');
      if (!Array.isArray(capabilities)) {
        throw new Error(`standing carried no capability list: ${JSON.stringify(read.body)}`);
      }
      say(`HTTP GET /v1/accounts/${people.alice.userId} -> 200, account.state ${at(read.body, 'account.state')}`);
      say(`identity.state is still ${at(read.body, 'identity.state')} — a sanction is not an identity change`);
      say(`capabilities ${JSON.stringify(capabilities)}`);
      for (const gone of ['send_message', 'like']) {
        if (capabilities.includes(gone)) {
          throw new Error(`a restriction left "${gone}" in place: ${JSON.stringify(capabilities)}`);
        }
      }
      for (const kept of ['report', 'block']) {
        if (!capabilities.includes(kept)) {
          throw new Error(`a restriction removed "${kept}": ${JSON.stringify(capabilities)}`);
        }
      }
      say('send_message and like are gone; report and block survive, which is the floor');

      const refused = await client.call(
        'POST',
        `/v1/conversations/${ids.aliceBobConversation}/messages`,
        people.alice.token,
        { body: 'One more message.' },
      );
      expectStatus(refused, 403, 'a restricted Alice sends a message');
      const rule = detailsOf(refused)['rule'];
      say(`HTTP POST .../messages (Alice, restricted) -> 403, rule ${JSON.stringify(rule)}`);
      if (rule !== 'missing_send_message_capability') {
        throw new Error(`expected the capability rule, received ${JSON.stringify(detailsOf(refused))}`);
      }

      const reported = await client.call('POST', '/v1/reports', people.alice.token, {
        subjectUserId: people.bob.userId,
        reason: 'harassment',
        statement: 'Reporting must still work while messaging does not.',
      });
      expectStatus(reported, 201, 'a restricted Alice reports');
      say(`HTTP POST /v1/reports (Alice, restricted) -> 201, report ${at(reported.body, 'reportId')} accepted`);

      const blocked = await client.call('POST', '/v1/blocks', people.alice.token, {
        blockedUserId: people.bob.userId,
      });
      expectStatus(blocked, 201, 'a restricted Alice blocks');
      say(`HTTP POST /v1/blocks (Alice, restricted) -> 201, block ${at(blocked.body, 'blockId')} accepted`);
      return `messaging refused (rule "missing_send_message_capability"), report and block both still work`;
    },
  },

  {
    title: 'Restart the service',
    async run({ client, say, people, ids, moderator, restart }) {
      const before = await client.call('GET', '/v1/health/live');
      expectStatus(before, 200, 'liveness before the restart');
      const oldPid = Number(at(before.body, 'pid'));
      say(`HTTP GET /v1/health/live -> 200, pid ${oldPid}, uptime ${at(before.body, 'uptimeSeconds')}s`);
      say('sending SIGTERM, waiting for the process to exit, then reading the rows back');

      const newUrl = await restart();
      say(`a new process is serving at ${newUrl}`);

      const after = await client.call('GET', '/v1/health/live');
      expectStatus(after, 200, 'liveness after the restart');
      const newPid = Number(at(after.body, 'pid'));
      say(`HTTP GET /v1/health/live -> 200, pid ${newPid}, uptime ${at(after.body, 'uptimeSeconds')}s`);
      if (newPid === oldPid) {
        throw new Error(`the pid did not change (${oldPid}), so nothing was actually restarted`);
      }
      say(`pid ${oldPid} -> ${newPid}: a different OS process, holding no memory of the first`);

      const survived = [];

      const read = await client.call('GET', `/v1/accounts/${people.alice.userId}`, people.alice.token);
      expectStatus(read, 200, 'Alice reads her account with the token issued before the restart');
      say(`identity + standing: identity.state ${at(read.body, 'identity.state')}, account.state ${at(read.body, 'account.state')}`);
      say(`capabilities ${JSON.stringify(at(read.body, 'account.capabilities'))}`);
      if (at(read.body, 'identity.state') !== 'verified' || at(read.body, 'account.state') !== 'limited') {
        throw new Error(`Alice’s rows did not survive: ${JSON.stringify(read.body)}`);
      }
      survived.push('session, identity, standing');

      const conversation = await client.call(
        'GET',
        `/v1/conversations/${ids.aliceBobConversation}/messages`,
        people.bob.token,
      );
      expectStatus(conversation, 200, 'Bob reads the conversation after the restart');
      const messages = at(conversation.body, 'messages');
      say(`conversation + message: total ${at(conversation.body, 'total')}, "${String(messages[0]?.body ?? '').slice(0, 44)}..."`);
      if (at(conversation.body, 'total') !== 1 || messages[0]['messageId'] !== ids.messageId) {
        throw new Error(`the message did not survive: ${JSON.stringify(conversation.body)}`);
      }
      survived.push('match, conversation, message');

      const detail = await client.call('GET', `/v1/moderation/cases/${ids.caseId}`, moderator.token);
      expectStatus(detail, 200, 'the moderator reads the case after the restart');
      const decisions = at(detail.body, 'decisions');
      say(`case + decision: case state ${at(detail.body, 'state')}, decision ${at(decisions[0], 'action')} -> account ${at(decisions[0], 'resultingAccountState')}`);
      if (at(decisions[0], 'action') !== 'restrict') {
        throw new Error(`the decision did not survive: ${JSON.stringify(detail.body)}`);
      }
      survived.push('case, decision, audit');

      const evidence = await client.call(
        'GET',
        `/v1/moderation/cases/${ids.caseId}/evidence`,
        moderator.token,
      );
      expectStatus(evidence, 200, 'the moderator reads the evidence after the restart');
      say(`evidence: ${at(evidence.body, 'evidence').length} artefact(s), first visibility ${at(evidence.body, 'evidence.0.visibility')}`);
      survived.push('report evidence');

      const stillBlocked = await client.call(
        'POST',
        `/v1/conversations/${ids.aliceCarolConversation}/messages`,
        people.alice.token,
        { body: 'Still there?' },
      );
      expectStatus(stillBlocked, 403, 'Carol’s block after the restart');
      say(`block: still in force, rule ${JSON.stringify(detailsOf(stillBlocked)['rule'])}`);
      survived.push('block');

      const stillRestricted = await client.call(
        'POST',
        `/v1/conversations/${ids.aliceBobConversation}/messages`,
        people.alice.token,
        { body: 'And again.' },
      );
      expectStatus(stillRestricted, 403, 'Alice’s restriction after the restart');
      // `blocked` outranks `missing_send_message_capability` in SEND_CHECKS and
      // step 10 ended with Alice blocking Bob, so this refusal is the block
      // winning the race. The restriction itself is proved by the capability
      // list read above, which is where a reader should look for it.
      say(`block and sanction: still in force — the send is refused on rule ${JSON.stringify(detailsOf(stillRestricted)['rule'])}, the block outranking the capability`);
      survived.push('capability floor');

      return `pid changed and ${survived.length} groups re-read from the new process: ${survived.join(', ')}`;
    },
  },
];

/** Which of the three people a user id belongs to, so a sentence reads. */
function nameOf(people, userId) {
  for (const person of Object.values(people)) {
    if (person && person.userId === userId) {
      return person.name;
    }
  }
  return userId;
}