import { describe, expect, it } from 'vitest';

import {
  compareSpec,
  parseSpec,
  validateLedger,
  type TaskLedger,
} from '../.agents/skills/plan-spec-implementation/scripts/spec-tasks.ts';

const BASE_SHA = '0123456789abcdef0123456789abcdef01234567';

function spec(behaviorBody = 'Result A', verificationBody = 'Check A'): string {
  return `# Example

## Product behavior

### BEH-001 First behavior

${behaviorBody}

The text may mention BEH-002 without defining it.

### BEH-002 Second behavior

Result B

## Verification

### VER-001 First verification

${verificationBody}

### VER-002 Second verification

Check B
`;
}

function ledgerFor(content: string): TaskLedger {
  const snapshot = parseSpec(content);
  return {
    spec: 'docs/specs/example.md',
    specDigest: snapshot.specDigest,
    contextDigest: snapshot.contextDigest,
    sourceDigests: snapshot.sourceDigests,
    baseSha: BASE_SHA,
    tasks: [
      {
        id: 'IMP-001',
        title: 'Implement first behavior',
        status: 'pending',
        covers: ['BEH-001'],
        verifies: ['VER-001'],
        dependsOn: [],
        scope: ['First component'],
        evidence: { commits: [], checks: [], reviews: [] },
      },
      {
        id: 'IMP-002',
        title: 'Implement second behavior',
        status: 'pending',
        covers: ['BEH-002'],
        verifies: ['VER-002'],
        dependsOn: ['IMP-001'],
        scope: ['Second component'],
        evidence: { commits: [], checks: [], reviews: [] },
      },
    ],
  };
}

describe('parseSpec', () => {
  it('extracts definitions without treating references as definitions', () => {
    const snapshot = parseSpec(spec());

    expect(Object.keys(snapshot.sourceDigests)).toEqual(['BEH-001', 'BEH-002', 'VER-001', 'VER-002']);
  });

  it('keeps item digests stable when unrelated context changes', () => {
    const original = parseSpec(spec());
    const moved = parseSpec(`${spec()}\n## Extra context\n\nMoved section.\n`);

    expect(moved.sourceDigests).toEqual(original.sourceDigests);
    expect(moved.specDigest).not.toBe(original.specDigest);
  });

  it('rejects duplicate definitions', () => {
    expect(() => {
      return parseSpec(`${spec()}\n### BEH-001 Duplicate\n`);
    }).toThrow('Spec defines BEH-001 more than once');
  });
});

describe('compareSpec', () => {
  it('reports added, changed, and removed stable items', () => {
    const original = spec();
    const oldLedger = ledgerFor(original);
    const current = spec('Changed result', 'Changed check')
      .replace('### BEH-002 Second behavior\n\nResult B\n', '### BEH-003 Third behavior\n\nResult C\n')
      .replace('### VER-002 Second verification\n\nCheck B\n', '### VER-003 Third verification\n\nCheck C\n');

    expect(compareSpec(parseSpec(current), oldLedger)).toEqual({
      specChanged: true,
      contextChanged: false,
      added: ['BEH-003', 'VER-003'],
      changed: ['BEH-001', 'VER-001'],
      removed: ['BEH-002', 'VER-002'],
      impactedTasks: ['IMP-001', 'IMP-002'],
    });
  });

  it('flags changes outside numbered items even when a numbered item also changes', () => {
    const original = spec();

    expect(
      compareSpec(parseSpec(`${spec('Changed result')}\n## Extra context\n\nBoundary changed.\n`), ledgerFor(original)),
    ).toMatchObject({ specChanged: true, contextChanged: true, changed: ['BEH-001'] });
  });
});

describe('validateLedger', () => {
  it('accepts a complete ready ledger', () => {
    const content = spec();

    expect(
      validateLedger(parseSpec(content), ledgerFor(content), {
        expectedSpec: 'docs/specs/example.md',
        readiness: 'ready',
      }),
    ).toEqual([]);
  });

  it('rejects stale source data, missing coverage, and dependency cycles', () => {
    const content = spec();
    const ledger = ledgerFor(content);
    const tasks = ledger.tasks;
    ledger.specDigest = 'sha256:stale';
    tasks[0].verifies = [];
    tasks[0].dependsOn = ['IMP-002'];

    const errors = validateLedger(parseSpec(content), ledger, {
      expectedSpec: 'docs/specs/example.md',
      readiness: 'ready',
    });

    expect(errors).toContain('ledger.specDigest is stale; run diff and reconcile the ledger');
    expect(errors).toContain('VER-001 has no active evidence owner');
    expect(errors).toContain('task dependency cycle: IMP-001 -> IMP-002 -> IMP-001');
  });

  it('rejects a started task whose dependency is not done', () => {
    const content = spec();
    const ledger = ledgerFor(content);
    ledger.tasks[1].status = 'in_progress';

    expect(
      validateLedger(parseSpec(content), ledger, {
        expectedSpec: 'docs/specs/example.md',
        readiness: 'ready',
      }),
    ).toContain('IMP-002 is in_progress before dependency IMP-001 is done');
  });

  it('requires evidence before a task can be done', () => {
    const content = spec();
    const ledger = ledgerFor(content);
    const tasks = ledger.tasks;
    tasks[0].status = 'done';

    expect(
      validateLedger(parseSpec(content), ledger, {
        expectedSpec: 'docs/specs/example.md',
        readiness: 'final',
      }),
    ).toEqual(
      expect.arrayContaining([
        'IMP-001 is done but evidence.commits is empty',
        'IMP-001 is done but evidence.checks is empty',
        'IMP-001 is done but evidence.reviews is empty',
        'IMP-002 must be done or cancelled for final delivery',
      ]),
    );
  });
});
