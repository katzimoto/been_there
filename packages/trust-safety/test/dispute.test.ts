import { describe, expect, it } from 'vitest';
import { NOW, subject } from './support.js';
import {
  USER_NOTICES,
  type ReversibleFriction,
  proposeFriction,
  userNoticeFor,
} from '../src/index.js';

const friction = (kind: ReversibleFriction['kind']): ReversibleFriction =>
  proposeFriction(kind, subject('s-1'), 'interaction.unmatch_report observed unmatch_then_report', NOW);

describe('what a user is told', () => {
  it('never contains a word that would tell a user they are judged risky', () => {
    expect(USER_NOTICES.filter((notice) => /risk|suspicious|unsafe|flag|block|ban|trust/i.test(notice))).toEqual([]);
  });

  it('says nothing when there is no friction, whatever the risk state happens to be', () => {
    // The risk state is not an input here at all: that is the guarantee. A
    // `critical` subject with no active proposal still produces no notice.
    expect(userNoticeFor([], NOW)).toBe('none');
    expect(userNoticeFor([friction('rate_limit')], new Date(NOW.getTime() + 48 * 3_600_000))).toBe('none');
  });

  it('reports the most consequential live proposal only', () => {
    expect(userNoticeFor([friction('rate_limit')], NOW)).toBe('generic_rate_limit');
    expect(userNoticeFor([friction('rate_limit'), friction('reverification_request')], NOW)).toBe(
      'generic_reverification',
    );
  });

  it('says nothing about a human review candidate, which is not a user event', () => {
    expect(userNoticeFor([friction('human_review_candidate')], NOW)).toBe('none');
  });
});
