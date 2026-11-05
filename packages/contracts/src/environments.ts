import { Schema } from "effect";

export const EnvironmentIdentity = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  platform: Schema.String.check(Schema.isMaxLength(40)),
});
export type EnvironmentIdentity = typeof EnvironmentIdentity.Type;

export const LinkedEnvironment = Schema.Struct({
  ...EnvironmentIdentity.fields,
  url: Schema.String,
  enabled: Schema.optional(Schema.Boolean),
});
export type LinkedEnvironment = typeof LinkedEnvironment.Type;

export const EnvironmentState = Schema.Struct({
  local: EnvironmentIdentity,
  sharing: Schema.Boolean,
  port: Schema.Number,
  addresses: Schema.Array(Schema.String),
  linked: Schema.Array(LinkedEnvironment),
  connections: Schema.Array(EnvironmentIdentity),
  discoveryError: Schema.NullOr(Schema.String),
});
export type EnvironmentState = typeof EnvironmentState.Type;

export const DiscoveredEnvironment = Schema.Struct({
  ...LinkedEnvironment.fields,
  source: Schema.Literals(["lan", "tailscale"]),
});
export type DiscoveredEnvironment = typeof DiscoveredEnvironment.Type;

export const EnvironmentDiscovery = Schema.Struct({
  environments: Schema.Array(DiscoveredEnvironment),
  warnings: Schema.Array(Schema.String),
});

export const PairEnvironment = Schema.Struct({
  url: Schema.String,
  code: Schema.String,
  expectedId: Schema.optional(Schema.String),
});

export const PairingCode = Schema.Struct({
  code: Schema.String,
  expiresAt: Schema.String,
});
export type PairEnvironment = typeof PairEnvironment.Type;
