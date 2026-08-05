import { writeFile } from 'node:fs/promises';

export interface ArtifactPageOptions {
  readonly assistantTurnId?: string;
  readonly captureDigestDelayMs?: number;
  readonly contentText?: string;
  readonly contentTextAfterFingerprint?: string;
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
  const assistantElement = fixtureElement(attributes, {
    behaviorButtonCount: options.behaviorButtonCount,
    innerText: options.contentText,
  });
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
        return visibleControl(() => {
          events.push('copy');
          return Promise.resolve();
        });
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

  const turns = [
    fixtureElement(attributes, { dataTurn: 'user', dataTestId: 'conversation-turn-1' }),
    fixtureElement(attributes, {
      dataTurn: 'assistant',
      dataTestId: options.assistantTurnId ?? 'conversation-turn-2',
      innerText: options.contentText,
    }),
  ];
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

  const response = {
    plain: 'fixture response',
    html: options.responseHtml,
  };
  const page = {
    evaluate(callback: unknown, argument?: unknown) {
      const source = String(callback);
      if (source.includes('location.hostname')) {
        return Promise.resolve({
          hostname: 'chatgpt.com',
          pathname: '/c/conversation-a',
          origin: 'https://chatgpt.com',
        });
      }
      if (source.includes('const clipboard = navigator.clipboard')) {
        events.push('clipboard:install');
        return Promise.resolve();
      }
      if (source.includes('const state = globalThis.__chatgptProCollabClipboard')) {
        events.push('clipboard:restore');
        return Promise.resolve();
      }
      if (source.includes('recovered completion content changed before Copy')) {
        const finalCheck = argument as {
          readonly expectedAssistantTurnId: string;
          readonly expectedContent: string;
        };
        const actualAssistantTurnId = options.assistantTurnId ?? 'conversation-turn-2';
        if (finalCheck.expectedAssistantTurnId !== actualAssistantTurnId) {
          throw new Error('page contract drift: observed assistant turn identity changed before Copy');
        }
        const finalContent = options.contentTextAfterFingerprint ?? options.contentText ?? '';
        if (finalCheck.expectedContent !== finalContent) {
          throw new Error('page contract drift: recovered completion content changed before Copy');
        }
        events.push('copy');
        return Promise.resolve();
      }
      if (source.includes('globalThis.__chatgptProCollabClipboard.captured')) {
        return Promise.resolve(response);
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
    waitForFunction() {
      return Promise.resolve();
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

  return { page, events };
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
