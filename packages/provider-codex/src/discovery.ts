// Adapted from T3 Code CodexProvider.mapCodexModelCapabilities and model/list probe (MIT).
import { Schema } from "effect";
import type { ProviderModel, ProviderOption } from "@paws/contracts";
import { selectOption } from "@paws/provider-core";
import { withJsonRpc, type ProbeLaunch } from "@paws/provider-core/process";

const Model = Schema.Struct({
  model: Schema.String,
  displayName: Schema.String,
  hidden: Schema.optional(Schema.Boolean),
  supportedReasoningEfforts: Schema.Array(
    Schema.Struct({ reasoningEffort: Schema.String }),
  ),
  defaultReasoningEffort: Schema.String,
  serviceTiers: Schema.optional(
    Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  ),
  additionalSpeedTiers: Schema.optional(Schema.Array(Schema.String)),
  defaultServiceTier: Schema.optional(Schema.NullOr(Schema.String)),
});
const ModelPage = Schema.Struct({
  data: Schema.Array(Model),
  nextCursor: Schema.optional(Schema.NullOr(Schema.String)),
});
const Account = Schema.Struct({
  account: Schema.NullOr(
    Schema.Struct({
      type: Schema.String,
      email: Schema.optional(Schema.NullOr(Schema.String)),
      planType: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});

export function codexPlanLabel(
  planType: string | null | undefined,
): string | undefined {
  switch (planType) {
    case "free":
      return "ChatGPT Free Subscription";
    case "go":
      return "ChatGPT Go Subscription";
    case "plus":
      return "ChatGPT Plus Subscription";
    case "pro":
      return "ChatGPT Pro 200 Subscription";
    case "prolite":
      return "ChatGPT Pro 100 Subscription";
    case "promax":
      return "ChatGPT Pro 500 Subscription";
    case "self_serve_business_prolite":
      return "ChatGPT Business Premium Subscription";
    case "team":
    case "self_serve_business_usage_based":
    case "business":
      return "ChatGPT Business Subscription";
    case "ent26":
    case "enterprise_cbp_automation":
    case "enterprise_cbp_usage_based":
    case "enterprise":
      return "ChatGPT Enterprise Subscription";
    case "edu":
    case "edu_plus":
    case "edu_pro":
      return "ChatGPT Edu Subscription";
    case "unknown":
      return "ChatGPT Subscription";
    default:
      return undefined;
  }
}

export function codexModel(model: typeof Model.Type): ProviderModel {
  const options: ProviderOption[] = [];

  if (model.supportedReasoningEfforts.length) {
    options.push(
      selectOption(
        "reasoningEffort",
        "Reasoning",
        model.supportedReasoningEfforts.map((item) => item.reasoningEffort),
        model.defaultReasoningEffort,
      ),
    );
  }

  const tiers = model.serviceTiers?.length
    ? model.serviceTiers
    : (model.additionalSpeedTiers ?? []).map((id) => ({
        id,
        name: id === "fast" || id === "priority" ? "Fast" : id,
      }));

  if (tiers.length) {
    const choices = [
      { id: "default", label: "Standard" },
      ...tiers
        .filter((tier) => tier.id !== "default")
        .map((tier) => ({ id: tier.id, label: tier.name })),
    ];
    options.push({
      id: "serviceTier",
      label: "Service Tier",
      choices,
      defaultValue: choices.some(
        (choice) => choice.id === model.defaultServiceTier,
      )
        ? model.defaultServiceTier!
        : "default",
    });
  }

  return { id: model.model, name: model.displayName, options };
}

export async function discoverCodex(launch: ProbeLaunch) {
  return withJsonRpc(
    { ...launch, args: [...launch.args, "app-server", "--listen", "stdio://"] },
    async (rpc) => {
      await rpc.request("initialize", {
        clientInfo: { name: "paws", title: "Paws", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      rpc.notify("initialized");
      const account = Schema.decodeUnknownSync(Account)(
        await rpc.request("account/read", { refreshToken: false }),
      );

      if (!account.account)
        return { auth: "unauthenticated" as const, models: [] };

      const models: ProviderModel[] = [];
      const cursors = new Set<string>();
      let cursor: string | null = null;

      do {
        const page = Schema.decodeUnknownSync(ModelPage)(
          await rpc.request("model/list", {
            cursor,
            limit: 100,
            includeHidden: false,
          }),
        );
        models.push(
          ...page.data.filter((model) => !model.hidden).map(codexModel),
        );
        cursor = page.nextCursor ?? null;

        if (cursor && cursors.has(cursor))
          throw new Error("Provider repeated a model cursor.");
        if (cursor) cursors.add(cursor);
      } while (cursor && cursors.size < 20);

      return {
        auth: "authenticated" as const,
        account: {
          ...(account.account.email ? { email: account.account.email } : {}),
          label:
            account.account.type === "apiKey"
              ? "OpenAI API Key"
              : account.account.type === "amazonBedrock"
                ? "Amazon Bedrock"
                : codexPlanLabel(account.account.planType),
        },
        models,
      };
    },
  );
}
