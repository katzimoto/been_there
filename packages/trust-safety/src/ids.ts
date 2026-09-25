import { type EventId, type RiskAssessmentId, castId } from '@been-there/core';

/**
 * Id minting is a dependency, not a global. Ids are a property of the storage
 * layer's call site, and the domain functions stay pure.
 */
export interface IdFactory {
  nextEventId(): EventId;
  nextAssessmentId(): RiskAssessmentId;
}

/**
 * Deterministic ids for tests and local wiring. Production supplies ULIDs.
 */
export function sequentialIdFactory(prefix = 'ts'): IdFactory {
  let events = 0;
  let assessments = 0;
  return {
    nextEventId: () => castId<'EventId'>(`${prefix}-evt-${++events}`),
    nextAssessmentId: () => castId<'RiskAssessmentId'>(`${prefix}-risk-${++assessments}`),
  };
}
