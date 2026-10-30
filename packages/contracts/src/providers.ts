import { Schema } from "effect";

export const ProviderDriver = Schema.Literals([
  "codex",
  "claudeAgent",
  "cursor",
  "grok",
  "fx",
  "opencode",
  "antigravity",
  "muse",
  "pi",
  "acpRegistry",
]);
export type ProviderDriver = typeof ProviderDriver.Type;

export const ProviderChoice = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
});
export const ProviderOption = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  choices: Schema.Array(ProviderChoice),
  defaultValue: Schema.String,
});
export type ProviderOption = typeof ProviderOption.Type;

export const ProviderModel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  options: Schema.Array(ProviderOption),
});
export type ProviderModel = typeof ProviderModel.Type;

export const ProviderConfig = Schema.Struct({
  id: Schema.String,
  driver: ProviderDriver,
  name: Schema.String,
  enabled: Schema.Boolean,
  binaryPath: Schema.String,
  homePath: Schema.optional(Schema.String),
  args: Schema.Array(Schema.String),
});
export type ProviderConfig = typeof ProviderConfig.Type;
export const CreateProvider = Schema.Struct({ driver: ProviderDriver });
export const UpdateProvider = Schema.Struct({
  name: Schema.String,
  enabled: Schema.Boolean,
  binaryPath: Schema.String,
  homePath: Schema.optional(Schema.String),
  args: Schema.Array(Schema.String),
});
export type UpdateProvider = typeof UpdateProvider.Type;

export const ProviderSnapshot = Schema.Struct({
  config: ProviderConfig,
  status: Schema.Literals([
    "unchecked",
    "checking",
    "ready",
    "needs-auth",
    "missing",
    "error",
    "disabled",
  ]),
  auth: Schema.Literals(["authenticated", "unauthenticated", "unknown"]),
  account: Schema.optional(
    Schema.Struct({
      email: Schema.optional(Schema.String),
      label: Schema.optional(Schema.String),
    }),
  ),
  version: Schema.NullOr(Schema.String),
  message: Schema.NullOr(Schema.String),
  checkedAt: Schema.NullOr(Schema.String),
  models: Schema.Array(ProviderModel),
  environment: Schema.optional(Schema.Array(Schema.String)),
  signIn: Schema.optional(
    Schema.Struct({
      phase: Schema.Literals(["starting", "waiting", "error"]),
      url: Schema.NullOr(Schema.String),
      code: Schema.NullOr(Schema.String),
    }),
  ),
});
export type ProviderSnapshot = typeof ProviderSnapshot.Type;
export const ProvidersSnapshot = Schema.Struct({
  providers: Schema.Array(ProviderSnapshot),
});
export type ProvidersSnapshot = typeof ProvidersSnapshot.Type;

export const UpdateProviderEnvironment = Schema.Struct({
  name: Schema.String,
  value: Schema.NullOr(Schema.String),
});
export type UpdateProviderEnvironment = typeof UpdateProviderEnvironment.Type;
