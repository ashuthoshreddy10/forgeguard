/**
 * snapshots.ts — Named replay views used as frontend test fixtures (see
 * scripts/generate-replay-snapshots.ts). Pure: built only from fixtures and ReplayEngine.
 */

import { approvalGateIndex, buildReplayView } from './ReplayEngine';
import { FIXTURES, listScenarios } from './ReplayStore';
import type { ReplayStatus } from './ReplayTypes';

function view(scenario: string, position: number | 'end', approved: boolean, rolledBack: boolean, status: ReplayStatus) {
  const fixture = FIXTURES.get(scenario)!;
  const pos = position === 'end' ? fixture.timeline.length - 1 : position;
  return { ...buildReplayView(fixture, { position: pos, approved, rolledBack }), replayId: 'replay-session-001', status, speed: 1 };
}

export function replaySnapshots(): Record<string, unknown> {
  const gate = approvalGateIndex(FIXTURES.get('safe-fix')!);
  return {
    scenarios: listScenarios(),
    views: {
      'safe-fix@start': view('safe-fix', 0, false, false, 'playing'),
      'safe-fix@analysis': view('safe-fix', 4, false, false, 'paused'),
      'safe-fix@gate': view('safe-fix', gate, false, false, 'awaiting_approval'),
      'safe-fix@end': view('safe-fix', 'end', true, false, 'finished'),
      'safe-fix@rolled-back': view('safe-fix', 'end', true, true, 'finished'),
      'regression-blocked@end': view('regression-blocked', 'end', true, false, 'finished'),
      'bob-disagreement@end': view('bob-disagreement', 'end', true, false, 'finished'),
    },
  };
}
