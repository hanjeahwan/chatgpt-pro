export interface ResolveTurnPageTurn {
  readonly testId: string;
  readonly turn: 'user' | 'assistant';
}

export interface ResolveTurnPageOptions {
  readonly pathname: string;
  readonly targetUserTurnId: string;
  readonly turns: readonly ResolveTurnPageTurn[];
  readonly composerText?: string;
  readonly composerCount?: number;
  readonly composerVisible?: boolean;
  readonly formCount?: number;
  readonly populatedFileInputCount?: number;
  readonly attachmentControlCount?: number;
  readonly stopVisible?: boolean;
  readonly stopCount?: number;
  readonly stopDisappears?: boolean;
}

export interface ResolveTurnPageFixture {
  readonly events: string[];
  readonly page: object;
}

/**
 * Creates the minimal page boundary required to execute failed-response resolution.
 *
 * The page fixture supports the canonical conversation URL reads, the unique target
 * user turn wait and drift check, the safe-empty-composer residue checks, and the
 * at-most-one `Stop answering` click with disappearance verification. Unsupported
 * selectors or callbacks fail instead of being guessed.
 *
 * @param options Page path, turns, composer residue, and Stop behavior.
 * @returns Page-shaped fixture plus ordered resolution events.
 * @throws {Error} Unsupported fixture callbacks fail explicitly.
 */
export function resolveTurnPageFixture(options: ResolveTurnPageOptions): ResolveTurnPageFixture {
  const events: string[] = [];
  let stopVisible = options.stopVisible ?? false;
  const stopDisappears = options.stopDisappears ?? true;
  const stopCount = options.stopCount ?? 1;
  const turns = options.turns.map((turn) => {
    return new FixtureTurn(turn.testId, turn.turn);
  });
  const composer = new FixtureComposer(options.composerText ?? '');
  const composerCount = options.composerCount ?? 1;
  const composerVisible = options.composerVisible ?? true;
  const formCount = options.formCount ?? 1;
  const populatedFileInputCount = options.populatedFileInputCount ?? 0;
  const attachmentControlCount = options.attachmentControlCount ?? 0;
  const location = {
    hostname: 'chatgpt.com',
    origin: 'https://chatgpt.com',
    pathname: options.pathname,
  };
  const withGlobals = (callback: unknown, ...arguments_: readonly unknown[]): unknown => {
    if (typeof callback !== 'function') {
      throw new TypeError('resolve-turn fixture callback is not callable');
    }
    const previous = new Map<string, PropertyDescriptor | undefined>();
    for (const [name, value] of Object.entries({
      HTMLElement: FixtureHtmlElement,
      HTMLInputElement: FixtureFileInput,
      getComputedStyle: () => {
        return { visibility: 'visible', display: 'block' };
      },
      location,
      document: {
        querySelectorAll(selector: string) {
          if (selector === '[data-testid^="conversation-turn-"][data-turn="user"]') {
            return turns.filter((turn) => {
              return turn.getAttribute('data-turn') === 'user';
            });
          }
          if (selector === '[data-testid^="conversation-turn-"][data-turn]') {
            return turns;
          }
          throw new Error(`unsupported resolve-turn fixture document selector: ${selector}`);
        },
      },
    })) {
      previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    try {
      return Reflect.apply(callback, undefined, arguments_);
    } finally {
      for (const [name, descriptor] of previous) {
        if (descriptor === undefined) {
          Reflect.deleteProperty(globalThis, name);
        } else {
          Object.defineProperty(globalThis, name, descriptor);
        }
      }
    }
  };
  const stopButton = {
    count() {
      events.push('stop:count');
      return Promise.resolve(stopVisible ? stopCount : 0);
    },
    first() {
      return {
        isVisible() {
          events.push('stop:visible');
          return Promise.resolve(stopVisible);
        },
        click() {
          events.push('stop:click');
          if (stopDisappears) {
            stopVisible = false;
          }
          return Promise.resolve();
        },
      };
    },
  };
  const page = {
    evaluate(callback: unknown, argument?: unknown) {
      events.push('url');
      return Promise.resolve(argument === undefined ? withGlobals(callback) : withGlobals(callback, argument));
    },
    waitForFunction(callback: unknown, argument?: unknown) {
      events.push('wait-for-target');
      const result = withGlobals(callback, argument);
      if (result === true) {
        return Promise.resolve(true);
      }
      return Promise.reject(new Error('fixture waitForFunction timeout'));
    },
    locator(selector: string) {
      if (selector === '[data-testid^="conversation-turn-"][data-turn]') {
        return {
          waitFor() {
            return Promise.resolve();
          },
          evaluateAll(callback: unknown, argument?: unknown) {
            events.push('turns');
            return Promise.resolve(withGlobals(callback, turns, argument));
          },
        };
      }
      if (selector === '#prompt-textarea') {
        return {
          waitFor() {
            return Promise.resolve();
          },
          count() {
            return Promise.resolve(composerCount);
          },
          isVisible() {
            return Promise.resolve(composerVisible);
          },
          evaluateAll(callback: unknown) {
            events.push('composer-text');
            return Promise.resolve(withGlobals(callback, composerCount === 1 ? [composer] : []));
          },
        };
      }
      if (selector === 'form') {
        return {
          filter() {
            return {
              count() {
                return Promise.resolve(formCount);
              },
              locator(inner: string) {
                if (inner === 'input[type="file"]') {
                  return {
                    evaluateAll(callback: unknown) {
                      events.push('file-input');
                      const fileInputs = Array.from({ length: populatedFileInputCount }, () => {
                        return new FixtureFileInput();
                      });
                      return Promise.resolve(withGlobals(callback, fileInputs));
                    },
                  };
                }
                if (inner === '*') {
                  return {
                    evaluateAll(callback: unknown) {
                      events.push('attachment-controls');
                      const controls = Array.from({ length: attachmentControlCount }, () => {
                        return new FixtureAttachmentControl();
                      });
                      return Promise.resolve(withGlobals(callback, controls));
                    },
                  };
                }
                throw new Error(`unsupported resolve-turn fixture form selector: ${inner}`);
              },
            };
          },
        };
      }
      throw new Error(`unsupported resolve-turn fixture selector: ${selector}`);
    },
    getByRole() {
      return stopButton;
    },
    waitForTimeout() {
      return Promise.resolve();
    },
  };
  return { events, page };
}

class FixtureHtmlElement {
  /** @returns A non-empty visible client-rect collection. */
  getClientRects(): readonly object[] {
    return [{}];
  }
}

class FixtureTurn extends FixtureHtmlElement {
  private readonly dataTestId: string;
  private readonly dataTurn: string;

  /**
   * Creates one conversation turn.
   *
   * @param dataTestId Stable DOM identity.
   * @param dataTurn User or assistant role.
   */
  constructor(dataTestId: string, dataTurn: 'user' | 'assistant') {
    super();
    this.dataTestId = dataTestId;
    this.dataTurn = dataTurn;
  }

  /**
   * Reads supported turn attributes.
   *
   * @param name Attribute name.
   * @returns Attribute value or null.
   */
  getAttribute(name: string): string | null {
    if (name === 'data-turn') {
      return this.dataTurn;
    }
    if (name === 'data-testid') {
      return this.dataTestId;
    }
    return null;
  }
}

class FixtureComposer extends FixtureHtmlElement {
  readonly textContent: string;

  /**
   * Creates one composer with deterministic text.
   *
   * @param text Composer text content.
   */
  constructor(text: string) {
    super();
    this.textContent = text;
  }
}

class FixtureFileInput {
  readonly value = 'staged.bin';

  /** @returns The staged file name. */
  getAttribute(): string | null {
    return null;
  }
}

class FixtureAttachmentControl extends FixtureHtmlElement {
  readonly tagName = 'BUTTON';

  /**
   * Reads supported attachment-control attributes.
   *
   * @param name Attribute name.
   * @returns The configured remove label.
   */
  getAttribute(name: string): string | null {
    if (name === 'aria-label') {
      return 'Remove file';
    }
    return null;
  }
}
