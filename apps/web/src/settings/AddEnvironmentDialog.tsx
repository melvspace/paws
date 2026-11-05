import { useId, useRef, useState, type ComponentProps } from "react";
import type { DiscoveredEnvironment, EnvironmentState } from "@paws/contracts";
import { linkEnvironment } from "@paws/client-runtime";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { SettingsDialog } from "./SettingsDialog.tsx";

export function AddEnvironmentDialog({
  environment = null,
  onLinked,
  onDismiss,
  finalFocus,
}: {
  environment?: Pick<DiscoveredEnvironment, "id" | "url"> | null;
  onLinked: (state: EnvironmentState) => void;
  onDismiss: () => void;
  finalFocus: ComponentProps<typeof SettingsDialog>["finalFocus"];
}) {
  const formId = useId();
  const addressInput = useRef<HTMLInputElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState(environment?.url ?? "");
  const [expectedId, setExpectedId] = useState<string | undefined>(
    environment?.id,
  );
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  function failed(cause: unknown) {
    setError(
      cause instanceof Error
        ? cause.message
        : "Could not connect to this environment. Retry.",
    );
  }

  async function link() {
    if (pending) return;

    setPending(true);
    setError("");

    try {
      const state = await linkEnvironment({
        url,
        code,
        ...(expectedId ? { expectedId } : {}),
      });
      onLinked(state);
      onDismiss();
    } catch (cause) {
      failed(cause);
    } finally {
      setPending(false);
    }
  }

  return (
    <SettingsDialog
      title="Add environment"
      pending={pending}
      initialFocus={environment ? codeInput : addressInput}
      finalFocus={finalFocus}
      onDismiss={() => {
        if (!pending) onDismiss();
      }}
      footer={
        <>
          <Button variant="ghost" disabled={pending} onClick={onDismiss}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            disabled={pending || !url.trim() || !code.trim()}
          >
            {pending ? "Linking…" : "Link environment"}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="settings-editor-form"
        onSubmit={(event) => {
          event.preventDefault();
          void link();
        }}
      >
        <label>
          Address
          <Input
            ref={addressInput}
            aria-label="Environment address"
            type="url"
            required
            value={url}
            disabled={pending}
            onChange={(event) => {
              setUrl(event.target.value);
              setExpectedId(undefined);
            }}
          />
        </label>
        <label>
          Pairing code
          <Input
            ref={codeInput}
            aria-label="Pairing code from other computer"
            type="password"
            autoComplete="off"
            required
            value={code}
            disabled={pending}
            onChange={(event) => setCode(event.target.value)}
          />
        </label>
      </form>
      {error && <p role="alert">{error}</p>}
    </SettingsDialog>
  );
}
