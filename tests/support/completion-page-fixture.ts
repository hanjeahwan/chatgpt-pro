export interface CompletionPageOptions {
  readonly assistantTurnId?: string;
  readonly stopVisible: boolean;
}

export interface CompletionPageFixture {
  readonly events: string[];
  readonly page: object;
}

/**
 * Creates the minimal page boundary required to execute normal completion observation.
 *
 * @param options Target assistant identity and Stop visibility.
 * @returns Page-shaped fixture plus ordered observation events.
 * @throws {Error} Unsupported selectors or callbacks fail instead of being guessed.
 */
export function completionPageFixture(options: CompletionPageOptions): CompletionPageFixture {
  const events: string[] = [];
  const copy = new FixtureHtmlElement();
  const turns = [
    new FixtureTurn('user', 'conversation-turn-user'),
    new FixtureTurn('assistant', options.assistantTurnId ?? 'conversation-turn-t1', copy),
  ];
  const page = {
    evaluate(callback: unknown) {
      return Promise.resolve(
        withGlobal(
          'location',
          { hostname: 'chatgpt.com', origin: 'https://chatgpt.com', pathname: '/c/conversation-a' },
          callback,
        ),
      );
    },
    getByRole() {
      return {
        count() {
          return Promise.resolve(options.stopVisible ? 1 : 0);
        },
        first() {
          return {
            isVisible() {
              return Promise.resolve(options.stopVisible);
            },
          };
        },
      };
    },
    locator(selector: string) {
      if (selector !== '[data-testid^="conversation-turn-"][data-turn]') {
        throw new Error(`unsupported completion fixture selector: ${selector}`);
      }
      return {
        evaluateAll(callback: unknown) {
          events.push('observe');
          return Promise.resolve(withGlobal('HTMLElement', FixtureHtmlElement, callback, turns));
        },
      };
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

class FixtureTurn {
  private readonly copy: FixtureHtmlElement | undefined;
  private readonly dataTestId: string;
  private readonly dataTurn: string;

  /**
   * Creates one conversation turn.
   *
   * @param dataTurn User or assistant role.
   * @param dataTestId Stable DOM identity.
   * @param copy Optional visible Copy element.
   */
  constructor(dataTurn: string, dataTestId: string, copy?: FixtureHtmlElement) {
    this.copy = copy;
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

  /**
   * Returns the target assistant Copy element.
   *
   * @param selector Child selector.
   * @returns Zero or one matching Copy elements.
   */
  querySelectorAll(selector: string): readonly FixtureHtmlElement[] {
    return selector === '[data-testid="copy-turn-action-button"]' && this.copy !== undefined ? [this.copy] : [];
  }
}

/**
 * Executes one callback with a temporary browser global.
 *
 * @param name Global property name.
 * @param value Temporary value.
 * @param callback Generated page callback.
 * @param arguments_ Callback arguments.
 * @returns The generated callback result.
 */
function withGlobal(name: string, value: unknown, callback: unknown, ...arguments_: readonly unknown[]): unknown {
  if (typeof callback !== 'function') {
    throw new TypeError('completion fixture callback is not callable');
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  try {
    return Reflect.apply(callback, undefined, arguments_);
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(globalThis, name);
    } else {
      Object.defineProperty(globalThis, name, previous);
    }
  }
}
