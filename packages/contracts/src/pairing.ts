import { Schema } from "effect";
import { EnvironmentIdentity, PairingRequest } from "./environments.ts";

export const PairingOffer = Schema.Struct({
  protocol: Schema.Literal("paws-pair-v1"),
  identity: EnvironmentIdentity,
  addresses: Schema.Array(Schema.String).check(Schema.isMaxLength(16)),
  code: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  expiresAt: Schema.String,
});
export type PairingOffer = typeof PairingOffer.Type;

export const PairingTicket = Schema.Struct({
  ...PairingRequest.fields,
  secret: Schema.String,
});
export type PairingTicket = typeof PairingTicket.Type;
export const PairedEnvironment = Schema.Struct({
  identity: EnvironmentIdentity,
  token: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)),
});
export const PairingClaim = Schema.Union([
  Schema.Struct({ status: Schema.Literals(["pending", "denied"]) }),
  Schema.Struct({
    status: Schema.Literal("approved"),
    ...PairedEnvironment.fields,
  }),
]);
