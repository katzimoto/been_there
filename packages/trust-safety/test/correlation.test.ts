import { describe, expect, it } from 'vitest';
import { NOW, at, makeSignal, subject } from './support.js';
import {
  CORROBORATION_WINDOW_HOURS,
  EMPTY_LEDGER,
  MASS_REPORT_CLUSTER_SIZE,
  REPEAT_WINDOW_HOURS,
  SIGNAL_LEDGER_CAPACITY,
  appendSignal,
  corroborate,
} from '../src/index.js';

const ledgerOf = (...signals: Parameters<typeof appendSignal>[1][]): ReturnType<typeof appendSignal> => {
  let ledger = EMPTY_LEDGER;
  for (const signal of signals) {
    ledger = appendSignal(ledger, signal);
  }
  return ledger;
};

describe('signal ledger', () => {
  it('keeps the most recent evidence when it overflows', () => {
    const old = makeSignal({ occurredAt: at(400) });
    let ledger = ledgerOf(old);
    for (let index = 0; index < SIGNAL_LEDGER_CAPACITY; index += 1) {
      ledger = appendSignal(ledger, makeSignal({ occurredAt: at(400 - index) }));
    }
    expect(ledger.entries).toHaveLength(SIGNAL_LEDGER_CAPACITY);
    expect(ledger.entries.some((entry) => entry === old)).toBe(false);
  });

  it('orders a late arrival by when it happened, not when it was seen', () => {
    const ledger = ledgerOf(makeSignal({ occurredAt: NOW }), makeSignal({ occurredAt: at(3) }));
    expect(ledger.entries.map((entry) => entry.occurredAt.getTime())).toEqual([
      at(3).getTime(),
      NOW.getTime(),
    ]);
  });
});

describe('corroboration', () => {
  it('counts distinct detectors about the subject and nobody else', () => {
    const incoming = makeSignal({ detector: 'interaction.unmatch_report' });
    const corroboration = corroborate(
      ledgerOf(
        makeSignal({ detector: 'network.device_cluster', subjectId: subject('s-1') }),
        makeSignal({ detector: 'network.device_cluster', subjectId: subject('s-1') }),
        makeSignal({ detector: 'identity.reuse', subjectId: subject('s-2') }),
      ),
      incoming,
    );
    expect(corroboration.detectors).toEqual(['interaction.unmatch_report', 'network.device_cluster']);
    expect(corroboration.independentDetectors).toBe(2);
  });

  it('counts a repeat only from the same detector about the same behaviour', () => {
    const incoming = makeSignal({ behaviour: { kind: 'unmatch_then_report', entityId: 'match-1' } });
    const corroboration = corroborate(
      ledgerOf(
        makeSignal({ behaviour: { kind: 'unmatch_then_report', entityId: 'match-1' } }),
        makeSignal({ behaviour: { kind: 'unmatch_then_report', entityId: 'match-2' } }),
        makeSignal({ detector: 'other.detector' }),
      ),
      incoming,
    );
    expect(corroboration.repetitions).toBe(1);
  });

  it('ignores repeats older than the repeat window but keeps them as detectors', () => {
    const incoming = makeSignal({ occurredAt: NOW });
    const stale = makeSignal({ occurredAt: new Date(NOW.getTime() - (REPEAT_WINDOW_HOURS + 1) * 3_600_000) });
    const corroboration = corroborate(ledgerOf(stale), incoming);
    expect(corroboration.repetitions).toBe(0);
    expect(corroboration.independentDetectors).toBe(1);
  });

  it('ignores anything outside the corroboration window, or dated in the future', () => {
    const incoming = makeSignal({ occurredAt: NOW });
    const tooOld = makeSignal({
      detector: 'network.device_cluster',
      occurredAt: new Date(NOW.getTime() - (CORROBORATION_WINDOW_HOURS + 1) * 3_600_000),
    });
    const notYet = makeSignal({ detector: 'identity.reuse', occurredAt: new Date(NOW.getTime() + 3_600_000) });
    expect(corroborate(ledgerOf(tooOld, notYet), incoming).independentDetectors).toBe(1);
  });
});

describe('coordinated reporting detection', () => {
  const report = (reporter: string, occurredAt: Date) =>
    makeSignal({
      detector: 'report.coordinated_target',
      category: 'report_pattern',
      subjectId: subject('victim-1'),
      actorId: subject(reporter),
      behaviour: { kind: 'report_against', entityId: 'victim-1' },
      occurredAt,
    });

  it(`needs ${MASS_REPORT_CLUSTER_SIZE} distinct reporters before it calls something an attack`, () => {
    const first = report('r-1', at(0, 2));
    const second = report('r-2', at(0, 1));
    expect(corroborate(ledgerOf(first), second).massReport).toBeNull();

    const cluster = corroborate(ledgerOf(first, second), report('r-3', NOW)).massReport;
    expect(cluster?.reporters).toEqual([subject('r-1'), subject('r-2'), subject('r-3')]);
    expect(cluster?.targetId).toBe(subject('victim-1'));
  });

  it('does not mistake one account reporting three times for a campaign', () => {
    const sameReporter = [report('r-1', at(0, 3)), report('r-1', at(0, 2)), report('r-1', at(0, 1))];
    expect(corroborate(ledgerOf(...sameReporter), report('r-1', NOW)).massReport).toBeNull();
  });

  it('never clusters a behaviour that is not aimed at somebody', () => {
    const messages = [1, 2, 3].map((index) =>
      makeSignal({
        detector: 'velocity.message_burst',
        category: 'velocity',
        subjectId: subject(`s-${index}`),
        behaviour: { kind: 'message_velocity', entityId: 'conversation-1' },
        occurredAt: at(0, index),
      }),
    );
    expect(corroborate(ledgerOf(...messages), messages[0]!).massReport).toBeNull();
  });
});
