import { useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { usePreventRemove } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { Routes } from "./App.tsx";
import { Button, Field, Label, Notice, styles, usePalette } from "./ui.tsx";
import { errorText, type Workspace } from "./useWorkspace.ts";

export function SettingsScreen({ workspace }: { workspace: Workspace }) {
  const colors = usePalette();
  const [error, setError] = useState<string | null>(null);

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Label>Computer</Label>
      <Text selectable style={{ color: colors.text }}>
        {workspace.connection?.origin}
      </Text>
      <Button
        subtle
        onPress={() =>
          void workspace
            .disconnect()
            .catch((failure: unknown) => setError(errorText(failure)))
        }
      >
        Disconnect
      </Button>
      {error && <Notice text={error} error />}
      <Label>Providers</Label>
      {workspace.snapshot.providers?.map((provider) => (
        <View
          key={provider.config.id}
          style={[
            styles.divider,
            { borderColor: colors.line, paddingVertical: 12, gap: 6 },
          ]}
        >
          <Text style={[styles.heading, { color: colors.text }]}>
            {provider.config.name}
          </Text>
          <Label>{provider.status}</Label>
          {provider.message && <Notice text={provider.message} />}
        </View>
      ))}
    </ScrollView>
  );
}

export function AgentSettingsScreen({
  route,
  workspace,
  navigation,
}: NativeStackScreenProps<Routes, "AgentSettings"> & { workspace: Workspace }) {
  const agent = workspace.snapshot.agents.find(
    (item) => item.id === route.params.agentId,
  );
  const [name, setName] = useState(agent?.name ?? "");
  const [role, setRole] = useState(agent?.role ?? "");
  const [description, setDescription] = useState(agent?.description ?? "");
  const [saved, setSaved] = useState({ name, role, description });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef<Promise<boolean> | null>(null);
  const latest = useRef({ name, role, description });
  latest.current = { name, role, description };
  const dirty =
    name !== saved.name ||
    role !== saved.role ||
    description !== saved.description;

  async function flush(): Promise<boolean> {
    while (saving.current) {
      if (!(await saving.current)) return false;
    }

    const submitted = latest.current;
    const input = { ...submitted, name: submitted.name.trim() };

    if (!input.name) {
      setError("Name is required.");

      return false;
    }

    if (!workspace.client || !agent) return false;

    setPending(true);
    setError(null);
    const request = workspace.client
      .updateAgent(agent.id, input)
      .then(() => {
        setSaved(input);
        setName((current) =>
          current === submitted.name ? input.name : current,
        );

        return true;
      })
      .catch((failure: unknown) => {
        setError(errorText(failure));

        return false;
      })
      .finally(() => {
        saving.current = null;
        setPending(false);
      });
    saving.current = request;

    return request;
  }

  usePreventRemove(!!agent && (dirty || pending), ({ data }) => {
    void flush().then((success) => {
      if (success) navigation.dispatch(data.action);
    });
  });

  if (!agent)
    return (
      <View style={styles.page}>
        <Notice text="This agent is no longer available." />
      </View>
    );

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Field
        label="Name"
        value={name}
        onChangeText={setName}
        onBlur={() => {
          if (dirty) void flush();
        }}
      />
      <Field
        label="Role"
        value={role}
        onChangeText={setRole}
        onBlur={() => {
          if (dirty) void flush();
        }}
      />
      <Field
        label="Description"
        value={description}
        onChangeText={setDescription}
        onBlur={() => {
          if (dirty) void flush();
        }}
        multiline
      />
      {pending && <Notice text="Saving…" />}
      {error && (
        <View>
          <Notice text={error} error />
          <Button subtle onPress={() => void flush()}>
            Retry
          </Button>
        </View>
      )}
    </ScrollView>
  );
}
