import type { Counter } from '@opentelemetry/api';
import { type DomainError, type DomainErrorCode, type Result, domainError, ok } from '@been-there/core';
import { StoreError } from '@been-there/contracts';
import { type MetricDefinition, defineMetrics, isHighCardinalityDimension } from '@been-there/platform';
import { InMemoryMeter } from './meter.js';

/**
 * The edge-wide response counter: every response the process finishes writing,
 * counted under *what the service did*, not under how it felt about the request.
 *
 * ## Why the two failures are separated rather than summed
 *
 * A safety refusal and a store fault are opposites that look identical on the
 * wire. A blocked conversation, an unverified account and a moderated action are
 * all a domain `Err` — the service answered, deliberately, and the answer is the
 * product working. A dead database is a `StoreError`: the service did not
 * answer, and that is the product failing. Count them together, or not at all,
 * and nobody can tell a rising refusal rate from a falling availability — and the
 * first is a moderation signal while the second is an incident.
 *
 * ## Why it is a class and not a denial
 *
 * `denied` and `rejected` are both wrong for the same reason. Both put a decider
 * in the sentence: somebody or something looked at the request and turned it
 * away. Nothing here does that. A refusal may be a policy written at build time
 * a hundred lines from here, and an outage was decided by a socket in another
 * country. The question an operator actually asks is about the *service*: did it
 * answer, did it decline, or could it not say. `class` is the word for the
 * answer to that question, and it has room for the third case that `denied` has
 * no word for at all — most responses are not refusals, they are completions.
 */

/**
 * The three things an operator can act on differently.
 *
 * - `completed` — the service answered the question.
 * - `refused` — the answer was no, and no was the answer. The safety system
 *   doing its job, which is why a refusal is not an error condition.
 * - `outage` — the service could not answer, whatever the reason.
 */
export type ResponseClass = 'completed' | 'refused' | 'outage';

/**
 * Why a response carries the class it carries: the domain's own code for a
 * refusal, the store's code for a fault, and `none` for a completion.
 *
 * `none` rather than an absent dimension, because the dimensions are declared
 * for the metric as a whole. A series with no `code` is a series a label filter
 * silently fails to select, and on a dashboard a missing dimension reads as
 * "never happened" when it means "nothing went wrong".
 *
 * The vocabulary is closed and bounded by construction: nine domain codes from
 * the kernel, two store codes, and `none`. That bound *is* the cardinality
 * guarantee — there is no code anybody can invent at runtime.
 */
export type ResponseCode = DomainErrorCode | 'store_unavailable' | 'store_failure' | 'none';

/**
 * A label set, as a type alias rather than an interface so that it carries an
 * implicit index signature and can be handed straight to a `Counter` without a
 * cast. Both dimensions are always present.
 */
export type ResponseLabels = {
  readonly class: ResponseClass;
  readonly code: ResponseCode;
};

/**
 * The one instrument this module declares. `defineMetrics` throws on a
 * high-cardinality dimension, so the rule that a subject id may not become a
 * label is enforced by the catalogue's construction rather than by a comment —
 * and the two dimensions are the class and the code, which are the two things
 * about a failure that every failure of that kind shares.
 */
export const EDGE_RESPONSE_METRIC: MetricDefinition = defineMetrics({
  'edge.response': {
    instrument: 'counter',
    unit: '{response}',
    description:
      'A response the edge finished writing, by whether the service answered it, refused it as the answer, or could not answer at all, and by the code it answered with. Refusals are the safety system working and outages are the service failing; this is the series that keeps the two apart instead of averaging them into one number that means nothing.',
    dimensions: ['class', 'code'],
  },
})['edge.response'];

/**
 * The class each domain code lands in.
 *
 * A table rather than a chain of comparisons, for the reason `STATUS_BY_DOMAIN_CODE`
 * in `http/failure.ts` is one: a new `DomainErrorCode` makes this file stop
 * compiling until somebody decides which side of the line it falls on, instead of
 * silently inheriting a default nobody chose.
 *
 * The line is whether the service knows the answer. Every 4xx means it does —
 * the request was declined, on purpose, and the decline is the product. The two
 * 5xx domain codes mean it does not: `external_dependency_failed` is somebody
 * else's service being down (the one place `http/failure.ts` calls a domain code
 * "genuinely an outage"), and `internal` is a defect in this one. Both are
 * outages even though they arrive as a domain `Err`, because they arrive as an
 * answer the service does not have.
 *
 * `packages/service/test/edge-metrics.test.ts` asserts this table agrees with the
 * status table for every code, because the two answering differently is exactly
 * the conflation this module exists to prevent: a metric calling something a
 * refusal while the wire calls it a 503.
 */
export const DOMAIN_RESPONSE_CLASSES: Readonly<Record<DomainErrorCode, ResponseClass>> = {
  validation_failed: 'refused',
  not_found: 'refused',
  not_eligible: 'refused',
  permission_denied: 'refused',
  conflict: 'refused',
  invalid_transition: 'refused',
  rate_limited: 'refused',
  external_dependency_failed: 'outage',
  internal: 'outage',
};

/**
 * The classification, applied once, where the response is finalised.
 *
 * This is deliberately a function of the *error* rather than of the status
 * number. A status is what the client is told; a classification is what the
 * operator must believe. Deriving one from the other would let an edit to the
 * status table silently re-file a metric, and the two contracts are asserted
 * separately in the suite precisely so that neither can drag the other.
 *
 * A completion is the absence of a failure rather than a separate call, so no
 * finalisation site can reach the counter without saying which of the two it
 * produced, and a `StoreError` thrown by the transaction wrapper lands in the
 * same bucket as a domain refusal decided three layers up.
 *
 * A store fault's code is the code the client is given — a transient fault is
 * `store_unavailable` and a permanent one is `store_failure`, pinned to
 * `failureBodyFromStore` by a test. The retryable flag is the store's own
 * classification of the driver error, so the metric does not re-decide what is
 * retryable.
 */
export function classifyResponse(failure: DomainError | StoreError | undefined): ResponseLabels {
  if (failure === undefined) {
    return { class: 'completed', code: 'none' };
  }
  if (failure instanceof StoreError) {
    return { class: 'outage', code: failure.retryable ? 'store_unavailable' : 'store_failure' };
  }
  return { class: DOMAIN_RESPONSE_CLASSES[failure.code], code: failure.code };
}

/**
 * The classes, as a lookup over untrusted strings. The value is the class itself
 * rather than a flag, so a string that survived the lookup *is* narrowed to the
 * union — the lookup is the narrowing, and there is no second assertion.
 */
const CLASS_BY_VALUE: Readonly<Record<string, ResponseClass | undefined>> = {
  completed: 'completed',
  refused: 'refused',
  outage: 'outage',
};

/**
 * Every code in the vocabulary. The cast is sound because `Object.keys` over a
 * `Record<DomainErrorCode, …>` returns exactly the codes of that union, and it
 * is here so the vocabulary follows the kernel rather than restating it.
 */
const RESPONSE_CODES: readonly ResponseCode[] = [
  ...(Object.keys(DOMAIN_RESPONSE_CLASSES) as DomainErrorCode[]),
  'store_unavailable',
  'store_failure',
  'none',
];

const CODE_BY_VALUE: Readonly<Record<string, ResponseCode | undefined>> = Object.fromEntries(
  RESPONSE_CODES.map((code) => [code, code] as const),
);

/** The codes that mean the store failed, which only an outage may carry. */
const STORE_CODES: readonly string[] = ['store_unavailable', 'store_failure'];

/**
 * Turns a label set somebody asked for into the labels the metric may carry, or
 * refuses.
 *
 * The input is untrusted by design and typed as `Record<string, unknown>` so the
 * guard is reachable by whoever is holding an identifier and a counter, rather
 * than by whoever remembered to cast. Three rules, and the first is the one that
 * keeps the metrics backend alive:
 *
 *  1. every dimension must be one this metric declares, and none may be a name
 *     that would identify a person, a case or a conversation;
 *  2. every value must be in the closed vocabulary above — a `userId`, a
 *     `conversationId` or a `requestId` is not in it, which is why an
 *     identifier-shaped value cannot be recorded even under a legal dimension
 *     name;
 *  3. the pair must be coherent: only a completion carries no code, and a store
 *     code only ever appears on an outage — so a refusal cannot be labelled as
 *     one and an outage cannot be labelled as the other by a typo.
 */
export function edgeResponseAttributes(requested: Readonly<Record<string, unknown>>): Result<ResponseLabels, DomainError> {
  for (const dimension of Object.keys(requested)) {
    if (isHighCardinalityDimension(dimension)) {
      return domainError(
        'validation_failed',
        'service.health',
        `"${dimension}" names one thing rather than counting many, so it cannot be a metric label`,
        { label: dimension },
      );
    }
    if (!EDGE_RESPONSE_METRIC.dimensions.includes(dimension)) {
      return domainError(
        'validation_failed',
        'service.health',
        `edge.response is labelled by ${EDGE_RESPONSE_METRIC.dimensions.join(' and ')}, so it has no "${dimension}" dimension`,
        { label: dimension },
      );
    }
  }

  const requestedClass = requested['class'];
  const responseClass = typeof requestedClass === 'string' ? CLASS_BY_VALUE[requestedClass] : undefined;
  if (responseClass === undefined) {
    return domainError('validation_failed', 'service.health', 'edge.response is labelled by class, and that is not one', {
      label: String(requestedClass),
    });
  }

  const requestedCode = requested['code'];
  const code = typeof requestedCode === 'string' ? CODE_BY_VALUE[requestedCode] : undefined;
  if (code === undefined) {
    return domainError(
      'validation_failed',
      'service.health',
      'edge.response is labelled by a closed vocabulary of failure codes, and that is not one of them',
      { label: String(requestedCode) },
    );
  }

  if ((responseClass === 'completed') !== (code === 'none')) {
    return domainError(
      'validation_failed',
      'service.health',
      'only a completed response carries no code, and only a failed one carries one',
      { label: `${responseClass}:${code}` },
    );
  }

  if (STORE_CODES.includes(code) && responseClass !== 'outage') {
    return domainError(
      'validation_failed',
      'service.health',
      'a store failure is an outage, so it may not be counted as anything else',
      { label: `${responseClass}:${code}` },
    );
  }

  return ok({ class: responseClass, code });
}

/**
 * The process-wide meter behind `edge.response`.
 *
 * It is a module singleton rather than a field on `ServiceMetrics` because
 * recording happens where the response is finalised — in the HTTP layer, below
 * the `ServiceDependencies` seam — and a counter only a handler that happened to
 * be handed the surface could write would miss every refusal decided before a
 * handler ran. `ServiceMetrics.snapshot` reads this meter, so the numbers are
 * served at `GET /v1/health/metrics` beside every other series.
 */
export const edgeResponseMeter = new InMemoryMeter();

const counter: Counter = edgeResponseMeter.createCounter('edge.response', {
  unit: EDGE_RESPONSE_METRIC.unit,
  description: EDGE_RESPONSE_METRIC.description,
});

/**
 * The only way a response reaches the counter.
 *
 * A rejected label set is not recorded, and the caller is told rather than not,
 * because a silently dropped count is a number that is wrong in the one direction
 * nobody is looking for: the outage total stays flat while the outage is still
 * happening.
 */
export function recordResponse(requested: Readonly<Record<string, unknown>>): Result<ResponseLabels, DomainError> {
  const labels = edgeResponseAttributes(requested);
  if (!labels.ok) {
    return labels;
  }
  counter.add(1, labels.value);
  return labels;
}