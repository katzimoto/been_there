/**
 * Opaque, branded identifiers. Each aggregate owns its id type; ids from one
 * domain are never interchangeable with another's, which turns an accidental
 * cross-domain mixup into a compile error rather than a data bug.
 *
 * Construction goes through the single `castId` crossing point so that
 * validation added later has exactly one place to live.
 */

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type UserId = Brand<string, 'UserId'>;
export type AccountId = Brand<string, 'AccountId'>;
export type ProfileId = Brand<string, 'ProfileId'>;
export type PhotoId = Brand<string, 'PhotoId'>;
export type VerificationId = Brand<string, 'VerificationId'>;
export type MatchId = Brand<string, 'MatchId'>;
export type ConversationId = Brand<string, 'ConversationId'>;
export type MessageId = Brand<string, 'MessageId'>;
export type ReportId = Brand<string, 'ReportId'>;
export type CaseId = Brand<string, 'CaseId'>;
export type RiskAssessmentId = Brand<string, 'RiskAssessmentId'>;
export type SubjectId = Brand<string, 'SubjectId'>;
export type EventId = Brand<string, 'EventId'>;
export type CorrelationId = Brand<string, 'CorrelationId'>;
export type ActorId = Brand<string, 'ActorId'>;

export function castId<T extends string>(value: string): Brand<string, T> {
  return value as Brand<string, T>;
}
