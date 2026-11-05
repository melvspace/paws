import { useRef, useState, type ComponentProps } from "react";
import type { EnvironmentState } from "@paws/contracts";
import { configureEnvironment } from "@paws/client-runtime";
import { Input } from "../components/ui/input.tsx";
import { SettingsDialog } from "./SettingsDialog.tsx";

export function RenameEnvironmentDialog({
  name: initialName,
  onChanged,
  onDismiss,
  finalFocus,
}: {
  name: string;
  onChanged: (state: EnvironmentState) => void;
  onDismiss: () => void;
  finalFocus: ComponentProps<typeof SettingsDialog>["finalFocus"];
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef(initialName);
  const saved = useRef(initialName);
  const saving = useRef<Promise<void> | null>(null);
  const closing = useRef(false);
  const [name, setName] = useState(initialName);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  function saveName(): Promise<void> {
    if (saving.current) return saving.current;
    if (nameRef.current === saved.current) return Promise.resolve();

    setPending(true);
    setError("");
    const request = configureEnvironment({ name: nameRef.current })
      .then((state) => {
        saved.current = state.local.name;
        nameRef.current = state.local.name;
        setName(state.local.name);
        onChanged(state);
      })
      .catch((cause: unknown) => {
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not rename this environment. Retry closing the dialog.",
        );

        throw cause;
      })
      .finally(() => {
        saving.current = null;
        setPending(false);
      });
    saving.current = request;

    return request;
  }

  async function dismiss() {
    if (closing.current) return;

    closing.current = true;

    try {
      inputRef.current?.blur();
      await saveName();
      onDismiss();
    } catch {
      // Keep the failed name and its error visible for a retry.
    } finally {
      closing.current = false;
    }
  }

  return (
    <SettingsDialog
      title="Rename environment"
      pending={pending}
      dismissible
      initialFocus={inputRef}
      finalFocus={finalFocus}
      onDismiss={dismiss}
    >
      <form
        className="settings-editor-form"
        onSubmit={(event) => {
          event.preventDefault();
          void dismiss();
        }}
      >
        <label>
          Name
          <Input
            ref={inputRef}
            aria-label="Environment name"
            value={name}
            maxLength={80}
            required
            disabled={pending}
            onChange={(event) => {
              nameRef.current = event.target.value;
              setName(event.target.value);
            }}
            onBlur={() => {
              void saveName().catch(() => {});
            }}
          />
        </label>
      </form>
      {pending && <p role="status">Renaming…</p>}
      {error && <p role="alert">{error}</p>}
    </SettingsDialog>
  );
}
