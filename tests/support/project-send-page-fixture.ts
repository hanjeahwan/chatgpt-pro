export interface ProjectSendPageFixture {
  readonly page: object;
  readonly events: string[];
  setArchived(archived: boolean): void;
  setComposerText(text: string): void;
  setPathname(pathname: string): void;
  setUserTurnCount(count: number): void;
}

interface SendDomNode {
  readonly tagName: string;
  textContent: string;
  readonly attributes: Readonly<Record<string, string>>;
  getAttribute(name: string): string | null;
  getClientRects(): readonly object[];
}

class SendHtmlElement implements SendDomNode {
  readonly tagName: string;
  textContent: string;
  readonly attributes: Readonly<Record<string, string>>;

  /**
   * Creates one fixture DOM node.
   *
   * @param tagName Element tag.
   * @param textContent Element text.
   * @param attributes Element attributes.
   * @throws {Error} This constructor does not perform I/O.
   */
  constructor(tagName: string, textContent: string, attributes: Readonly<Record<string, string>>) {
    this.tagName = tagName;
    this.textContent = textContent;
    this.attributes = attributes;
  }

  /**
   * Reads one attribute.
   *
   * @param name Attribute name.
   * @returns Attribute value or null.
   */
  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
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
 * Creates the minimal Project composer and conversation boundary needed to execute the
 * generated send boundary scripts, with mutable state for interleaved drift tests.
 *
 * @param initialPathname Starting page pathname.
 * @returns Page-shaped fixture, ordered events, and state mutators.
 * @throws {Error} Unsupported selectors fail instead of being guessed.
 */
export function projectSendPageFixture(initialPathname: string): ProjectSendPageFixture {
  const events: string[] = [];
  const state = {
    archived: false,
    composerText: '',
    pathname: initialPathname,
    userTurnCount: 0,
  };

  const composer = new SendHtmlElement('div', state.composerText, { id: 'prompt-textarea' });
  const title = new SendHtmlElement('h1', 'chatgpt-pro-collab', {});
  const main = {
    querySelectorAll(selector: string) {
      return selector === 'h1' ? [title] : [];
    },
  };
  const archivedMessage = new SendHtmlElement(
    'div',
    'This conversation is archived. To continue, please unarchive it first.',
    {},
  );
  const turnElements = (): readonly SendHtmlElement[] => {
    return Array.from({ length: state.userTurnCount }, (_unused, index) => {
      return new SendHtmlElement('div', '', {
        'data-testid': `conversation-turn-${index + 1}`,
        'data-turn': 'user',
      });
    });
  };

  const documentRoot = {
    querySelector(selector: string) {
      if (selector === 'main' || selector === '[role="main"]') {
        return main;
      }
      if (selector === '#prompt-textarea') {
        return composer;
      }
      return null;
    },
    querySelectorAll(selector: string) {
      if (selector === '#prompt-textarea') {
        return [composer];
      }
      if (selector === '[data-testid^="conversation-turn-"][data-turn]') {
        return turnElements();
      }
      if (selector === 'div') {
        return state.archived ? [archivedMessage] : [];
      }
      if (selector === 'a, button') {
        return [];
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
      HTMLElement: SendHtmlElement,
      HTMLAnchorElement: SendHtmlElement,
      location: { hostname: 'chatgpt.com', pathname: state.pathname, origin: 'https://chatgpt.com' },
    };
  };

  const locatorCollection = (selector: string) => {
    const matches = (): readonly SendDomNode[] => {
      if (selector === '#prompt-textarea') {
        return [composer];
      }
      if (selector === '[data-testid="send-button"]') {
        return [new SendHtmlElement('button', '', { 'data-testid': 'send-button' })];
      }
      if (selector === '[data-testid^="conversation-turn-"][data-turn]') {
        return turnElements();
      }
      return [];
    };
    const count = async (): Promise<number> => {
      return matches().length;
    };
    return {
      count,
      async click() {
        if (selector === '[data-testid="send-button"]') {
          events.push('send-click');
          state.userTurnCount += 1;
          state.pathname = '/g/g-p-123-chatgpt-pro-collab/c/new-conversation';
          return;
        }
        throw new Error(`fixture locator click is unsupported: ${selector}`);
      },
      async fill(text: string) {
        if (selector === '#prompt-textarea') {
          state.composerText = text;
          return;
        }
        throw new Error(`fixture locator fill is unsupported: ${selector}`);
      },
      async isVisible() {
        return matches().length === 1;
      },
      async waitFor() {
        if (matches().length === 0) {
          throw new Error(`fixture locator is absent: ${selector}`);
        }
      },
      async evaluateAll(callback: unknown) {
        if (typeof callback !== 'function') {
          throw new TypeError('fixture locator callback is not a function');
        }
        return Reflect.apply(callback, undefined, [matches()]);
      },
    };
  };

  const page = {
    evaluate(callback: unknown, argument?: unknown) {
      return Promise.resolve(withSendGlobals(globals(), callback, argument));
    },
    getByText(text: string, _options: { readonly exact?: boolean }) {
      const visible = state.archived && text === archivedMessage.textContent;
      return {
        count() {
          return Promise.resolve(visible ? 1 : 0);
        },
        isVisible() {
          return Promise.resolve(visible);
        },
      };
    },
    getByRole(role: string, options: { readonly name?: string; readonly exact?: boolean }) {
      const visible = role === 'button' && options.name === 'Unarchive' && state.archived;
      return {
        count() {
          return Promise.resolve(visible ? 1 : 0);
        },
        isVisible() {
          return Promise.resolve(visible);
        },
        async click() {
          if (visible) {
            events.push('unarchive-click');
            state.archived = false;
            return;
          }
          throw new Error('fixture Unarchive control is absent');
        },
      };
    },
    locator(selector: string) {
      return locatorCollection(selector);
    },
    async waitForFunction(callback: unknown, argument?: unknown) {
      const startedAt = Date.now();
      while (true) {
        if (withSendGlobals(globals(), callback, argument) === true) {
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

  return {
    page,
    events,
    setArchived(archived: boolean) {
      state.archived = archived;
    },
    setComposerText(text: string) {
      state.composerText = text;
      composer.textContent = text;
    },
    setPathname(pathname: string) {
      state.pathname = pathname;
    },
    setUserTurnCount(count: number) {
      state.userTurnCount = count;
    },
  };
}

/**
 * Executes one generated send callback with the fixture browser globals installed.
 *
 * @param globals Browser globals installed for the callback duration.
 * @param callback Generated page callback.
 * @param argument Callback argument supplied by the page function.
 * @returns The callback result.
 * @throws {TypeError} If the callback is not callable.
 */
function withSendGlobals(globals: { readonly [name: string]: unknown }, callback: unknown, argument: unknown): unknown {
  if (typeof callback !== 'function') {
    throw new TypeError('send fixture callback is not a function');
  }
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries(globals)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  try {
    return Reflect.apply(callback, undefined, [argument]);
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
