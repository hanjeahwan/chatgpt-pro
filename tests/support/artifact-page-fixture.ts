import { writeFile } from 'node:fs/promises';

export interface ArtifactPageOptions {
  readonly assistantTurnId?: string;
  readonly captureDigestDelayMs?: number;
  readonly contentText?: string;
  readonly contentTextAfterFingerprint?: string;
  readonly conversationIdAfterFingerprint?: string;
  readonly hostnameAfterFingerprint?: string;
  readonly pathnameAfterFingerprint?: string;
  readonly responsePlain?: string;
  readonly responseHtml: string;
  readonly behaviorButtonCount: number;
  readonly artifactRows?: readonly string[];
  readonly unrelatedRowControls?: boolean;
  readonly downloadEvent?: 'success' | 'timeout';
  readonly suggestedFilename?: string;
}

export interface ArtifactPageFixture {
  readonly page: object;
  readonly events: string[];
  globalsRestored(): boolean;
}

interface FixtureAnchor {
  readonly textContent: string;
  getAttribute(name: string): string | null;
}

interface FixtureElement {
  readonly innerText?: string;
  readonly parentElement?: FixtureElement | null;
  readonly textContent?: string;
  closest(selector: string): FixtureElement | null;
  getAttribute(name: string): string | null;
  querySelectorAll(selector: string): readonly FixtureElement[];
  removeAttribute(name: string): void;
  setAttribute(name: string, value: string): void;
}

/** Minimal visible HTMLElement used to execute the recovered Copy critical section. */
class FixtureHtmlElement implements FixtureElement {
  readonly parentElement = null;
  readonly textContent = '';
  readonly #clickAction: () => void;

  /**
   * Creates one visible, enabled Copy control.
   *
   * @param clickAction Synchronous click side effect recorded by the fixture.
   */
  constructor(clickAction: () => void) {
    this.#clickAction = clickAction;
  }

  /** @returns No ancestor relationship for the standalone Copy control. */
  closest(): null {
    return null;
  }

  /**
   * Reads one stable Copy control attribute.
   *
   * @param name Requested attribute name.
   * @returns The stable Copy test id or null for unsupported attributes.
   */
  getAttribute(name: string): string | null {
    return name === 'data-testid' ? 'copy-turn-action-button' : null;
  }

  /** @returns A non-empty client rect collection, making this control visible. */
  getClientRects(): readonly object[] {
    return [{}];
  }

  /** @returns False because the fixture Copy control is enabled. */
  matches(): boolean {
    return false;
  }

  /** Executes the synchronous click side effect. */
  click(): void {
    this.#clickAction();
  }

  /** @returns No descendants for the standalone Copy control. */
  querySelectorAll(): readonly FixtureElement[] {
    return [];
  }

  /** Standalone fixture controls do not retain mutable attributes. */
  removeAttribute(): void {}

  /** Standalone fixture controls do not retain mutable attributes. */
  setAttribute(): void {}
}

/**
 * Creates a live-compatible page boundary for executing generated capture and download functions.
 *
 * @param options Copy response, button, row, and download-event state exposed to the page function.
 * @returns Page-shaped fixture plus an ordered event audit.
 * @throws {Error} Fixture methods reject when generated code requests an absent control or a forced timeout.
 */
export function artifactPageFixture(options: ArtifactPageOptions): ArtifactPageFixture {
  const events: string[] = [];
  const storage = new Map<string, string>();
  const attributes = new WeakMap<object, Map<string, string>>();
  const globals = globalThis as unknown as Record<string, unknown>;
  const trackedGlobalNames = [
    '__chatgptProCollabClipboard',
    'document',
    'getComputedStyle',
    'HTMLElement',
    'location',
    'navigator',
  ] as const;
  const initialGlobalDescriptors = new Map(
    trackedGlobalNames.map((name) => {
      return [name, Object.getOwnPropertyDescriptor(globalThis, name)];
    }),
  );
  const originalClipboardWrite = async (_items: readonly unknown[]) => {};
  const originalClipboardWriteText = async (_text: string) => {};
  const clipboard = {
    write: originalClipboardWrite,
    writeText: originalClipboardWriteText,
  };
  const navigator = { clipboard };
  let pendingClipboardWrite: Promise<void> | undefined;

  const triggerCopy = (): Promise<void> => {
    events.push('copy');
    const plain = options.responsePlain ?? 'fixture response';
    const html = options.responseHtml;
    pendingClipboardWrite = clipboard
      .write([
        {
          types: ['text/plain', 'text/html'],
          async getType(type: string) {
            return {
              async text() {
                return type === 'text/plain' ? plain : html;
              },
            };
          },
        },
      ])
      .then(() => {
        events.push('clipboard:write');
      });
    return pendingClipboardWrite;
  };
  const assistantElement = fixtureElement(attributes, {
    behaviorButtonCount: options.behaviorButtonCount,
    dataTestId: options.assistantTurnId ?? 'conversation-turn-2',
    dataTurn: 'assistant',
    innerText: options.contentText,
  });
  const finalAssistantElement = fixtureElement(attributes, {
    dataTestId: options.assistantTurnId ?? 'conversation-turn-2',
    dataTurn: 'assistant',
    innerText: options.contentTextAfterFingerprint ?? options.contentText,
  });
  const copyElement = new FixtureHtmlElement(() => {
    void triggerCopy();
  });
  finalAssistantElement.querySelectorAll = (selector: string) => {
    return selector === '[data-testid="copy-turn-action-button"]' ? [copyElement] : [];
  };
  let resolveDownload: ((download: object) => void) | undefined;
  let rejectDownload: ((error: Error) => void) | undefined;

  const triggerDownload = (kind: 'direct' | 'artifact'): Promise<void> => {
    events.push(`download:${kind}`);
    if (options.downloadEvent === 'timeout') {
      rejectDownload?.(new Error('fixture download event timeout'));
      return Promise.resolve();
    }
    const suggestedFilename = options.suggestedFilename ?? 'result.txt';
    resolveDownload?.({
      saveAs(path: string) {
        events.push(`save:${path}`);
        return writeFile(path, `downloaded ${suggestedFilename}`);
      },
      suggestedFilename() {
        return suggestedFilename;
      },
      url() {
        return 'https://chatgpt.com/backend-api/estuary/content/fixture';
      },
    });
    return Promise.resolve();
  };

  const behaviorButtons = Array.from({ length: options.behaviorButtonCount }, () => {
    return visibleControl(() => {
      return triggerDownload('direct');
    });
  });
  const rowButtons = (options.artifactRows ?? []).map((filename) => {
    const row = fixtureElement(attributes, {
      innerText: filename,
      unrelatedRowControls: options.unrelatedRowControls ?? false,
    });
    const open = fixtureElement(attributes, { ariaLabel: filename, parentElement: row });
    const download = fixtureElement(attributes, {
      ariaLabel: 'Download file',
      assistantElement,
      parentElement: row,
    });
    row.querySelectorAll = (selector: string) => {
      if (selector !== 'button') {
        return [];
      }
      return options.unrelatedRowControls === true ? [download] : [open, download];
    };
    return download;
  });

  const rowDownloadButtons = {
    count() {
      return Promise.resolve(rowButtons.length);
    },
    nth(index: number) {
      const button = rowButtons[index];
      return {
        evaluate(callback: unknown, argument?: unknown) {
          if (button === undefined) {
            return Promise.reject(new Error(`fixture artifact row is absent: ${index}`));
          }
          return Promise.resolve(invoke(callback, button, argument));
        },
      };
    },
    evaluateAll(callback: unknown, argument?: unknown) {
      return Promise.resolve(invoke(callback, rowButtons, argument));
    },
  };

  const assistant = {
    locator(selector: string) {
      if (selector === '[data-testid="copy-turn-action-button"]') {
        return visibleControl(triggerCopy);
      }
      if (selector === 'button.behavior-btn') {
        return locatorCollection(behaviorButtons);
      }
      if (selector.includes('data-chatgpt-pro-collab-target-download')) {
        const marked = rowButtons.filter((button) => {
          return button.getAttribute('data-chatgpt-pro-collab-target-download') === 'true';
        });
        return locatorCollection(
          marked.map(() => {
            return visibleControl(() => {
              return triggerDownload('artifact');
            });
          }),
        );
      }
      return locatorCollection([]);
    },
    evaluate(callback: unknown, argument?: unknown) {
      return Promise.resolve(withFixtureDomParser(callback, assistantElement, argument));
    },
    getByText() {
      return locatorCollection([]);
    },
    getByRole(_role: string, query: { readonly name?: string }) {
      return query.name === 'Download file' ? rowDownloadButtons : locatorCollection([]);
    },
  };

  const turns = [fixtureElement(attributes, { dataTurn: 'user', dataTestId: 'conversation-turn-1' }), assistantElement];
  const finalTurns = [turns[0] as FixtureElement, finalAssistantElement];
  const turnLocator = {
    last() {
      return visibleControl(() => {
        return Promise.resolve();
      });
    },
    nth(index: number) {
      return index === 1 ? assistant : locatorCollection([]);
    },
    evaluateAll(callback: unknown, argument?: unknown) {
      return Promise.resolve(invoke(callback, turns, argument));
    },
  };

  const page = {
    evaluate(callback: unknown, argument?: unknown) {
      const source = String(callback);
      if (source.includes('document.querySelectorAll(turnSelector)')) {
        const document = {
          querySelectorAll(selector: string) {
            return selector === '[data-testid^="conversation-turn-"][data-turn]' ? finalTurns : [];
          },
        };
        return Promise.resolve(
          withGlobals(
            {
              document,
              getComputedStyle() {
                return { display: 'block', visibility: 'visible' };
              },
              HTMLElement: FixtureHtmlElement,
              location: {
                hostname: options.hostnameAfterFingerprint ?? 'chatgpt.com',
                pathname:
                  options.pathnameAfterFingerprint ??
                  `/c/${options.conversationIdAfterFingerprint ?? 'conversation-a'}`,
              },
            },
            callback,
            argument,
          ),
        );
      }
      if (source.includes('location.hostname')) {
        return Promise.resolve({
          hostname: 'chatgpt.com',
          pathname: '/c/conversation-a',
          origin: 'https://chatgpt.com',
        });
      }
      if (source.includes('const clipboard = navigator.clipboard')) {
        events.push('clipboard:install');
        return Promise.resolve(withGlobals({ navigator }, callback, argument));
      }
      if (source.includes('const state = globalThis.__chatgptProCollabClipboard')) {
        const result = withGlobals({ navigator }, callback, argument);
        events.push('clipboard:restore');
        return Promise.resolve(result);
      }
      if (source.includes('globalThis.__chatgptProCollabClipboard.captured')) {
        const result = invoke(callback, argument);
        events.push('clipboard:read');
        return Promise.resolve(result);
      }
      if (source.includes('sessionStorage.getItem')) {
        const sessionStorage = {
          getItem(key: string) {
            return storage.get(key) ?? (key.includes(':completion-target:') ? 'conversation-turn-2' : null);
          },
          setItem(key: string, value: string) {
            storage.set(key, value);
          },
        };
        return Promise.resolve(withGlobal('sessionStorage', sessionStorage, callback, argument));
      }
      if (source.includes('new DOMParser')) {
        return Promise.resolve(withFixtureDomParser(callback, argument));
      }
      return Promise.reject(new Error(`fixture cannot execute page.evaluate callback: ${source.slice(0, 80)}`));
    },
    locator(selector: string) {
      return selector === '[data-testid^="conversation-turn-"][data-turn]' ? turnLocator : locatorCollection([]);
    },
    getByRole() {
      return locatorCollection([]);
    },
    reload() {
      events.push('reload');
      return Promise.resolve();
    },
    async waitForFunction(callback: unknown, argument?: unknown) {
      await pendingClipboardWrite;
      if (invoke(callback, argument) !== true) {
        throw new Error('fixture clipboard capture did not settle');
      }
    },
    waitForEvent(event: string) {
      if (event !== 'download') {
        return Promise.reject(new Error(`unexpected fixture event: ${event}`));
      }
      return new Promise<object>((resolve, reject) => {
        resolveDownload = resolve;
        rejectDownload = reject;
      });
    },
    waitForTimeout() {
      return Promise.resolve();
    },
  };

  return {
    page,
    events,
    globalsRestored() {
      return (
        trackedGlobalNames.every((name) => {
          return descriptorsEqual(
            Object.getOwnPropertyDescriptor(globalThis, name),
            initialGlobalDescriptors.get(name),
          );
        }) &&
        clipboard.write === originalClipboardWrite &&
        clipboard.writeText === originalClipboardWriteText &&
        globals.__chatgptProCollabClipboard === undefined
      );
    },
  };
}

/**
 * Creates one element-shaped fixture with mutable attributes and optional row relationships.
 *
 * @param attributes Shared mutable attribute storage.
 * @param options Element identity and relationship fields used by generated callbacks.
 * @returns Element-shaped object understood by the generated page code.
 * @throws {Error} Element operations do not throw for supported selectors.
 */
function fixtureElement(
  attributes: WeakMap<object, Map<string, string>>,
  options: {
    readonly ariaLabel?: string;
    readonly assistantElement?: FixtureElement;
    readonly behaviorButtonCount?: number;
    readonly dataTurn?: string;
    readonly dataTestId?: string;
    readonly innerText?: string;
    readonly parentElement?: FixtureElement;
    readonly unrelatedRowControls?: boolean;
  },
): FixtureElement {
  const element: FixtureElement = {
    innerText: options.innerText,
    parentElement: options.parentElement ?? null,
    textContent: options.innerText ?? options.ariaLabel ?? '',
    closest() {
      return options.assistantElement ?? null;
    },
    getAttribute(name: string) {
      if (name === 'aria-label') {
        return options.ariaLabel ?? null;
      }
      if (name === 'data-turn') {
        return options.dataTurn ?? null;
      }
      if (name === 'data-testid') {
        return options.dataTestId ?? null;
      }
      return attributes.get(element)?.get(name) ?? null;
    },
    querySelectorAll(selector: string) {
      if (selector === 'button.behavior-btn') {
        return Array.from({ length: options.behaviorButtonCount ?? 0 }, () => {
          return fixtureElement(attributes, {});
        });
      }
      return [];
    },
    removeAttribute(name: string) {
      attributes.get(element)?.delete(name);
    },
    setAttribute(name: string, value: string) {
      const current = attributes.get(element) ?? new Map<string, string>();
      current.set(name, value);
      attributes.set(element, current);
    },
  };
  return element;
}

/**
 * Creates a locator collection with the subset used by generated page functions.
 *
 * @param controls Ordered visible controls.
 * @returns Locator-shaped collection supporting count, first, nth, visibility, click, and wait.
 * @throws {Error} An absent indexed control rejects click or wait operations.
 */
function locatorCollection(controls: readonly ReturnType<typeof visibleControl>[]) {
  return {
    count() {
      return Promise.resolve(controls.length);
    },
    first() {
      return (
        controls[0] ??
        visibleControl(() => {
          return Promise.reject(new Error('fixture control is absent'));
        })
      );
    },
    nth(index: number) {
      return (
        controls[index] ??
        visibleControl(() => {
          return Promise.reject(new Error(`fixture control is absent: ${index}`));
        })
      );
    },
    isVisible() {
      return Promise.resolve(controls.length === 1);
    },
    click() {
      return controls.length === 1
        ? controls[0].click()
        : Promise.reject(new Error(`fixture control count is ${controls.length}`));
    },
    waitFor() {
      return controls.length > 0 ? Promise.resolve() : Promise.reject(new Error('fixture control is absent'));
    },
  };
}

/**
 * Creates one visible control with a supplied click side effect.
 *
 * @param clickAction Effect run when generated code clicks the control.
 * @returns Control-shaped object.
 * @throws {Error} Propagates failures from `clickAction`.
 */
function visibleControl(clickAction: () => Promise<void>) {
  return {
    count() {
      return Promise.resolve(1);
    },
    first() {
      return this;
    },
    nth() {
      return this;
    },
    isVisible() {
      return Promise.resolve(true);
    },
    click() {
      return clickAction();
    },
    waitFor() {
      return Promise.resolve();
    },
  };
}

/**
 * Executes a generated callback with the fixture DOMParser installed for its duration.
 *
 * @param callback Generated page callback.
 * @param arguments_ Callback arguments supplied by the Playwright-shaped fixture.
 * @returns The callback result.
 * @throws {Error} Propagates callback and fixture parser failures.
 */
function withFixtureDomParser(callback: unknown, ...arguments_: readonly unknown[]): unknown {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = globals.DOMParser;
  globals.DOMParser = FixtureDomParser;
  try {
    return invoke(callback, ...arguments_);
  } finally {
    if (previous === undefined) {
      delete globals.DOMParser;
    } else {
      globals.DOMParser = previous;
    }
  }
}

/**
 * Invokes one unknown generated callback after validating it is callable.
 *
 * @param callback Unknown callback value received by a fixture method.
 * @param arguments_ Arguments supplied to the callback.
 * @returns The callback result.
 * @throws {TypeError} If the generated value is not a function.
 */
function invoke(callback: unknown, ...arguments_: readonly unknown[]): unknown {
  if (typeof callback !== 'function') {
    throw new TypeError('fixture callback is not a function');
  }
  return Reflect.apply(callback, undefined, arguments_);
}

/**
 * Installs one browser global while executing a generated page callback.
 *
 * @param name Global property name.
 * @param value Temporary fixture implementation.
 * @param callback Generated callback.
 * @param argument Callback argument.
 * @returns Callback result.
 * @throws {TypeError} If the generated callback is not callable.
 */
function withGlobal(name: string, value: unknown, callback: unknown, argument: unknown): unknown {
  return withGlobals({ [name]: value }, callback, argument);
}

/**
 * Installs the browser globals needed to execute one generated page callback.
 *
 * @param values Browser global names and fixture values.
 * @param callback Generated page callback.
 * @param argument Callback argument supplied by the Playwright-shaped fixture.
 * @returns The callback result.
 * @throws {TypeError} If the generated callback is not callable.
 */
function withGlobals(values: Readonly<Record<string, unknown>>, callback: unknown, argument: unknown): unknown {
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  try {
    return invoke(callback, argument);
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

/**
 * Compares two global property descriptors by the fields used by this fixture.
 *
 * @param actual Descriptor after a generated callback settles.
 * @param expected Descriptor captured before the callback.
 * @returns True when both descriptors represent the same global property.
 */
function descriptorsEqual(actual: PropertyDescriptor | undefined, expected: PropertyDescriptor | undefined): boolean {
  if (actual === undefined || expected === undefined) {
    return actual === expected;
  }
  return (
    actual.configurable === expected.configurable &&
    actual.enumerable === expected.enumerable &&
    actual.get === expected.get &&
    actual.set === expected.set &&
    actual.value === expected.value &&
    actual.writable === expected.writable
  );
}

/** Minimal parser for the anchor-only Copy response contract exercised by the generated functions. */
class FixtureDomParser {
  /**
   * Parses anchor href and text without implementing unrelated browser DOM behavior.
   *
   * @param html Copy response HTML controlled by the fixture.
   * @returns Document-shaped anchor query boundary.
   * @throws {Error} Malformed anchors are ignored rather than guessed.
   */
  parseFromString(html: string): { readonly querySelectorAll: (selector: string) => readonly FixtureAnchor[] } {
    const anchors = [...html.matchAll(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([^<]*)<\/a>/giu)].map((match) => {
      const href = match[1] ?? '';
      const textContent = match[2] ?? '';
      return {
        textContent,
        getAttribute(name: string) {
          return name === 'href' ? href : null;
        },
      };
    });
    return {
      querySelectorAll(selector: string) {
        return selector === 'a' ? anchors : [];
      },
    };
  }
}
