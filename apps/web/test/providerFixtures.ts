import type { ProviderSnapshot } from "@paws/contracts";
import { selectOption } from "@paws/provider-core";
import { availableModels } from "../src/workspace/models.ts";

export const codexFixture: ProviderSnapshot = {
  config: {
    id: "codex",
    driver: "codex",
    name: "Codex",
    enabled: true,
    binaryPath: "",
    args: [],
  },
  status: "ready",
  auth: "authenticated",
  version: "1.0.0",
  message: null,
  checkedAt: null,
  models: [
    { id: "gpt-6.1-sol", name: "GPT-6.1-Sol", options: [] },
    {
      id: "gpt-6-astra",
      name: "GPT-6-Astra",
      options: [
        selectOption(
          "reasoningEffort",
          "Reasoning",
          ["low", "medium", "high", "xhigh", "max", "ultra"],
          "medium",
        ),
        {
          id: "serviceTier",
          label: "Service Tier",
          choices: [
            { id: "default", label: "Standard" },
            { id: "fast", label: "Fast" },
          ],
          defaultValue: "default",
        },
      ],
    },
  ],
};
export const modelFixtures = availableModels([codexFixture]);
