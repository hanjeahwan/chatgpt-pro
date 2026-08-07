export interface StartPageOptions {
  readonly authenticated?: boolean;
  readonly projectLoadsRows?: boolean;
  readonly projectRowCount?: number;
  readonly otherRowCount?: number;
  readonly navigateOnProjectClick?: boolean;
  readonly mainTitleCount?: number;
  readonly composerCount?: number;
  readonly existingTurns?: boolean;
  readonly selectorControlCount?: number;
  readonly plusMenuTrigger?: boolean;
  readonly powerSliderPresent?: boolean;
  readonly powerInitiallyMax?: boolean;
  readonly powerKeysApplies?: boolean;
  readonly modelInitiallyChecked?: boolean;
  readonly modelOpenerCount?: number;
  readonly modelRadioPresent?: boolean;
  readonly modelClickApplies?: boolean;
  readonly modelClickResetsPower?: boolean;
}

export interface StartPageFixture {
  readonly events: string[];
  readonly page: object;
}

interface MenuState {
  readonly menuOpen: boolean;
  readonly submenuOpen: boolean;
}

interface StartDomNode {
  readonly tagName: string;
  readonly textContent: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly StartDomNode[];
  readonly menuLayer: 'first' | 'submenu' | 'none';
  readonly clickAction?: () => void;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  getClientRects(): readonly object[];
  parentNode(): StartDomNode | null;
  querySelector(selector: string): StartDomNode | null;
  querySelectorAll(selector: string): readonly StartDomNode[];
  click(): void;
  focus(): void;
}

class StartHtmlElement implements StartDomNode {
  readonly tagName: string;
  readonly textContent: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly StartDomNode[];
  readonly menuLayer: 'first' | 'submenu' | 'none';
  readonly clickAction?: () => void;
  readonly #readMenuState: () => MenuState;
  readonly #childrenByNode: WeakMap<StartDomNode, readonly StartDomNode[]>;
  readonly #parentOf: WeakMap<StartDomNode, StartDomNode>;

  /**
   * Creates one fixture DOM node.
   *
   * @param options Node identity, attributes, children, menu-layer state access, and click effect.
   * @throws {Error} This constructor does not perform I/O.
   */
  constructor(options: {
    readonly tagName: string;
    readonly textContent: string;
    readonly attributes: Readonly<Record<string, string>>;
    readonly children?: readonly StartDomNode[];
    readonly menuLayer?: 'first' | 'submenu' | 'none';
    readonly readMenuState: () => MenuState;
    readonly childrenByNode: WeakMap<StartDomNode, readonly StartDomNode[]>;
    readonly parentOf?: WeakMap<StartDomNode, StartDomNode>;
    readonly clickAction?: () => void;
  }) {
    this.tagName = options.tagName;
    this.textContent = options.textContent;
    this.attributes = options.attributes;
    this.children = options.children ?? [];
    this.menuLayer = options.menuLayer ?? 'none';
    this.clickAction = options.clickAction;
    this.#readMenuState = options.readMenuState;
    this.#childrenByNode = options.childrenByNode;
    this.#parentOf = options.parentOf ?? new WeakMap<StartDomNode, StartDomNode>();
    this.#childrenByNode.set(this, this.children);
    for (const child of this.children) {
      this.#parentOf.set(child, this);
    }
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
   * Reports whether an attribute is present.
   *
   * @param name Attribute name.
   * @returns True when the attribute exists.
   */
  hasAttribute(name: string): boolean {
    return name in this.attributes;
  }

  /**
   * Reports layout visibility for the current menu state.
   *
   * @returns One rect when the node is exposed by the current menu state.
   */
  getClientRects(): readonly object[] {
    const menu = this.#readMenuState();
    if (this.menuLayer === 'first' && !menu.menuOpen) {
      return [];
    }
    if (this.menuLayer === 'submenu' && !(menu.menuOpen && menu.submenuOpen)) {
      return [];
    }
    return [{}];
  }

  /**
   * Returns the current parent node from the shared fixture parent map.
   *
   * @returns The parent node or null for root nodes.
   */
  parentNode(): StartDomNode | null {
    return this.#parentOf.get(this) ?? null;
  }

  /**
   * Returns the first descendant matching a supported selector.
   *
   * @param selector Supported fixture selector.
   * @returns The first matching descendant or null.
   * @throws {Error} Unsupported selectors fail instead of being guessed.
   */
  querySelector(selector: string): StartDomNode | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  /**
   * Returns matching descendants for a supported selector.
   *
   * @param selector Supported fixture selector.
   * @returns Matching descendants in document order.
   * @throws {Error} Unsupported selectors fail instead of being guessed.
   */
  querySelectorAll(selector: string): readonly StartDomNode[] {
    return this.descendants().filter((element) => {
      return matchesFixtureSelector(element, selector);
    });
  }

  /**
   * Runs the node's click side effect.
   *
   * @throws {Error} Propagates the configured click action failure.
   */
  click(): void {
    this.clickAction?.();
  }

  /**
   * Focuses the node without scrolling or layout side effects.
   *
   * @returns Nothing.
   */
  focus(): void {}

  private descendants(): readonly StartDomNode[] {
    const direct = this.#childrenByNode.get(this) ?? [];
    return [
      ...direct,
      ...direct.flatMap((element) => {
        return element instanceof StartHtmlElement ? element.descendants() : [];
      }),
    ];
  }
}

class StartAnchorElement extends StartHtmlElement {}

/**
 * Creates the minimal Projects directory, Project composer, and model/mode menu boundary
 * needed to execute the generated start verification function.
 *
 * @param options Page structure, selection, and navigation state exposed to the page function.
 * @returns Page-shaped fixture plus an ordered click and selection audit.
 * @throws {Error} Unsupported selectors fail instead of being guessed.
 */
export function startPageFixture(options: StartPageOptions): StartPageFixture {
  const events: string[] = [];
  const state = {
    authenticated: options.authenticated ?? true,
    composerCount: options.composerCount ?? 1,
    currentModel: (options.modelInitiallyChecked ?? false) ? 'GPT-5.6 Sol' : 'GPT-5.5',
    existingTurns: options.existingTurns ?? false,
    focusedElement: null as StartDomNode | null,
    mainTitleCount: options.mainTitleCount ?? 1,
    menuOpen: false,
    modelClickApplies: options.modelClickApplies ?? true,
    modelClickResetsPower: options.modelClickResetsPower ?? false,
    modelOpenerCount: options.modelOpenerCount ?? 1,
    modelRadioPresent: options.modelRadioPresent ?? true,
    navigateOnProjectClick: options.navigateOnProjectClick ?? true,
    otherRowCount: options.otherRowCount ?? 0,
    pathname: '/projects',
    plusMenuTrigger: options.plusMenuTrigger ?? false,
    powerKeysApplies: options.powerKeysApplies ?? true,
    powerInitiallyMax: options.powerInitiallyMax ?? false,
    powerMax: 4,
    powerMin: 0,
    powerNow: (options.powerInitiallyMax ?? false) ? 4 : 2,
    powerSliderPresent: options.powerSliderPresent ?? true,
    projectLoadsRows: options.projectLoadsRows ?? true,
    projectRowCount: options.projectRowCount ?? 1,
    selectorControlCount: options.selectorControlCount ?? 1,
    submenuOpen: false,
  };
  const childrenByNode = new WeakMap<StartDomNode, readonly StartDomNode[]>();
  const parentOf = new WeakMap<StartDomNode, StartDomNode>();
  const setChildren = (parent: StartDomNode, children: readonly StartDomNode[]): void => {
    childrenByNode.set(parent, children);
    for (const child of children) {
      parentOf.set(child, parent);
    }
  };
  const readMenuState = (): MenuState => {
    return { menuOpen: state.menuOpen, submenuOpen: state.submenuOpen };
  };

  const node = (
    tagName: string,
    textContent: string,
    attributes: Readonly<Record<string, string>>,
    children: readonly StartDomNode[] = [],
    clickAction?: () => void,
    menuLayer: 'first' | 'submenu' | 'none' = 'none',
  ): StartDomNode => {
    return new StartHtmlElement({
      tagName,
      textContent,
      attributes,
      children,
      clickAction,
      menuLayer,
      readMenuState,
      childrenByNode,
      parentOf,
    });
  };

  const anchor = (textContent: string, attributes: Readonly<Record<string, string>>): StartDomNode => {
    return new StartAnchorElement({ tagName: 'a', textContent, attributes, readMenuState, childrenByNode, parentOf });
  };

  const closeMenu = (): void => {
    state.menuOpen = false;
    state.submenuOpen = false;
  };

  /**
   * Dispatches one slider keyboard interaction, mirroring the live contract where
   * `End` is ignored and only `Home`/`ArrowRight` move the value.
   *
   * @param key Key name dispatched by the generated page function.
   * @returns Nothing after the slider state is updated.
   * @throws {Error} If no slider is focused or the key is unsupported.
   */
  const dispatchSliderKey = (key: string): void => {
    const focused = state.focusedElement;
    if (focused === null) {
      throw new Error('fixture keyboard press requires a focused element');
    }
    if (focused.getAttribute('role') !== 'slider') {
      throw new Error('fixture slider keys are only supported on a focused slider');
    }
    if (key === 'Home') {
      events.push('power-home');
      if (state.powerKeysApplies) {
        state.powerNow = state.powerMin;
      }
      return;
    }
    if (key === 'ArrowRight') {
      events.push('power-arrow-right');
      if (state.powerKeysApplies) {
        state.powerNow = Math.min(state.powerNow + 1, state.powerMax);
      }
      return;
    }
    if (key === 'End') {
      return;
    }
    throw new Error(`unsupported fixture slider key: ${key}`);
  };

  const authControls: StartDomNode[] = state.authenticated ? [] : [anchor('Log in', { href: '/auth/login' })];

  const projectCreateControl: StartDomNode = node('button', 'New project', {}, [], () => {
    events.push('project-create-click');
  });
  const projectOptionsControls: StartDomNode[] = state.projectLoadsRows
    ? Array.from({ length: state.projectRowCount }, () => {
        return node('button', 'Open project options for chatgpt-pro-collab', {}, [], () => {
          events.push('project-options-click');
        });
      })
    : [];

  const matchedRows: StartDomNode[] = state.projectLoadsRows
    ? Array.from({ length: state.projectRowCount }, (_unused, index) => {
        const row = node('div', '', { role: 'row' });
        const name = node('span', 'chatgpt-pro-collab', {}, [], () => {
          events.push('project-row-click');
          if (state.navigateOnProjectClick) {
            state.pathname = '/g/g-p-123/project';
          }
        });
        setChildren(row, [name, projectOptionsControls[index]]);
        return row;
      })
    : [];
  const otherRows: StartDomNode[] = state.projectLoadsRows
    ? Array.from({ length: state.otherRowCount }, () => {
        const row = node('div', '', { role: 'row' });
        setChildren(row, [node('span', 'other project', {})]);
        return row;
      })
    : [];

  const selectorControl: StartDomNode | null =
    state.selectorControlCount === 1
      ? node('button', 'Power 2 of 5', { 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, [], () => {
          events.push('selector-click');
          if (state.menuOpen) {
            closeMenu();
          } else {
            state.menuOpen = true;
            state.submenuOpen = false;
          }
        })
      : null;
  if (selectorControl !== null) {
    const readAttribute = selectorControl.getAttribute.bind(selectorControl);
    selectorControl.getAttribute = (name: string): string | null => {
      if (name === 'aria-expanded') {
        return state.menuOpen ? 'true' : 'false';
      }
      return readAttribute(name);
    };
  }

  const composerForm = node('form', '', {});
  setChildren(composerForm, [
    node('button', '', {
      'data-testid': 'composer-plus-btn',
      ...(state.plusMenuTrigger ? { 'aria-haspopup': 'menu' } : {}),
    }),
    node('textarea', '', { id: 'prompt-textarea' }),
    node('button', 'Send prompt', { 'data-testid': 'send-button' }),
    ...(selectorControl === null ? [] : [selectorControl]),
  ]);

  const titleNodes: StartDomNode[] = Array.from({ length: state.mainTitleCount }, () => {
    return node('h1', 'chatgpt-pro-collab', {});
  });
  const composerNodes: StartDomNode[] = Array.from({ length: state.composerCount }, () => {
    return composerForm;
  });
  const turnNodes: StartDomNode[] = state.existingTurns
    ? [node('div', 'hello', { 'data-testid': 'conversation-turn-user-1', 'data-turn': 'user' })]
    : [];
  const main = node('main', '', {});
  setChildren(main, [...titleNodes, ...composerNodes, ...turnNodes]);

  const modelItem = node(
    'div',
    `Model${state.currentModel}`,
    { 'role': 'menuitem', 'aria-haspopup': 'menu' },
    [],
    () => {
      events.push('opener-click');
      state.menuOpen = true;
      state.submenuOpen = true;
    },
    'first',
  );
  Object.defineProperty(modelItem, 'textContent', {
    configurable: true,
    get() {
      return `Model${state.currentModel}`;
    },
  });
  const modelOpeners: StartDomNode[] = Array.from({ length: state.modelOpenerCount }, () => {
    return modelItem;
  });
  const effortOpener = node('div', 'EffortPro', { 'role': 'menuitem', 'aria-haspopup': 'menu' }, [], () => {}, 'first');

  const powerSlider = node(
    'div',
    `Medium, ${state.powerNow} of ${state.powerMax}`,
    {
      'role': 'slider',
      'aria-valuemin': '0',
      'aria-valuenow': String(state.powerNow),
      'aria-valuemax': String(state.powerMax),
      'tabindex': '0',
    },
    [],
    () => {},
    'first',
  );
  Object.defineProperty(powerSlider, 'textContent', {
    configurable: true,
    get() {
      return `Medium, ${state.powerNow} of ${state.powerMax}`;
    },
  });
  const powerSliders: StartDomNode[] = state.powerSliderPresent ? [powerSlider] : [];
  const firstLayer = node('div', '', { role: 'menu' });
  setChildren(firstLayer, [...modelOpeners, effortOpener, ...powerSliders]);

  const modelRadios: StartDomNode[] = (['GPT-5.6 Sol', 'GPT-5.5', 'GPT-5.3', 'o3'] as const)
    .filter((model) => {
      return model !== 'GPT-5.6 Sol' || state.modelRadioPresent;
    })
    .map((model) => {
      return node(
        'div',
        model,
        { 'role': 'menuitemradio', 'aria-checked': 'false' },
        [],
        () => {
          if (model === 'GPT-5.6 Sol') {
            events.push('model-click');
            if (state.modelClickApplies) {
              state.currentModel = 'GPT-5.6 Sol';
            }
            if (state.modelClickResetsPower) {
              state.powerNow = 2;
            }
            closeMenu();
          }
        },
        'submenu',
      );
    });
  const submenu = node('div', '', { role: 'menu' });
  setChildren(submenu, modelRadios);

  const radioChecked = (element: StartDomNode): string => {
    if (element.textContent.trim() === state.currentModel) {
      return 'true';
    }
    return element.attributes['aria-checked'] ?? 'false';
  };
  for (const radio of modelRadios) {
    const readAttribute = radio.getAttribute.bind(radio);
    radio.getAttribute = (name: string): string | null => {
      if (name === 'aria-checked') {
        return radioChecked(radio);
      }
      return readAttribute(name);
    };
  }
  const sliderAttributes = (name: string): string | null => {
    if (name === 'aria-valuenow') {
      return String(state.powerNow);
    }
    if (name === 'aria-valuemax') {
      return String(state.powerMax);
    }
    return null;
  };
  for (const slider of powerSliders) {
    const readAttribute = slider.getAttribute.bind(slider);
    slider.getAttribute = (name: string): string | null => {
      return sliderAttributes(name) ?? readAttribute(name);
    };
    const readHasAttribute = slider.hasAttribute.bind(slider);
    slider.hasAttribute = (name: string): boolean => {
      return sliderAttributes(name) !== null || readHasAttribute(name);
    };
    const originalFocus = slider.focus.bind(slider);
    slider.focus = (): void => {
      state.focusedElement = slider;
      originalFocus();
    };
  }

  const rootChildren: StartDomNode[] = [
    ...authControls,
    projectCreateControl,
    ...matchedRows,
    ...otherRows,
    main,
    firstLayer,
    submenu,
  ];
  const allDocumentNodes = (): readonly StartDomNode[] => {
    return rootChildren.flatMap((element) => {
      return [element, ...descendants(element)];
    });
  };
  const documentRoot = {
    querySelector(selector: string) {
      return (
        allDocumentNodes().find((element) => {
          return matchesFixtureSelector(element, selector);
        }) ?? null
      );
    },
    querySelectorAll(selector: string) {
      return allDocumentNodes().filter((element) => {
        return matchesFixtureSelector(element, selector);
      });
    },
  };

  const sessionStorage = {
    storage: new Map<string, string>(),
    getItem(key: string) {
      return this.storage.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      this.storage.set(key, value);
    },
  };
  const globals = () => {
    return {
      document: documentRoot,
      getComputedStyle(_element: object) {
        return { display: 'block', visibility: 'visible' };
      },
      HTMLAnchorElement: StartAnchorElement,
      HTMLElement: StartHtmlElement,
      location: { hostname: 'chatgpt.com', pathname: state.pathname },
      sessionStorage,
    };
  };

  const matches = (selector: string): readonly StartDomNode[] => {
    return allDocumentNodes().filter((element) => {
      return matchesFixtureSelector(element, selector);
    });
  };
  const clickFirst = (nodes: readonly StartDomNode[], selector: string): void => {
    const target = nodes[0];
    if (target === undefined) {
      throw new Error(`fixture locator is absent: ${selector}`);
    }
    target.click();
  };

  const page = {
    evaluate(callback: unknown, argument?: unknown) {
      return Promise.resolve(withStartGlobals(globals(), callback, argument));
    },
    getByRole(role: string, options: { readonly name?: string; readonly exact?: boolean }) {
      const nodes = allDocumentNodes().filter((element) => {
        if (element.attributes['role'] !== role) {
          return false;
        }
        if (options.name === undefined) {
          return true;
        }
        const name = element.getAttribute('aria-label') ?? element.textContent.trim();
        return options.exact === true ? name === options.name : name.includes(options.name);
      });
      return {
        count() {
          return Promise.resolve(nodes.length);
        },
        first() {
          return {
            click() {
              clickFirst(nodes, `getByRole(${role}, ${options.name ?? ''})`);
              return Promise.resolve();
            },
          };
        },
      };
    },
    locator(selector: string) {
      return {
        count() {
          return Promise.resolve(matches(selector).length);
        },
        first() {
          return {
            click() {
              clickFirst(matches(selector), selector);
              return Promise.resolve();
            },
          };
        },
        focus() {
          const target = matches(selector)[0];
          if (target === undefined) {
            throw new Error(`fixture locator is absent: ${selector}`);
          }
          target.focus();
          return Promise.resolve();
        },
        press(key: string) {
          const target = matches(selector)[0];
          if (target === undefined) {
            throw new Error(`fixture locator is absent: ${selector}`);
          }
          target.focus();
          dispatchSliderKey(key);
          return Promise.resolve();
        },
      };
    },
    keyboard: {
      async press(key: string) {
        dispatchSliderKey(key);
      },
    },
    url() {
      return `https://chatgpt.com${state.pathname}`;
    },
    async waitForFunction(callback: unknown, argument?: unknown) {
      const startedAt = Date.now();
      while (true) {
        if (withStartGlobals(globals(), callback, argument) === true) {
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

  return { events, page };

  function descendants(element: StartDomNode): readonly StartDomNode[] {
    const direct = childrenByNode.get(element) ?? [];
    return [...direct, ...direct.flatMap(descendants)];
  }
}

/**
 * Matches one fixture node against one comma-separated selector group.
 *
 * @param element Candidate node.
 * @param selector Supported fixture selector group.
 * @returns True when the node matches.
 * @throws {Error} Unsupported selectors fail instead of being guessed.
 */
function matchesFixtureSelector(element: StartDomNode, selector: string): boolean {
  const alternatives = selector.split(',').map((part) => {
    return part.trim();
  });
  return alternatives.some((part) => {
    return matchesCompoundSelector(element, part);
  });
}

function matchesCompoundSelector(element: StartDomNode, selector: string): boolean {
  const parts = selector.trim().split(/\s+/u);
  const finalPart = parts.at(-1);
  if (finalPart === undefined || !matchesSingleSelector(element, finalPart)) {
    return false;
  }
  for (const part of parts.slice(0, -1)) {
    if (!hasAncestor(element, part)) {
      return false;
    }
  }
  return true;
}

function hasAncestor(element: StartDomNode, selector: string): boolean {
  let parent = element.parentNode();
  while (parent !== null) {
    if (matchesSingleSelector(parent, selector)) {
      return true;
    }
    parent = parent.parentNode();
  }
  return false;
}

function matchesSingleSelector(element: StartDomNode, selector: string): boolean {
  const notConditions: Array<{ readonly name: string; readonly value: string }> = [];
  let base = selector;
  while (true) {
    const match = /^(.*?):not\(\[([a-z-]+)="([^"]*)"\]\)$/u.exec(base);
    if (match === null) {
      break;
    }
    const name = match[2];
    const value = match[3];
    if (name === undefined || value === undefined) {
      throw new Error(`unsupported start fixture selector: ${selector}`);
    }
    notConditions.push({ name, value });
    base = match[1] ?? '';
  }
  let matchesBase: boolean;
  if (base === '*') {
    matchesBase = true;
  } else if (base === 'main') {
    matchesBase = element.tagName === 'main';
  } else if (base === 'form') {
    matchesBase = element.tagName === 'form';
  } else if (base === 'h1') {
    matchesBase = element.tagName === 'h1';
  } else if (base === 'button') {
    matchesBase = element.tagName === 'button';
  } else if (base === 'a') {
    matchesBase = element.tagName === 'a';
  } else if (base === '#prompt-textarea') {
    matchesBase = element.attributes['id'] === 'prompt-textarea';
  } else if (base === '[role="row"]') {
    matchesBase = element.attributes['role'] === 'row';
  } else if (base === '[role="menuitemradio"]') {
    matchesBase = element.attributes['role'] === 'menuitemradio';
  } else if (base === '[role="menuitem"]') {
    matchesBase = element.attributes['role'] === 'menuitem';
  } else if (base === '[role="option"]') {
    matchesBase = element.attributes['role'] === 'option';
  } else if (base === '[role="slider"]') {
    matchesBase = element.attributes['role'] === 'slider';
  } else if (base === '[role="menuitem"][aria-haspopup]') {
    matchesBase = element.attributes['role'] === 'menuitem' && 'aria-haspopup' in element.attributes;
  } else if (base === '[aria-haspopup]') {
    matchesBase = 'aria-haspopup' in element.attributes;
  } else if (base === 'button[aria-haspopup]') {
    matchesBase = element.tagName === 'button' && 'aria-haspopup' in element.attributes;
  } else if (base === 'button[aria-haspopup="menu"]') {
    matchesBase = element.tagName === 'button' && element.attributes['aria-haspopup'] === 'menu';
  } else if (base === '[data-testid^="conversation-turn-"][data-turn]') {
    matchesBase =
      (element.attributes['data-testid'] ?? '').startsWith('conversation-turn-') && 'data-turn' in element.attributes;
  } else {
    throw new Error(`unsupported start fixture selector: ${selector}`);
  }
  if (!matchesBase) {
    return false;
  }
  return notConditions.every((condition) => {
    return element.attributes[condition.name] !== condition.value;
  });
}

/**
 * Executes one generated start callback with the fixture browser globals installed.
 *
 * @param globals Browser globals installed for the callback duration.
 * @param callback Generated page callback.
 * @param argument Callback argument supplied by the page function.
 * @returns The callback result.
 * @throws {TypeError} If the callback is not callable.
 */
function withStartGlobals(
  globals: { readonly [name: string]: unknown },
  callback: unknown,
  argument: unknown,
): unknown {
  if (typeof callback !== 'function') {
    throw new TypeError('start fixture callback is not a function');
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
