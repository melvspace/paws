import { randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";
import type { BrowserContext, CDPSession, Dialog, Page } from "playwright";
import {
  BrowserAction,
  BrowserClientMessage,
  browserHomeUrl,
  type BrowserServerMessage,
  type BrowserState,
} from "@paws/contracts";
import { ChatToolError, type BrowserToolResult } from "@paws/provider-core";
import { launchAgentBrowser } from "./browserRuntime.ts";

const viewport = { width: 1280, height: 800 };
const screencast = {
  format: "jpeg",
  quality: 75,
  maxWidth: 4096,
  maxHeight: 4096,
  everyNthFrame: 1,
} as const;
const textResult = (value: unknown): BrowserToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});

export function browserUrl(value: string) {
  const url = new URL(value);

  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new ChatToolError("Use an http or https URL without credentials.");

  return url.href;
}

interface Viewer {
  id: string;
  tabId: string | null;
  viewport: { width: number; height: number } | null;
  send(message: BrowserServerMessage): void;
  disconnect(): void;
}
interface Tab {
  id: string;
  page: Page;
  viewport: { width: number; height: number };
  homePending: boolean;
  owner: string | null;
  generation: number;
  title: string;
  loading: boolean;
  dialog: Dialog | null;
  stream: CDPSession | null;
  frame: string | null;
  keys: Set<string>;
  buttons: Set<"left" | "right" | "middle">;
}
interface Session {
  agentId: string;
  closed: boolean;
  context: BrowserContext;
  close(): Promise<void>;
  tabs: Map<string, Tab>;
  viewers: Set<Viewer>;
  queue: Promise<unknown>;
}

// One service owns profiles, page queues and control leases across all providers.
export function makeBrowserService(
  root: string,
  launch = launchAgentBrowser,
  available: (agentId: string) => boolean = () => true,
) {
  const sessions = new Map<string, Promise<Session>>();
  const closing = new Set<string>();
  const observers = new Map<string, Set<(state: BrowserState) => void>>();
  let stopped = false;

  function enqueue<T>(session: Session, operation: () => Promise<T>) {
    const next = session.queue.then(() => {
      if (session.closed) throw new ChatToolError("Browser is closed.");

      return operation();
    });
    session.queue = next.catch(() => {});

    return next;
  }

  function state(session: Session, viewer?: Viewer): BrowserState {
    return {
      type: "state",
      tabs: [...session.tabs.values()].map((tab) => ({
        id: tab.id,
        url: tab.page.url(),
        title: tab.title,
        loading: tab.loading,
        owner: tab.owner ? "human" : "agent",
        generation: tab.generation,
        viewport: tab.viewport,
        dialog: tab.dialog
          ? { type: tab.dialog.type(), message: tab.dialog.message() }
          : null,
      })),
      selectedTabId: viewer?.tabId ?? null,
      controllerTabId:
        [...session.tabs.values()].find(
          (tab) => tab.id === viewer?.tabId && tab.owner === viewer.id,
        )?.id ?? null,
      ...(session.tabs.get(viewer?.tabId ?? "")?.viewport ?? viewport),
    };
  }

  function publish(session: Session) {
    for (const receive of observers.get(session.agentId) ?? [])
      receive(state(session));

    for (const viewer of session.viewers) viewer.send(state(session, viewer));
  }

  async function resetInput(tab: Tab) {
    if (tab.dialog) return;

    const keys = [...tab.keys];
    const buttons = [...tab.buttons];
    let interrupted = false;
    await untilDialog(
      tab,
      async () => {
        for (const key of keys) {
          if (interrupted || tab.dialog) return;

          tab.keys.delete(key);
          await tab.page.keyboard.up(key).catch(() => {});
        }

        for (const button of buttons) {
          if (interrupted || tab.dialog) return;

          // Releasing on the original target would complete an abandoned click.
          await tab.page.mouse.move(-1, -1).catch(() => {});

          if (interrupted || tab.dialog) return;

          tab.buttons.delete(button);
          await tab.page.mouse.up({ button }).catch(() => {});
        }
      },
      () => {
        interrupted = true;
      },
    );
  }

  async function untilDialog<T>(
    tab: Tab,
    operation: () => Promise<T>,
    interrupted: () => T,
  ) {
    let reportDialog = () => {};
    const dialog = new Promise<T>((resolve) => {
      reportDialog = () => resolve(interrupted());
    });
    tab.page.on("dialog", reportDialog);

    try {
      return await Promise.race([operation(), dialog]);
    } finally {
      tab.page.off("dialog", reportDialog);
    }
  }

  async function fitViewport(session: Session, tab: Tab) {
    if (tab.dialog) return;

    const viewer = [...session.viewers].find(
      (item) => item.tabId === tab.id && (!tab.owner || item.id === tab.owner),
    );
    const size = viewer?.viewport;

    if (
      !size ||
      (size.width === tab.viewport.width && size.height === tab.viewport.height)
    )
      return;

    await tab.page.setViewportSize(size);
    tab.viewport = size;
    tab.frame = null;

    if (tab.stream) {
      await tab.stream.send("Page.stopScreencast");
      await tab.stream.send("Page.startScreencast", screencast);
    }
  }

  async function stream(session: Session, tab: Tab) {
    if (session.closed || tab.page.isClosed() || tab.dialog) return;

    const watched = [...session.viewers].some(
      (viewer) => viewer.tabId === tab.id,
    );

    if (!watched && tab.stream) {
      const cdp = tab.stream;
      tab.stream = null;
      tab.frame = null;
      await cdp.detach().catch(() => {});
    } else if (watched && !tab.stream && !tab.page.isClosed()) {
      const cdp = await session.context.newCDPSession(tab.page);
      tab.stream = cdp;
      cdp.on("Page.screencastFrame", (frame) => {
        tab.frame = frame.data;

        for (const viewer of session.viewers) {
          if (viewer.tabId === tab.id)
            viewer.send({ type: "frame", tabId: tab.id, data: frame.data });
        }

        void cdp
          .send("Page.screencastFrameAck", { sessionId: frame.sessionId })
          .catch(() => {});
      });
      await cdp.send("Page.startScreencast", screencast);
    }
  }

  async function adopt(session: Session, page: Page) {
    const existing = [...session.tabs.values()].find(
      (tab) => tab.page === page,
    );

    if (existing) return existing;

    const opener = await page.opener();
    const adopted = [...session.tabs.values()].find((tab) => tab.page === page);

    if (adopted) return adopted;

    if (session.tabs.size >= 12) {
      await page.close();

      throw new ChatToolError(
        "Close an existing tab before opening another (12-tab limit).",
      );
    }

    const parent = [...session.tabs.values()].find(
      (tab) => tab.page === opener,
    );
    const tab: Tab = {
      id: randomUUID(),
      page,
      viewport: { ...viewport },
      homePending: false,
      owner: parent?.owner ?? null,
      generation: 0,
      title: "",
      loading: false,
      dialog: null,
      stream: null,
      frame: null,
      keys: new Set(),
      buttons: new Set(),
    };
    session.tabs.set(tab.id, tab);
    page.setDefaultTimeout(3000);
    page.setDefaultNavigationTimeout(15000);
    await page.setViewportSize(viewport);
    page.on("dialog", (dialog) => {
      tab.dialog = dialog;
      publish(session);
    });
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;

      tab.homePending = false;
      tab.loading = true;
      publish(session);
    });
    page.on("requestfailed", (request) => {
      if (
        request.isNavigationRequest() &&
        request.frame() === page.mainFrame()
      ) {
        tab.loading = false;
        publish(session);
      }
    });
    page.on("crash", () => {
      for (const viewer of session.viewers) {
        if (viewer.tabId === tab.id)
          viewer.send({
            type: "error",
            message: "This browser tab crashed. Open a new tab to continue.",
          });
      }

      void page.close().catch(() => {});
    });
    page.on("domcontentloaded", () => {
      tab.loading = false;
      void page
        .title()
        .then((title) => {
          tab.title = title;
          publish(session);
        })
        .catch(() => {});
    });
    page.on("close", () => {
      session.tabs.delete(tab.id);
      tab.stream = null;

      for (const viewer of session.viewers) {
        if (viewer.tabId === tab.id)
          viewer.tabId = session.tabs.keys().next().value ?? null;
      }

      publish(session);
      void enqueue(session, async () => {
        for (const item of session.tabs.values()) await stream(session, item);
      }).catch(() => {});
    });
    publish(session);

    return tab;
  }

  async function sessionFor(agentId: string) {
    if (stopped || closing.has(agentId) || !available(agentId))
      throw new ChatToolError("Browser is closing. Retry shortly.");

    let pending = sessions.get(agentId);

    if (!pending) {
      pending = launch(root, agentId).then(async (runtime) => {
        let cleanup: Promise<void> | undefined;
        const session: Session = {
          ...runtime,
          agentId,
          closed: false,
          close() {
            cleanup ??= runtime.close();

            return cleanup;
          },
          tabs: new Map(),
          viewers: new Set(),
          queue: Promise.resolve(),
        };

        try {
          for (const page of session.context.pages()) {
            const tab = await adopt(session, page);
            tab.homePending = page.url() === "about:blank";
          }

          session.context.on("page", (page) => {
            void adopt(session, page).catch(() => page.close().catch(() => {}));
          });
          session.context.on("close", () => {
            if (sessions.get(agentId) === pending) {
              sessions.delete(agentId);
              publishEmpty(agentId);
            }

            for (const viewer of session.viewers) viewer.disconnect();

            void session.close().catch(() => {});
          });

          return session;
        } catch (error) {
          await runtime.close();

          throw error;
        }
      });
      sessions.set(agentId, pending);
      void pending.catch(() => {
        if (sessions.get(agentId) === pending) {
          sessions.delete(agentId);
          publishEmpty(agentId);
        }
      });
    }

    return pending;
  }

  function getTab(session: Session, id?: string) {
    const tab = id ? session.tabs.get(id) : undefined;

    if (!tab)
      throw new ChatToolError(
        "Browser tab not found. List tabs and use a current tabId.",
      );

    return tab;
  }

  function authorize(tab: Tab, viewer?: Viewer, generation?: number) {
    if (
      viewer
        ? tab.owner !== viewer.id || tab.generation !== generation
        : tab.owner !== null ||
          (generation !== undefined && tab.generation !== generation)
    )
      throw new ChatToolError(
        viewer
          ? "Control changed. Take control again before interacting."
          : "The user has control of this tab. Ask them to return control, then end your turn.",
      );
  }

  async function action(
    session: Session,
    input: BrowserAction,
    viewer?: Viewer,
    generation?: number,
  ): Promise<BrowserToolResult> {
    if (input.action === "list") return textResult(state(session, viewer));

    if (input.action === "open") {
      if (session.tabs.size >= 12)
        throw new ChatToolError(
          "Close an existing tab before opening another (12-tab limit).",
        );

      const url = browserUrl(input.url ?? browserHomeUrl);
      const tab = await adopt(session, await session.context.newPage());
      tab.owner = viewer?.id ?? null;

      if (viewer) {
        viewer.tabId = tab.id;
        await fitViewport(session, tab);
        await stream(session, tab);
      }

      publish(session);

      await untilDialog(
        tab,
        () => tab.page.goto(url, { waitUntil: "domcontentloaded" }),
        () => null,
      );

      return textResult({ tabId: tab.id, ...state(session, viewer) });
    }

    const tab = getTab(session, input.tabId);
    authorize(tab, viewer, generation);
    const page = tab.page;

    if (tab.dialog && !["dialog", "close"].includes(input.action))
      return textResult({
        tabId: tab.id,
        dialog: { type: tab.dialog.type(), message: tab.dialog.message() },
      });

    if (input.action === "snapshot")
      return textResult({
        tabId: tab.id,
        url: page.url(),
        viewport: tab.viewport,
        tree: (
          await page.locator("body").ariaSnapshot({ timeout: 3000 })
        ).slice(0, 24000),
      });
    if (input.action === "screenshot")
      return {
        content: [
          {
            type: "image",
            mimeType: "image/png",
            data: (await page.screenshot({ timeout: 5000 })).toString("base64"),
          },
        ],
      };
    if (input.action === "navigate") {
      if (!input.url) throw new ChatToolError("navigate requires url.");

      await page.goto(browserUrl(input.url), { waitUntil: "domcontentloaded" });
    } else if (input.action === "click") {
      if (input.selector) await page.locator(input.selector).hover();
      else if (input.x !== undefined && input.y !== undefined)
        await page.mouse.move(input.x, input.y);
      else throw new ChatToolError("click requires selector or x and y.");

      // A hover can open a dialog. Recheck the lease before each input step
      // instead of letting Playwright's composite click resume after takeover.
      authorize(tab, viewer, generation);
      tab.buttons.add("left");
      await page.mouse.down();
      authorize(tab, viewer, generation);
      tab.buttons.delete("left");
      await page.mouse.up();
    } else if (input.action === "fill") {
      if (!input.selector || input.text === undefined)
        throw new ChatToolError("fill requires selector and text.");

      const locator = page
        .locator(input.selector)
        .and(page.locator(":not(:disabled):not([readonly])"));
      await locator.selectText();
      authorize(tab, viewer, generation);
      const type = await locator.evaluate((element) => {
        if (element instanceof HTMLInputElement) return element.type;

        if (
          element instanceof HTMLTextAreaElement ||
          (element instanceof HTMLElement && element.isContentEditable)
        )
          return "text";

        throw new Error("Target is not editable.");
      });
      authorize(tab, viewer, generation);

      if (
        ["date", "time", "datetime-local", "month", "range", "week"].includes(
          type,
        )
      ) {
        // These native controls use a value assignment rather than text input.
        await locator.evaluate((element, text) => {
          if (!(element instanceof HTMLInputElement)) return;

          element.value = text.trim();

          if (element.value !== text.trim())
            throw new Error("Invalid input value.");

          element.dispatchEvent(
            new Event("input", { bubbles: true, composed: true }),
          );
          element.dispatchEvent(new Event("change", { bubbles: true }));
        }, input.text);
      } else {
        if (
          ![
            "text",
            "email",
            "number",
            "password",
            "search",
            "tel",
            "url",
          ].includes(type)
        )
          throw new ChatToolError("This input type cannot be filled.");
        if (
          type === "number" &&
          input.text &&
          !Number.isFinite(Number(input.text))
        )
          throw new ChatToolError("Use a numeric value for this input.");

        if (input.text) await page.keyboard.insertText(input.text);
        else {
          tab.keys.add("Delete");
          await page.keyboard.down("Delete");
          authorize(tab, viewer, generation);
          tab.keys.delete("Delete");
          await page.keyboard.up("Delete");
        }
      }
    } else if (input.action === "press") {
      if (!input.key) throw new ChatToolError("press requires key.");

      const keys = input.key.split(/\+(?!$)/);

      for (const key of keys) {
        authorize(tab, viewer, generation);
        tab.keys.add(key);
        await page.keyboard.down(key);
      }

      for (const key of keys.toReversed()) {
        authorize(tab, viewer, generation);
        tab.keys.delete(key);
        await page.keyboard.up(key);
      }
    } else if (input.action === "scroll")
      await page.mouse.wheel(0, input.deltaY ?? 600);
    else if (input.action === "back")
      await page.goBack({ waitUntil: "domcontentloaded" });
    else if (input.action === "forward")
      await page.goForward({ waitUntil: "domcontentloaded" });
    else if (input.action === "reload")
      await page.reload({ waitUntil: "domcontentloaded" });
    else if (input.action === "close")
      await page.close({ runBeforeUnload: false });
    else if (input.action === "dialog") {
      if (!tab.dialog) throw new ChatToolError("There is no open page dialog.");

      const dialog = tab.dialog;
      tab.dialog = null;

      if (input.accept) await dialog.accept(input.text);
      else await dialog.dismiss();

      await resetInput(tab);
      await fitViewport(session, tab);
      await stream(session, tab);
    }

    publish(session);

    return textResult(state(session, viewer));
  }

  const tool = Effect.fn("BrowserService.tool")(
    (agentId: string, value: unknown, signal: AbortSignal) =>
      Effect.tryPromise(async () => {
        try {
          const input = Schema.decodeUnknownSync(BrowserAction, {
            onExcessProperty: "error",
          })(value);
          signal.throwIfAborted();
          const session = await sessionFor(agentId);
          const generation = input.tabId
            ? getTab(session, input.tabId).generation
            : undefined;

          // Dialogs unblock in-flight input, so they cannot wait behind it.
          if (input.action === "dialog")
            return await action(session, input, undefined, generation);

          return await enqueue(session, async () => {
            signal.throwIfAborted();

            const tab = input.tabId ? getTab(session, input.tabId) : undefined;

            if (!tab) return action(session, input, undefined, generation);

            // Return the dialog to sequential tool callers while CDP input waits.
            return untilDialog(
              tab,
              () => action(session, input, undefined, generation),
              () => textResult(state(session)),
            );
          });
        } catch (error) {
          return {
            ...textResult({
              error:
                error instanceof ChatToolError
                  ? error.message
                  : "Browser operation failed. Inspect the current page and check the target before retrying.",
            }),
            isError: true,
          };
        }
      }),
  );

  async function attach(
    agentId: string,
    send: Viewer["send"],
    disconnect: Viewer["disconnect"],
  ) {
    const session = await sessionFor(agentId);
    const viewer: Viewer = {
      id: randomUUID(),
      tabId: session.tabs.keys().next().value ?? null,
      viewport: null,
      send,
      disconnect,
    };
    session.viewers.add(viewer);
    let detached = false;
    send(state(session, viewer));
    try {
      await enqueue(session, async () => {
        for (const tab of session.tabs.values()) await stream(session, tab);

        const selected = viewer.tabId
          ? session.tabs.get(viewer.tabId)
          : undefined;

        if (selected?.frame)
          send({ type: "frame", tabId: selected.id, data: selected.frame });

        if (selected?.homePending) {
          selected.homePending = false;
          void enqueue(session, async () => {
            if (selected.page.url() !== "about:blank") return;

            await selected.page.goto(browserHomeUrl, {
              waitUntil: "domcontentloaded",
            });
          }).catch(() => {
            if (!session.closed && session.viewers.has(viewer))
              send({
                type: "error",
                message:
                  "Could not load Google. Enter an address or reload to try again.",
              });
          });
        }
      });
    } catch (error) {
      session.viewers.delete(viewer);

      throw error;
    }

    return {
      async input(value: unknown) {
        const message = Schema.decodeUnknownSync(BrowserClientMessage, {
          onExcessProperty: "error",
        })(value);

        if (detached) return;

        // A page dialog can block the queued input that opened it.
        if (message.type === "action" && message.input.action === "dialog") {
          await action(session, message.input, viewer, message.generation);

          return;
        }

        // Revoke pending agent and stale viewer work before waiting for in-flight work.
        if (
          message.type === "takeControl" ||
          message.type === "releaseControl"
        ) {
          const tab = getTab(session, message.tabId);

          if (message.type === "releaseControl" && tab.owner !== viewer.id)
            throw new ChatToolError(
              "Only the current controller can return control.",
            );

          tab.owner = message.type === "takeControl" ? viewer.id : null;
          tab.generation++;
        }

        await enqueue(session, async () => {
          if (detached) return;

          if (message.type === "resize") {
            const tab = getTab(session, message.tabId);

            if (
              viewer.tabId !== tab.id ||
              tab.generation !== message.generation
            )
              return;

            viewer.viewport = { width: message.width, height: message.height };
            await fitViewport(session, tab);
          } else if (message.type === "watch") {
            if (message.tabId) getTab(session, message.tabId);

            const previous = viewer.tabId
              ? session.tabs.get(viewer.tabId)
              : undefined;

            if (previous?.owner === viewer.id) await resetInput(previous);

            viewer.tabId = message.tabId;

            for (const tab of session.tabs.values()) {
              await fitViewport(session, tab);
              await stream(session, tab);
            }

            const tab = message.tabId ? getTab(session, message.tabId) : null;

            if (tab?.frame)
              send({ type: "frame", tabId: tab.id, data: tab.frame });
          } else if (
            message.type === "takeControl" ||
            message.type === "releaseControl"
          ) {
            const tab = getTab(session, message.tabId);
            await resetInput(tab);
            await fitViewport(session, tab);
          } else if (message.type === "action") {
            const perform = () =>
              action(session, message.input, viewer, message.generation);

            if (message.input.tabId)
              await untilDialog(
                getTab(session, message.input.tabId),
                perform,
                () => textResult(state(session, viewer)),
              );
            else await perform();
          } else {
            const tab = getTab(session, message.tabId);
            authorize(tab, viewer, message.generation);
            const page = tab.page;

            if (tab.dialog) return;

            await untilDialog(
              tab,
              async () => {
                if (message.type === "resetInput") await resetInput(tab);
                else if (message.type === "pointer") {
                  await page.mouse.move(message.x, message.y);
                  authorize(tab, viewer, message.generation);

                  if (tab.dialog) return;

                  if (message.phase === "down") {
                    tab.buttons.add(message.button);
                    await page.mouse.down({
                      button: message.button,
                      clickCount: message.clickCount ?? 1,
                    });
                  } else if (message.phase === "up") {
                    tab.buttons.delete(message.button);
                    await page.mouse.up({
                      button: message.button,
                      clickCount: message.clickCount ?? 1,
                    });
                  }
                } else if (message.type === "key") {
                  const printableUnicode =
                    [...message.key].length === 1 &&
                    (message.key.codePointAt(0) ?? 0) > 127;

                  if (printableUnicode) {
                    if (message.phase === "down")
                      await page.keyboard.insertText(message.key);
                  } else if (message.phase === "down") {
                    tab.keys.add(message.key);
                    await page.keyboard.down(message.key);
                  } else {
                    tab.keys.delete(message.key);
                    await page.keyboard.up(message.key);
                  }
                } else if (message.type === "text")
                  await page.keyboard.insertText(message.text);
                else if (message.type === "wheel") {
                  await page.mouse.move(message.x, message.y);
                  authorize(tab, viewer, message.generation);

                  if (tab.dialog) return;

                  await page.mouse.wheel(message.deltaX, message.deltaY);
                }
              },
              () => {},
            );
          }

          publish(session);
        });
      },
      async detach() {
        if (detached) return;

        detached = true;
        session.viewers.delete(viewer);

        if (session.closed) return;

        for (const tab of session.tabs.values()) {
          if (tab.owner === viewer.id) {
            tab.owner = null;
            tab.generation++;
          }
        }

        await enqueue(session, async () => {
          for (const tab of session.tabs.values()) {
            if (!tab.owner) await resetInput(tab);

            await fitViewport(session, tab);
            await stream(session, tab);
          }

          publish(session);
        });
      },
    };
  }

  function publishEmpty(agentId: string) {
    for (const receive of observers.get(agentId) ?? [])
      receive({
        type: "state",
        tabs: [],
        selectedTabId: null,
        controllerTabId: null,
        ...viewport,
      });
  }

  async function observe(
    agentId: string,
    receive: (state: BrowserState) => void,
  ) {
    let listeners = observers.get(agentId);

    if (!listeners) {
      listeners = new Set();
      observers.set(agentId, listeners);
    }

    listeners.add(receive);
    const session = await sessions.get(agentId)?.catch(() => undefined);

    if (session && !session.closed) receive(state(session));
    else publishEmpty(agentId);

    return {
      input: async (_input: unknown) => {},
      async detach() {
        listeners.delete(receive);

        if (listeners.size === 0 && observers.get(agentId) === listeners)
          observers.delete(agentId);
      },
    };
  }

  async function closeAgent(agentId: string) {
    closing.add(agentId);
    const pending = sessions.get(agentId);
    sessions.delete(agentId);
    publishEmpty(agentId);

    try {
      const session = await pending?.catch(() => undefined);

      if (!session) return;

      session.closed = true;

      for (const viewer of session.viewers) viewer.disconnect();

      session.viewers.clear();
      await session.close();
      await session.queue.catch(() => {});
    } finally {
      closing.delete(agentId);
    }
  }

  return {
    tool: (agentId: string, input: unknown, signal: AbortSignal) =>
      Effect.runPromise(tool(agentId, input, signal)),
    attach,
    observe,
    closeAgent,
    async close() {
      stopped = true;
      await Promise.all([...sessions.keys()].map(closeAgent));
    },
  };
}
