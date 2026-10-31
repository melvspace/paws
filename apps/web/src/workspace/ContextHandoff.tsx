import { ArrowRightIcon, ArrowRightLeftIcon } from "lucide-react";
import type {
  ChatHandoff,
  ChatModelReference,
  ProviderSnapshot,
} from "@paws/contracts";
import { ProviderIcon } from "../providers/ProviderIcon.tsx";

function Endpoint({
  model,
  providerName,
}: {
  model: ChatModelReference;
  providerName?: string | undefined;
}) {
  return (
    <span
      className="chat-handoff-model"
      title={`${model.providerId} · ${model.modelId}`}
    >
      <ProviderIcon driver={model.driver} />
      {providerName && <span>{providerName} ·</span>}
      <span>{model.name.replace(/^(GPT-|Claude |Gemini )/, "")}</span>
    </span>
  );
}

// Adapted from T3 Code HandoffRow / TimelineSystemDivider (MIT).
export function ContextHandoff({
  handoff,
  providers = [],
  pending = false,
}: {
  handoff: ChatHandoff;
  pending?: boolean;
  providers?: readonly ProviderSnapshot[];
}) {
  const restoring =
    handoff.kind === "session-restoration" ||
    (!handoff.kind &&
      handoff.from.length > 0 &&
      handoff.from.every(
        (model) => model.providerId === handoff.to.providerId,
      ));

  if (restoring) {
    if (handoff.status !== "failed") return null;

    return (
      <div className="chat-error" role="alert">
        Could not restore conversation context.
      </div>
    );
  }

  const label =
    handoff.status === "failed"
      ? "Context handoff failed"
      : pending
        ? "Context handoff pending"
        : "Context handoff";
  const endpoints = [...handoff.from, handoff.to];
  const distinguishProviders = endpoints.some((model) =>
    endpoints.some(
      (other) =>
        other.providerId !== model.providerId &&
        (other.name === model.name || other.driver === model.driver),
    ),
  );
  const providerName = (model: ChatModelReference) =>
    distinguishProviders
      ? (providers.find((provider) => provider.config.id === model.providerId)
          ?.config.name ?? model.providerId)
      : undefined;

  return (
    <div
      className="chat-handoff"
      data-status={
        handoff.status === "failed"
          ? "failed"
          : pending
            ? "pending"
            : "completed"
      }
      role="status"
      aria-label={label}
    >
      <div className="chat-handoff-content">
        <span className="chat-handoff-label">
          <ArrowRightLeftIcon aria-hidden />
          {label}
        </span>
        <span className="chat-handoff-endpoints">
          {handoff.from.map((model, index) => (
            <span
              className="chat-handoff-source"
              key={`${model.providerId}:${model.modelId}`}
            >
              <Endpoint model={model} providerName={providerName(model)} />
              {index < handoff.from.length - 1 && <span aria-hidden>,</span>}
            </span>
          ))}
          {handoff.from.length > 0 && <ArrowRightIcon aria-hidden />}
          <Endpoint
            model={handoff.to}
            providerName={providerName(handoff.to)}
          />
        </span>
      </div>
    </div>
  );
}
