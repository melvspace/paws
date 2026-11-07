import { useState } from "react";
import { SectionList, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { Agent } from "@paws/contracts";
import type { Routes } from "./App.tsx";
import { Button, Field, Label, Notice, styles, usePalette } from "./ui.tsx";
import { errorText, type Workspace } from "./useWorkspace.ts";

export function AgentScreen({
  workspace,
  navigation,
}: NativeStackScreenProps<Routes, "Agents"> & { workspace: Workspace }) {
  const colors = usePalette();
  const [query, setQuery] = useState("");
  const { snapshot } = workspace;
  const agents = snapshot.agents.filter((agent) =>
    `${agent.name} ${agent.role ?? ""}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const unassigned = agents.filter((agent) => !agent.teamId);
  const sections = [
    ...(snapshot.teams ?? []).map((team) => ({
      title: team.name,
      data: agents.filter((agent) => agent.teamId === team.id),
    })),
    ...(unassigned.length ? [{ title: "Unassigned", data: unassigned }] : []),
  ];

  function row(agent: Agent) {
    const conversation = snapshot.conversations?.find(
      (item) => item.agentId === agent.id,
    );

    return (
      <View
        style={[
          styles.between,
          styles.divider,
          { borderColor: colors.line, paddingVertical: 12 },
        ]}
      >
        <View style={{ flex: 1, gap: 5 }}>
          <Text style={[styles.heading, { color: colors.text }]}>
            {agent.name}
          </Text>
          {agent.role ? <Label>{agent.role}</Label> : null}
          {conversation?.status === "running" && (
            <Label>{conversation.toolActivity?.name ?? "Working…"}</Label>
          )}
          {conversation?.status === "error" && (
            <Text style={{ color: colors.danger }}>Needs attention</Text>
          )}
        </View>
        {!!conversation?.unreadCount && (
          <Label>{conversation.unreadCount} unread</Label>
        )}
        <Button
          subtle
          onPress={() => navigation.navigate("Chat", { agentId: agent.id })}
        >
          Open chat
        </Button>
      </View>
    );
  }

  return (
    <View style={styles.page}>
      <View style={[styles.between, { marginBottom: 16 }]}>
        <Text style={[styles.title, { color: colors.text }]}>Agents</Text>
        <Button subtle onPress={() => navigation.navigate("Create")}>
          New agent
        </Button>
      </View>
      <Field
        label="Search"
        value={query}
        onChangeText={setQuery}
        autoCorrect={false}
      />
      {workspace.error && (
        <View>
          <Notice text={workspace.error} error />
          <Button subtle onPress={workspace.retry}>
            Retry connection
          </Button>
        </View>
      )}
      {!workspace.connected && !workspace.error && (
        <Notice text="Connecting…" />
      )}
      <SectionList
        sections={sections}
        keyExtractor={(agent) => agent.id}
        renderItem={({ item }) => row(item)}
        renderSectionHeader={({ section }) => (
          <View
            style={{
              backgroundColor: colors.background,
              paddingTop: 24,
              paddingBottom: 8,
            }}
          >
            <Label>{section.title}</Label>
          </View>
        )}
        renderSectionFooter={({ section }) =>
          !section.data.length ? (
            <Notice text="No agents in this team." />
          ) : null
        }
        ListEmptyComponent={
          <Notice
            text={
              query
                ? "No matching agents."
                : workspace.connected
                  ? "Create an agent to start a conversation."
                  : "Waiting for your computer…"
            }
          />
        }
        refreshing={!workspace.connected && !workspace.error}
        onRefresh={workspace.retry}
        stickySectionHeadersEnabled
        contentContainerStyle={{ paddingBottom: 24 }}
      />
    </View>
  );
}

export function CreateAgentScreen({
  workspace,
  navigation,
}: NativeStackScreenProps<Routes, "Create"> & { workspace: Workspace }) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [teamId, setTeamId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    if (!workspace.client) return;

    setBusy(true);
    setError(null);

    try {
      const agent = await workspace.client.createAgent({
        name: name.trim(),
        role,
        teamId,
      });
      navigation.replace("Chat", { agentId: agent.id });
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={[styles.page, { gap: 16 }]}>
      <Field
        label="Name"
        value={name}
        onChangeText={setName}
        editable={!busy}
      />
      <Field
        label="Role"
        value={role}
        onChangeText={setRole}
        editable={!busy}
      />
      <Label>Team</Label>
      <View style={{ gap: 4 }}>
        {[
          { id: null, name: "Unassigned" },
          ...(workspace.snapshot.teams ?? []),
        ].map((team) => (
          <Button
            key={team.id ?? "none"}
            subtle={teamId !== team.id}
            disabled={busy}
            onPress={() => setTeamId(team.id)}
          >
            {team.name}
          </Button>
        ))}
      </View>
      {error && <Notice text={error} error />}
      <Button
        onPress={() => void create()}
        disabled={!name.trim() || busy || !workspace.connected}
      >
        {busy ? "Creating…" : "Create agent"}
      </Button>
    </View>
  );
}
