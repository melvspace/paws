import { Schema } from "effect";

export const browserHomeUrl = "https://www.google.com/";

const shortText = Schema.String.check(Schema.isMaxLength(4096));
const coordinate = Schema.Number.check(
  Schema.isFinite(),
  Schema.isBetween({ minimum: 0, maximum: 4096 }),
);
const generation = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const BrowserAction = Schema.Struct({
  action: Schema.Literals([
    "list",
    "open",
    "navigate",
    "snapshot",
    "screenshot",
    "click",
    "fill",
    "press",
    "scroll",
    "back",
    "forward",
    "reload",
    "close",
    "dialog",
  ]),
  tabId: Schema.optional(shortText),
  url: Schema.optional(shortText),
  selector: Schema.optional(shortText),
  text: Schema.optional(Schema.String.check(Schema.isMaxLength(16000))),
  key: Schema.optional(shortText),
  x: Schema.optional(coordinate),
  y: Schema.optional(coordinate),
  deltaY: Schema.optional(
    Schema.Number.check(
      Schema.isFinite(),
      Schema.isBetween({ minimum: -4096, maximum: 4096 }),
    ),
  ),
  accept: Schema.optional(Schema.Boolean),
});
export type BrowserAction = typeof BrowserAction.Type;

export const BrowserTab = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  title: Schema.String,
  loading: Schema.Boolean,
  owner: Schema.Literals(["agent", "human"]),
  generation,
  viewport: Schema.optional(
    Schema.Struct({ width: Schema.Number, height: Schema.Number }),
  ),
  dialog: Schema.NullOr(
    Schema.Struct({ type: Schema.String, message: Schema.String }),
  ),
});
export type BrowserTab = typeof BrowserTab.Type;

export const BrowserState = Schema.Struct({
  type: Schema.Literal("state"),
  tabs: Schema.Array(BrowserTab),
  selectedTabId: Schema.NullOr(Schema.String),
  controllerTabId: Schema.NullOr(Schema.String),
  width: Schema.Number,
  height: Schema.Number,
});
export type BrowserState = typeof BrowserState.Type;

export const BrowserClientMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("resize"),
    tabId: shortText,
    generation,
    width: Schema.Int.check(Schema.isBetween({ minimum: 160, maximum: 4096 })),
    height: Schema.Int.check(Schema.isBetween({ minimum: 160, maximum: 4096 })),
  }),
  Schema.Struct({
    type: Schema.Literal("resetInput"),
    tabId: shortText,
    generation,
  }),
  Schema.Struct({
    type: Schema.Literal("watch"),
    tabId: Schema.NullOr(shortText),
  }),
  Schema.Struct({ type: Schema.Literal("takeControl"), tabId: shortText }),
  Schema.Struct({ type: Schema.Literal("releaseControl"), tabId: shortText }),
  Schema.Struct({
    type: Schema.Literal("action"),
    generation,
    input: BrowserAction,
  }),
  Schema.Struct({
    type: Schema.Literal("pointer"),
    tabId: shortText,
    generation,
    x: coordinate,
    y: coordinate,
    phase: Schema.Literals(["down", "up", "move"]),
    button: Schema.Literals(["left", "right", "middle"]),
    clickCount: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 })),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("key"),
    tabId: shortText,
    generation,
    key: shortText,
    phase: Schema.Literals(["down", "up"]),
  }),
  Schema.Struct({
    type: Schema.Literal("text"),
    tabId: shortText,
    generation,
    text: Schema.String.check(Schema.isMaxLength(16000)),
  }),
  Schema.Struct({
    type: Schema.Literal("wheel"),
    tabId: shortText,
    generation,
    x: coordinate,
    y: coordinate,
    deltaX: Schema.Number.check(
      Schema.isFinite(),
      Schema.isBetween({ minimum: -4096, maximum: 4096 }),
    ),
    deltaY: Schema.Number.check(
      Schema.isFinite(),
      Schema.isBetween({ minimum: -4096, maximum: 4096 }),
    ),
  }),
]);
export type BrowserClientMessage = typeof BrowserClientMessage.Type;

export const BrowserServerMessage = Schema.Union([
  BrowserState,
  Schema.Struct({
    type: Schema.Literal("status"),
    message: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("frame"),
    tabId: Schema.String,
    data: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
]);
export type BrowserServerMessage = typeof BrowserServerMessage.Type;
