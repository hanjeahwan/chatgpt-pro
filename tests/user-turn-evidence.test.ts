import { describe, expect, it } from 'vitest';

import { USER_TURN_EVIDENCE } from '../skills/chatgpt-pro-collab/scripts/browser.ts';

/** Minimal element the matcher can traverse: it uses only these DOM members. */
class StubElement {
  readonly tagName: string;
  readonly children: StubElement[] = [];
  parentElement: StubElement | null = null;
  readonly #attributes: Record<string, string>;
  readonly #text: string | null;

  constructor(tagName: string, text: string | null = null, attributes: Record<string, string> = {}) {
    this.tagName = tagName;
    this.#text = text;
    this.#attributes = attributes;
  }

  append(...children: StubElement[]): this {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
    return this;
  }

  get textContent(): string {
    if (this.#text !== null) {
      return this.#text;
    }
    return this.children
      .map((child) => {
        return child.textContent;
      })
      .join('');
  }

  getAttribute(name: string): string | null {
    return this.#attributes[name] ?? null;
  }

  querySelectorAll(selector: string): StubElement[] {
    if (selector !== '*') {
      throw new Error(`stub only supports '*', received ${selector}`);
    }
    return this.children.flatMap((child) => {
      return [child, ...child.querySelectorAll('*')];
    });
  }

  contains(other: StubElement): boolean {
    let ancestor: StubElement | null = other;
    while (ancestor !== null) {
      if (ancestor === this) {
        return true;
      }
      ancestor = ancestor.parentElement;
    }
    return false;
  }

  getClientRects(): readonly unknown[] {
    return [{}];
  }
}

/**
 * Runs the page matcher against stub nodes with the browser globals it reads.
 *
 * @param element User turn root.
 * @param prompt Prompt text as saved locally, before the page rendered it.
 * @param names Ordered attachment basenames the turn must display.
 * @returns Whether the turn matches the prompt and attachments.
 */
function readEvidence(element: StubElement, prompt: string, names: readonly string[]): boolean {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previousElement = globals.HTMLElement;
  const previousStyle = globals.getComputedStyle;
  globals.HTMLElement = StubElement;
  globals.getComputedStyle = () => {
    return { visibility: 'visible', display: 'block' };
  };
  try {
    const run = new Function(
      'element',
      'expectedPrompt',
      'names',
      `${USER_TURN_EVIDENCE}\nreturn readUserTurnEvidence(element, expectedPrompt, names);`,
    ) as (element: StubElement, prompt: string, names: readonly string[]) => boolean;
    return run(element, prompt, names);
  } finally {
    globals.HTMLElement = previousElement;
    globals.getComputedStyle = previousStyle;
  }
}

/**
 * Builds a user turn shaped like ChatGPT's, in either rendering path measured on live turns.
 *
 * `markdown` splits the prompt on inline code into <code> elements, dropping the backticks and
 * keeping blank lines. `plain` keeps the text verbatim but collapses blank lines to single
 * newlines. Both are lossy in different ways, so evidence has to survive either.
 *
 * @param prompt Locally saved prompt, backticks included.
 * @param attachmentNames Attachment basenames rendered as tiles.
 * @param rendering Which page rendering path to reproduce.
 * @returns The user turn root element.
 */
function userTurn(
  prompt: string,
  attachmentNames: readonly string[],
  rendering: 'markdown' | 'plain' = 'markdown',
): StubElement {
  const turn = new StubElement('DIV', null, { 'data-turn': 'user' });
  const heading = new StubElement('H4', 'You said:');
  const tiles = new StubElement('DIV');
  for (const name of attachmentNames) {
    tiles.append(new StubElement('DIV').append(new StubElement('DIV', name), new StubElement('SPAN', 'File')));
  }
  const body = new StubElement('DIV', null, { 'data-testid': 'collapsible-user-message-content' });
  if (rendering === 'plain') {
    body.append(new StubElement('P', prompt.replace(/\n{2,}/g, '\n')));
    return turn.append(heading, tiles, body);
  }
  const segments = prompt.split('`');
  for (const [index, segment] of segments.entries()) {
    body.append(new StubElement(index % 2 === 0 ? 'DIV' : 'CODE', segment));
  }
  return turn.append(heading, tiles, body);
}

describe('user turn submission evidence', () => {
  const attachment = 'evals-redesign.tar.gz';

  it('matches a prompt whose inline code names the attachment it carries', () => {
    // Regression: chip detection used to match on text, so this inline mention was read as a
    // chip and its container walk-up swallowed the whole body, leaving no prompt text at all.
    const prompt = `延续同一协作任务。附件 \`${attachment}\` 是当前仓库状态。`;

    expect(readEvidence(userTurn(prompt, [attachment]), prompt, [attachment])).toBe(true);
  });

  it('matches a prompt containing inline code the page renders without backticks', () => {
    const prompt = 'Read `grader.py` and `extract_answers.py` before answering.';

    expect(readEvidence(userTurn(prompt, []), prompt, [])).toBe(true);
  });

  it('matches the plain rendering that keeps backticks but collapses blank lines', () => {
    // Regression: a long multi-paragraph turn rendered this way, so evidence keyed on the
    // markdown path alone could not verify it and the submission stayed unprovable.
    const prompt = `第一段提到 \`${attachment}\`。\n\n## 第二段\n\n- 列表项\n\n\`\`\`\ncode fence\n\`\`\``;

    expect(readEvidence(userTurn(prompt, [attachment], 'plain'), prompt, [attachment])).toBe(true);
  });

  it('rejects a different prompt under the plain rendering too', () => {
    const turn = userTurn('第一段。\n\n第二段。', [], 'plain');

    expect(readEvidence(turn, '第一段。\n\n第三段。', [])).toBe(false);
  });

  it('matches a prompt with no markup at all', () => {
    const prompt = 'Summarise the attached archive.';

    expect(readEvidence(userTurn(prompt, [attachment]), prompt, [attachment])).toBe(true);
  });

  it('rejects a turn carrying a different prompt', () => {
    const turn = userTurn('Summarise the attached archive.', [attachment]);

    expect(readEvidence(turn, 'Summarise a different archive.', [attachment])).toBe(false);
  });

  it('rejects a turn whose prompt names the attachment but displays no tile', () => {
    const prompt = `Unpack \`${attachment}\` first.`;

    expect(readEvidence(userTurn(prompt, []), prompt, [attachment])).toBe(false);
  });

  it('rejects a turn displaying attachments in another order', () => {
    const names = [attachment, 'scope.md'];
    const prompt = 'Compare both attachments.';

    expect(readEvidence(userTurn(prompt, [...names].reverse()), prompt, names)).toBe(false);
  });

  it('rejects an empty expected prompt instead of matching any turn', () => {
    expect(readEvidence(userTurn('anything', []), '', [])).toBe(false);
  });
});
