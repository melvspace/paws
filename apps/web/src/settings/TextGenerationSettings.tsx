import { useEffect, useRef, useState, type RefObject } from "react";
import { useAtomValue } from "@effect/atom-react";
import { providersAtom, textGenerationSettings } from "@paws/client-runtime";
import { modelKey } from "@paws/provider-core";
import { availableModels } from "../workspace/models.ts";
import { Button } from "../components/ui/button.tsx";

export function TextGenerationSettings({
  beforeClose,
}: {
  beforeClose?: RefObject<(() => Promise<void>) | null> | undefined;
}) {
  const saving = useRef<Promise<void> | null>(null);
  const failed = useRef(false);

  useEffect(() => {
    if (!beforeClose) return;

    beforeClose.current = async () => {
      await saving.current;

      if (failed.current) throw new Error("Retry the failed model selection.");
    };

    return () => {
      beforeClose.current = null;
    };
  }, [beforeClose]);
  const { providers } = useAtomValue(providersAtom);
  const [state, setState] =
    useState<Awaited<ReturnType<typeof textGenerationSettings>>>();
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const models = availableModels(
    providers.filter((provider) =>
      ["codex", "claudeAgent"].includes(provider.config.driver),
    ),
  );

  useEffect(() => {
    let cancelled = false;
    void textGenerationSettings()
      .then((next) => {
        if (cancelled) return;

        setState(next);
        setValue(
          next.selection
            ? modelKey(next.selection.providerId, next.selection.modelId)
            : "",
        );
      })
      .catch(() => {
        if (!cancelled)
          setError(
            "Could not load the text generation model. Reopen settings to retry.",
          );
      });

    return () => {
      cancelled = true;
    };
  }, []);

  async function save(next: string) {
    setValue(next);
    setPending(true);
    setError(null);
    const model = models.find((item) => item.id === next);

    try {
      setState(
        await textGenerationSettings({
          selection: model
            ? {
                providerId: model.provider,
                modelId: model.nativeId,
                options: {},
              }
            : null,
        }),
      );
      failed.current = false;
    } catch {
      failed.current = true;
      setError("Could not save the text generation model. Retry.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="text-generation-heading">
      <h3 id="text-generation-heading">Text generation</h3>
      <div className="chat-settings-row">
        <div>
          <h4>Model</h4>
          <p>
            Infers agent specialties from instructions, routines and recurring
            requests.
          </p>
        </div>
        <select
          aria-label="Text generation model"
          value={value}
          disabled={!state || pending}
          onChange={(event) => {
            saving.current = save(event.target.value);
          }}
        >
          <option value="">Automatic · Luna</option>
          {value && !models.some((model) => model.id === value) && (
            <option value={value}>Unavailable model</option>
          )}
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.providerName} · {model.name}
            </option>
          ))}
        </select>
      </div>
      {pending && <p role="status">Updating…</p>}
      {state && !state.effectiveSelection && (
        <p role="status">
          Choose a model or enable a provider with Luna to generate agent
          profiles.
        </p>
      )}
      {error && (
        <p role="alert">
          {error}{" "}
          {state && (
            <Button
              variant="outline"
              onClick={() => {
                saving.current = save(value);
              }}
            >
              Retry
            </Button>
          )}
        </p>
      )}
      {state?.errors.map((item) => (
        <p role="alert" key={item.agentId}>
          {item.error}
        </p>
      ))}
    </section>
  );
}
