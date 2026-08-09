export interface SubmissionTurn {
  readonly testId: string;
  readonly turn: 'user' | 'assistant';
  readonly promptText?: string;
  readonly chips?: readonly string[];
  readonly disclosureText?: string;
}

export interface SubmissionPageOptions {
  readonly pathname: string;
  readonly turns?: readonly SubmissionTurn[];
  readonly mainTitle?: string;
  readonly composerText?: string;
  readonly populatedFileInputs?: number;
  readonly composerChips?: readonly string[];
  readonly stopVisible?: boolean;
  readonly hostname?: string;
  readonly composerCount?: number;
  readonly authControls?: readonly string[];
}

export interface SubmissionPageFixture {
  readonly page: object;
  readonly events: string[];
}

interface LeafElement {
  readonly textContent: string;
  readonly children: readonly unknown[];
  readonly parentElement: LeafElement | null;
  readonly tagName: string;
  getClientRects(): readonly object[];
  getAttribute(name: string): string | null;
}

interface TurnElement extends LeafElement {
  getAttribute(name: string): string | null;
  querySelectorAll(selector: string): readonly LeafElement[];
}

class SubmissionHtmlElement implements TurnElement {
  readonly textContent: string;
  readonly children: readonly LeafElement[];
  readonly parentElement: LeafElement | null;
  readonly tagName: string;
  readonly attributes: ReadonlyMap<string, string>;

  /**
   * Creates one fixture DOM node with optional leaf children.
   *
   * @param textContent Element text.
   * @param children Leaf children returned by `querySelectorAll('*')`.
   * @param parentElement Parent used by the attachment chip traversal.
   * @param tagName Element tag exposed to structural checks.
   * @param attributes Element attributes exposed to structural checks.
   * @throws {Error} This constructor does not perform I/O.
   */
  constructor(
    textContent: string,
    children: readonly LeafElement[] = [],
    parentElement: LeafElement | null = null,
    tagName: string = 'DIV',
    attributes: ReadonlyMap<string, string> = new Map(),
  ) {
    this.textContent = textContent;
    this.children = children;
    this.parentElement = parentElement;
    this.tagName = tagName;
    this.attributes = attributes;
  }

  /**
   * Reads one attribute from the fixture identity options.
   *
   * @param name Attribute name read by generated structural checks.
   * @returns Attribute value or null.
   */
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  /**
   * Returns the leaf children for the universal selector.
   *
   * @param selector Selector requested by generated code.
   * @returns Leaf children for `*`, otherwise an empty list.
   */
  querySelectorAll(selector: string): readonly LeafElement[] {
    return selector === '*' ? this.children : [];
  }

  /**
   * Reports one visible rect.
   *
   * @returns A single rect collection.
   */
  getClientRects(): readonly object[] {
    return [{}];
  }
}

/**
 * Creates a live-compatible page boundary for executing the generated submission
 * verification scripts: user turns with prompt and attachment-chip leaves, a main
 * region title, a composer with optional draft residue, and a Stop answering button.
 *
 * @param options Page identity, turns, composer residue, and Stop visibility.
 * @returns Page-shaped fixture plus an ordered event audit.
 * @throws {Error} Fixture methods reject unsupported controls instead of guessing.
 */
export function submissionPageFixture(options: SubmissionPageOptions): SubmissionPageFixture {
  const events: string[] = [];
  const state = {
    composerText: options.composerText ?? '',
    mainTitle: options.mainTitle ?? 'chatgpt-pro-collab',
    pathname: options.pathname,
    populatedFileInputs: options.populatedFileInputs ?? 0,
    composerChips: options.composerChips ?? [],
    stopVisible: options.stopVisible ?? false,
    hostname: options.hostname ?? 'chatgpt.com',
    composerCount: options.composerCount ?? 1,
    authControls: options.authControls ?? [],
  };

  const headingLeaf = (parentElement: LeafElement | null): LeafElement => {
    return new SubmissionHtmlElement('You said:', [], parentElement, 'H4');
  };
  const promptLeaf = (promptText: string | undefined, parentElement: LeafElement | null): LeafElement => {
    return new SubmissionHtmlElement(promptText ?? '', [], parentElement);
  };
  const chipLeaf = (name: string, parentElement: LeafElement | null): LeafElement => {
    return new SubmissionHtmlElement(name, [], parentElement);
  };
  const turnElements = (): readonly TurnElement[] => {
    return (options.turns ?? []).map((turn) => {
      const descendants: LeafElement[] = [];
      for (const name of turn.chips ?? []) {
        const container = new SubmissionHtmlElement('', [], null);
        const basename = chipLeaf(name, container);
        const label = chipLeaf('Document', container);
        (container.children as LeafElement[]).push(basename, label);
        descendants.push(container, basename, label);
      }
      const heading = headingLeaf(null);
      const prompt = promptLeaf(turn.promptText, null);
      descendants.push(heading, prompt);
      if (turn.disclosureText !== undefined) {
        const button = new SubmissionHtmlElement('', [], null, 'BUTTON');
        const label = new SubmissionHtmlElement(turn.disclosureText, [], button, 'SPAN');
        (button.children as LeafElement[]).push(label);
        descendants.push(button, label);
      }
      return new (class extends SubmissionHtmlElement {
        getAttribute(name: string): string | null {
          if (name === 'data-testid') {
            return turn.testId;
          }
          if (name === 'data-turn') {
            return turn.turn;
          }
          return null;
        }
        querySelectorAll(selector: string): readonly LeafElement[] {
          return selector === '*' ? descendants : [];
        }
      })([...(turn.chips ?? []), turn.promptText ?? ''].filter(Boolean).join(' '), descendants, null);
    });
  };

  const composers = Array.from({ length: state.composerCount }, () => {
    return new SubmissionHtmlElement(state.composerText);
  });
  const authControlLeaves = state.authControls.map((label) => {
    return new SubmissionHtmlElement(label, [], null, 'A', new Map([['href', '/auth/login']]));
  });
  const main = {
    querySelectorAll(selector: string) {
      return selector === 'h1' || selector === '*' ? [new SubmissionHtmlElement(state.mainTitle)] : [];
    },
  };

  const documentRoot = {
    querySelector(selector: string) {
      if (selector === 'main' || selector === '[role="main"]') {
        return main;
      }
      if (selector === '#prompt-textarea') {
        return composers[0] ?? null;
      }
      return null;
    },
    querySelectorAll(selector: string) {
      if (selector === '[data-testid^="conversation-turn-"][data-turn]') {
        return turnElements();
      }
      if (selector === '#prompt-textarea') {
        return composers;
      }
      if (selector === 'a, button') {
        return authControlLeaves;
      }
      return [];
    },
  };

  const globals = () => {
    return {
      document: documentRoot,
      getComputedStyle(_element: object) {
        return { display: 'block', visibility: 'visible' };
      },
      HTMLElement: SubmissionHtmlElement,
      HTMLAnchorElement: class extends SubmissionHtmlElement {
        readonly href: string;
        constructor(href: string) {
          super('');
          this.href = href;
        }
      },
      HTMLInputElement: class extends SubmissionHtmlElement {
        readonly value: string;
        constructor(value: string) {
          super('');
          this.value = value;
        }
      },
      location: {
        hostname: state.hostname,
        pathname: state.pathname,
        origin: `https://${state.hostname}`,
        protocol: state.hostname === 'about:blank' ? 'about:' : 'https:',
      },
    };
  };

  const locatorCollection = (selector: string) => {
    const matches = (): readonly object[] => {
      if (selector === '#prompt-textarea') {
        return composers;
      }
      if (selector === '[data-testid^="conversation-turn-"][data-turn]') {
        return turnElements();
      }
      return [];
    };
    return {
      count() {
        return Promise.resolve(matches().length);
      },
      first() {
        const firstMatch = matches()[0];
        if (firstMatch === undefined) {
          return {
            count() {
              return Promise.resolve(0);
            },
          };
        }
        return firstMatch;
      },

      isVisible() {
        return Promise.resolve(matches().length === 1);
      },
      async waitFor() {
        if (matches().length === 0) {
          throw new Error(`fixture locator is absent: ${selector}`);
        }
      },
      evaluateAll(callback: unknown, argument?: unknown) {
        if (typeof callback !== 'function') {
          return Promise.reject(new TypeError('fixture locator callback is not a function'));
        }
        return Promise.resolve(withSubmissionGlobals(globals(), callback, matches(), argument));
      },
    };
  };

  const fileInput = (value: string): object => {
    return new (class extends SubmissionHtmlElement {
      readonly value: string;
      constructor() {
        super('');
        this.value = value;
      }
    })();
  };

  const composerForm = {
    count() {
      return Promise.resolve(1);
    },
    locator(selector: string) {
      if (selector === 'input[type="file"]') {
        return {
          evaluateAll(callback: unknown, argument?: unknown) {
            if (typeof callback !== 'function') {
              return Promise.reject(new TypeError('fixture locator callback is not a function'));
            }
            const inputs = Array.from({ length: state.populatedFileInputs }, () => {
              return fileInput('staged');
            });
            return Promise.resolve(withSubmissionGlobals(globals(), callback, inputs, argument));
          },
        };
      }
      if (selector === '*') {
        return {
          evaluateAll(callback: unknown, argument?: unknown) {
            if (typeof callback !== 'function') {
              return Promise.reject(new TypeError('fixture locator callback is not a function'));
            }
            const leaves = [
              new SubmissionHtmlElement(state.composerText, [], null),
              ...state.composerChips.map((name, index) => {
                return new SubmissionHtmlElement(
                  name,
                  [],
                  null,
                  'BUTTON',
                  new Map([
                    ['aria-label', 'Remove file'],
                    ['data-testid', `composer-file-${index}`],
                  ]),
                );
              }),
            ];
            return Promise.resolve(withSubmissionGlobals(globals(), callback, leaves, argument));
          },
        };
      }
      return locatorCollection(selector);
    },
    getByText(text: string, _options: { readonly exact?: boolean }) {
      const visible = state.composerChips.includes(text);
      return {
        evaluateAll(callback: unknown, argument?: unknown) {
          if (typeof callback !== 'function') {
            return Promise.reject(new TypeError('fixture getByText callback is not a function'));
          }
          const chips = visible ? [chipLeaf(text, null)] : [];
          return Promise.resolve(withSubmissionGlobals(globals(), callback, chips, argument));
        },
      };
    },
  };

  const page = {
    evaluate(callback: unknown, argument?: unknown) {
      if (typeof callback !== 'function') {
        return Promise.reject(new TypeError('fixture evaluate callback is not a function'));
      }
      return Promise.resolve(withSubmissionGlobals(globals(), callback, argument));
    },
    getByRole(_role: string, query: { readonly name?: string }) {
      const visible = query.name === 'Stop answering' && state.stopVisible;
      return {
        count() {
          return Promise.resolve(visible ? 1 : 0);
        },
        first() {
          return {
            isVisible() {
              return Promise.resolve(visible);
            },
          };
        },
      };
    },
    async goto() {
      events.push('goto');
      return Promise.resolve();
    },
    locator(selector: string) {
      if (selector === 'form') {
        return {
          count() {
            return Promise.resolve(1);
          },
          filter(_options: { readonly has: object }) {
            return composerForm;
          },
        };
      }
      return locatorCollection(selector);
    },
    getByText() {
      return {
        evaluateAll() {
          return Promise.resolve([]);
        },
      };
    },
    async waitForFunction(callback: unknown, argument?: unknown) {
      const startedAt = Date.now();
      while (true) {
        if (withSubmissionGlobals(globals(), callback, argument) === true) {
          return;
        }
        if (Date.now() - startedAt > 250) {
          throw new Error('fixture waitForFunction deadline exceeded');
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 5);
        });
      }
    },
    waitForTimeout() {
      return Promise.resolve();
    },
  };

  return { page, events };
}

/**
 * Executes one generated submission callback with the fixture browser globals installed.
 *
 * The callback is first reconstructed from its own source (via `Function`), mirroring
 * Playwright's real serialization boundary: a serialized page callback cannot capture
 * lexical bindings from the Node-side page function, so a generated script that closes
 * over an outer variable fails exactly like it would in a real browser.
 *
 * @param globals Browser globals installed for the callback duration.
 * @param callback Generated page callback.
 * @param argument Callback argument supplied by the page function.
 * @returns The callback result.
 * @throws {TypeError} If the callback is not callable.
 */
function withSubmissionGlobals(
  globals: { readonly [name: string]: unknown },
  callback: unknown,
  ...arguments_: readonly unknown[]
): unknown {
  if (typeof callback !== 'function') {
    throw new TypeError('submission fixture callback is not a function');
  }
  const serialized = new Function(`return (${String(callback)})`)() as (...rest: readonly unknown[]) => unknown;
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries(globals)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  try {
    return Reflect.apply(serialized, undefined, arguments_);
  } finally {
    for (const [name, descriptor] of previous) {
      if (descriptor === undefined) {
        Reflect.deleteProperty(globalThis, name);
      } else {
        Object.defineProperty(globalThis, name, descriptor);
      }
    }
  }
}
