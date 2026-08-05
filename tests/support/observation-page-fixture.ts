export interface ObservationPageOptions {
  readonly assistantTurnIdBeforeReload?: string;
  readonly assistantTurnIdAfterReload?: string;
  readonly contentBeforeReload?: string;
  readonly contentBeforeReloadByPoll?: readonly string[];
  readonly contentAfterReload?: string;
  readonly conversationIdAfterReload?: string;
  readonly copyVisibleBeforeReload?: boolean;
  readonly copyVisibleAfterReload?: boolean;
  readonly stopVisibleBeforeReload?: boolean;
  readonly stopVisibleAfterReload?: boolean;
}

export interface ObservationPageFixture {
  readonly page: object;
  readonly events: string[];
  reloadCount(): number;
}

/**
 * Creates the page boundary needed to execute a generated response-observation function.
 *
 * @param options Target identity, Copy visibility, content, and Stop state before and after reload.
 * @returns Page-shaped fixture with an ordered event audit and reload counter.
 * @throws {Error} The fixture rejects unsupported generated page operations.
 */
export function observationPageFixture(options: ObservationPageOptions = {}): ObservationPageFixture {
  const events: string[] = [];
  const storage = new Map<string, string>();
  let polls = 0;
  let reloaded = false;
  let reloads = 0;

  const currentAssistantTurnId = (): string => {
    return reloaded
      ? (options.assistantTurnIdAfterReload ?? options.assistantTurnIdBeforeReload ?? 'conversation-turn-2')
      : (options.assistantTurnIdBeforeReload ?? 'conversation-turn-2');
  };
  const currentContent = (): string => {
    const contentSequence = options.contentBeforeReloadByPoll;
    const polledContent =
      contentSequence === undefined || contentSequence.length === 0
        ? undefined
        : contentSequence[Math.min(Math.max(polls - 1, 0), contentSequence.length - 1)];
    if (!reloaded && polledContent !== undefined) {
      return polledContent;
    }
    return reloaded
      ? (options.contentAfterReload ?? options.contentBeforeReload ?? 'stable fixture response')
      : (options.contentBeforeReload ?? 'stable fixture response');
  };
  const copyVisible = (): boolean => {
    return reloaded
      ? (options.copyVisibleAfterReload ?? options.copyVisibleBeforeReload ?? true)
      : (options.copyVisibleBeforeReload ?? true);
  };
  const stopVisible = (): boolean => {
    return reloaded
      ? (options.stopVisibleAfterReload ?? options.stopVisibleBeforeReload ?? false)
      : (options.stopVisibleBeforeReload ?? false);
  };
  const currentConversationId = (): string => {
    return reloaded ? (options.conversationIdAfterReload ?? 'conversation-a') : 'conversation-a';
  };

  const stop = {
    count() {
      return Promise.resolve(1);
    },
    first() {
      return stop;
    },
    isVisible() {
      events.push(`stop:${String(stopVisible())}`);
      return Promise.resolve(stopVisible());
    },
  };

  const turnLocator = {
    evaluateAll(callback: unknown) {
      polls += 1;
      events.push(`poll:${polls}:${currentAssistantTurnId()}`);
      const elements = [
        new FixtureHtmlElement('user', 'conversation-turn-1', 'fixture prompt', false),
        new FixtureHtmlElement('assistant', currentAssistantTurnId(), currentContent(), copyVisible()),
      ];
      return Promise.resolve(withFixtureHtmlElement(callback, elements));
    },
  };

  const page = {
    evaluate(callback: unknown, argument?: unknown) {
      const source = String(callback);
      if (source.includes('location.hostname')) {
        return Promise.resolve({
          hostname: 'chatgpt.com',
          pathname: `/c/${currentConversationId()}`,
          origin: 'https://chatgpt.com',
        });
      }
      if (source.includes('sessionStorage.getItem')) {
        const sessionStorage = {
          getItem(key: string) {
            return storage.get(key) ?? null;
          },
          setItem(key: string, value: string) {
            events.push(`storage:${key}`);
            storage.set(key, value);
          },
        };
        return Promise.resolve(withGlobal('sessionStorage', sessionStorage, callback, argument));
      }
      return Promise.reject(new Error(`fixture cannot execute page.evaluate callback: ${source.slice(0, 80)}`));
    },
    locator(selector: string) {
      if (selector !== '[data-testid^="conversation-turn-"][data-turn]') {
        throw new Error(`unexpected observation locator: ${selector}`);
      }
      return turnLocator;
    },
    getByRole(role: string, query: { readonly name?: string }) {
      if (role !== 'button' || query.name !== 'Stop answering') {
        throw new Error(`unexpected observation role: ${role}/${query.name ?? ''}`);
      }
      return stop;
    },
    reload() {
      reloads += 1;
      reloaded = true;
      events.push('reload');
      return Promise.resolve();
    },
    waitForTimeout() {
      return Promise.resolve();
    },
  };

  return {
    page,
    events,
    reloadCount() {
      return reloads;
    },
  };
}

class FixtureHtmlElement {
  readonly #copyVisible: boolean;
  readonly #dataTestId: string;
  readonly #dataTurn: string;
  readonly textContent: string;

  /**
   * Creates one minimal turn or Copy element used by the generated DOM callback.
   *
   * @param dataTurn Turn role exposed through `data-turn`.
   * @param dataTestId Stable DOM identity exposed through `data-testid`.
   * @param textContent Assistant content snapshot used by the stability detector.
   * @param copyVisible Whether the assistant exposes one visible Copy control.
   * @throws {Error} Construction performs no fallible I/O.
   */
  constructor(dataTurn: string, dataTestId: string, textContent: string, copyVisible: boolean) {
    this.#dataTurn = dataTurn;
    this.#dataTestId = dataTestId;
    this.textContent = textContent;
    this.#copyVisible = copyVisible;
  }

  /**
   * Reads the two attributes used by the generated target-turn lookup.
   *
   * @param name Requested attribute name.
   * @returns Attribute value, or null for unsupported attributes.
   * @throws {Error} Attribute reads do not throw.
   */
  getAttribute(name: string): string | null {
    if (name === 'data-turn') {
      return this.#dataTurn;
    }
    if (name === 'data-testid') {
      return this.#dataTestId;
    }
    return null;
  }

  /**
   * Returns the target assistant's unique Copy control when requested.
   *
   * @param selector Generated descendant selector.
   * @returns Empty collection or one Copy-shaped element.
   * @throws {Error} Selector matching does not throw.
   */
  querySelectorAll(selector: string): readonly FixtureHtmlElement[] {
    if (selector !== '[data-testid="copy-turn-action-button"]' || this.#dataTurn !== 'assistant') {
      return [];
    }
    return [new FixtureHtmlElement('control', 'copy-turn-action-button', '', this.#copyVisible)];
  }

  /**
   * Models browser visibility for the generated `HTMLElement` check.
   *
   * @returns One client rect for a visible Copy control, otherwise none.
   * @throws {Error} Visibility reads do not throw.
   */
  getClientRects(): readonly object[] {
    return this.#copyVisible ? [{}] : [];
  }
}

/**
 * Executes a generated callback with the fixture element class installed as `HTMLElement`.
 *
 * @param callback Generated DOM callback.
 * @param elements Ordered user and assistant elements.
 * @returns Callback result.
 * @throws {TypeError} If the generated callback is not callable.
 */
function withFixtureHtmlElement(callback: unknown, elements: readonly FixtureHtmlElement[]): unknown {
  return withGlobal('HTMLElement', FixtureHtmlElement, callback, elements);
}

/**
 * Installs one browser global only for a generated callback invocation.
 *
 * @param name Browser global name.
 * @param value Fixture implementation.
 * @param callback Generated callback.
 * @param argument Callback argument.
 * @returns Callback result.
 * @throws {TypeError} If the callback is not callable.
 */
function withGlobal(name: string, value: unknown, callback: unknown, argument: unknown): unknown {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = globals[name];
  globals[name] = value;
  try {
    if (typeof callback !== 'function') {
      throw new TypeError('fixture callback is not a function');
    }
    return Reflect.apply(callback, undefined, [argument]);
  } finally {
    if (previous === undefined) {
      delete globals[name];
    } else {
      globals[name] = previous;
    }
  }
}
