import { useEffect, useRef, useState } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Platform,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { useIsFocused } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as Crypto from "expo-crypto";
import * as DocumentPicker from "expo-document-picker";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { fetch as nativeFetch } from "expo/fetch";
import Markdown from "react-native-markdown-display";
import type {
  ChatAttachment,
  ChatMessage,
  ChatSelection,
  SendChat,
} from "@paws/contracts";
import type { Routes } from "./App.tsx";
import { ChatCard } from "./ChatCard.tsx";
import { Button, Label, Notice, styles, usePalette } from "./ui.tsx";
import { errorText, type Workspace } from "./useWorkspace.ts";

export function ChatScreen({
  route,
  workspace,
  navigation,
}: NativeStackScreenProps<Routes, "Chat"> & { workspace: Workspace }) {
  const { agentId } = route.params;
  const focused = useIsFocused();
  const colors = usePalette();
  const client = workspace.client!;
  const agent = workspace.snapshot.agents.find((item) => item.id === agentId);
  const conversation = workspace.snapshot.conversations?.find(
    (item) => item.agentId === agentId,
  );
  const providers =
    workspace.snapshot.providers?.filter(
      (item) => item.config.enabled && item.status === "ready",
    ) ?? [];
  const models = providers.flatMap((provider) =>
    provider.models.map((model) => ({ provider, model })),
  );
  const [picked, setPicked] = useState<ChatSelection | null>(null);
  const preferred = picked ?? conversation?.selection;
  const selected =
    models.find(
      (item) =>
        item.provider.config.id === preferred?.providerId &&
        item.model.id === preferred.modelId,
    ) ?? models[0];
  const selection: ChatSelection | undefined = selected
    ? {
        providerId: selected.provider.config.id,
        modelId: selected.model.id,
        options: Object.fromEntries(
          selected.model.options.map((option) => [
            option.id,
            preferred?.options[option.id] ?? option.defaultValue,
          ]),
        ),
      }
    : undefined;
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [working, setWorking] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [mode, setMode] = useState<"steer" | "queue">("steer");
  const retry = useRef<SendChat | null>(null);
  const list = useRef<FlatList<ChatMessage>>(null);
  const follow = useRef(true);
  const running = conversation?.status === "running";
  const messages = conversation?.messages ?? [];

  useEffect(() => {
    let active = true;
    setLoading(true);
    void client
      .chat(agentId)
      .then((next) => {
        if (active) workspace.merge(next);
      })
      .catch((failure: unknown) => {
        if (active) setError(errorText(failure));
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [client, agentId, workspace.merge]);

  const readId = [...messages]
    .reverse()
    .find((message) => message.role === "assistant" && !message.streaming)?.id;

  useEffect(() => {
    if (
      !focused ||
      !readId ||
      !workspace.connected ||
      conversation?.lastReadMessageId === readId
    )
      return;

    void client.markRead(agentId, readId).catch(() => {});
  }, [
    client,
    agentId,
    readId,
    focused,
    workspace.connected,
    conversation?.lastReadMessageId,
  ]);

  async function perform(action: () => Promise<unknown>) {
    setWorking(true);
    setError(null);

    try {
      await action();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setWorking(false);
    }
  }

  async function send(reply?: NonNullable<SendChat["reply"]>) {
    if (!selection || sending) return;

    setSending(true);
    setError(null);
    const draft: SendChat = {
      requestId: Crypto.randomUUID(),
      text: reply ? "" : text,
      selection,
      mode,
      ...(reply
        ? { reply }
        : { attachmentIds: attachments.map((item) => item.id) }),
    };
    // Reuse the exact request after a network failure, including its model and
    // attachment IDs. The server deduplicates a response lost in transit.
    const input =
      !reply &&
      retry.current?.text === draft.text &&
      JSON.stringify(retry.current.attachmentIds) ===
        JSON.stringify(draft.attachmentIds)
        ? retry.current
        : draft;

    if (!reply) retry.current = input;

    try {
      workspace.merge(await client.chat(agentId, input));

      if (!reply) {
        setText("");
        setAttachments([]);
        retry.current = null;
      }

      follow.current = true;
    } catch (failure) {
      setError(errorText(failure));

      if (reply) throw failure;
    } finally {
      setSending(false);
    }
  }

  async function attach() {
    const pickedFile = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
    });

    if (pickedFile.canceled) return;

    const asset = pickedFile.assets[0]!;
    const file = new File(asset.uri);

    try {
      if (file.size > 64 * 1024 * 1024)
        throw new Error("Files must be 64 MB or smaller.");

      // Expo's native fetch accepts file-backed Blobs without loading a base64
      // copy into the JS heap. The shared client supplies auth and validation.
      const uploader = (
        await import("@paws/client-runtime/remote")
      ).createRemoteClient(workspace.connection!, nativeFetch);
      const uploaded = await uploader.upload(agentId, asset.name, file);
      setAttachments((current) => [...current, uploaded]);
    } finally {
      if (file.exists) file.delete();
    }
  }

  async function openAttachment(attachment: ChatAttachment) {
    const directory = new (await import("expo-file-system")).Directory(
      Paths.cache,
      "attachments",
      Crypto.randomUUID(),
    );
    directory.create({ intermediates: true });
    const name = attachment.name.replace(/[\\/]/g, "_") || "attachment";
    try {
      const file = await File.downloadFileAsync(
        client.attachmentUrl(agentId, attachment.id),
        new File(directory, name),
        { headers: client.headers },
      );
      await Sharing.shareAsync(file.uri, { mimeType: attachment.mediaType });
    } finally {
      directory.delete();
    }
  }

  function message(item: ChatMessage) {
    return (
      <View
        style={{
          paddingVertical: 16,
          gap: 8,
          borderBottomWidth: 0.5,
          borderColor: colors.line,
        }}
      >
        <View style={styles.between}>
          <Label>
            {item.role === "user"
              ? "You"
              : (item.model?.name ?? agent?.name ?? "Agent")}
          </Label>
          {item.delivery && item.delivery !== "delivered" && (
            <Label>{item.delivery}</Label>
          )}
        </View>
        {item.peer && (
          <Label>
            {item.peer.fromName} → {item.peer.toName}
          </Label>
        )}
        {item.routine && <Label>{item.routine.name}</Label>}
        <Markdown
          style={{
            body: { color: colors.text, fontSize: 16, lineHeight: 24 },
            code_inline: {
              backgroundColor: colors.surface,
              color: colors.text,
            },
            fence: {
              backgroundColor: colors.surface,
              color: colors.text,
              borderColor: colors.line,
            },
            link: { color: colors.accent },
          }}
          onLinkPress={(url) => {
            if (/^https?:\/\//i.test(url))
              void Linking.openURL(url).catch(() =>
                setError("Could not open this link."),
              );

            return false;
          }}
        >
          {item.card?.text ?? item.text}
        </Markdown>
        {item.attachments?.map((attachment) => (
          <Button
            key={attachment.id}
            subtle
            disabled={working}
            onPress={() => void perform(() => openAttachment(attachment))}
          >
            {attachment.name}
          </Button>
        ))}
        <ChatCard
          message={item}
          disabled={!workspace.connected || sending || !selection}
          reply={send}
        />
        {item.streaming && <Label>Writing…</Label>}
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={90}
    >
      <View
        style={[styles.between, { paddingHorizontal: 16, paddingVertical: 6 }]}
      >
        <Text
          numberOfLines={1}
          style={[styles.heading, { color: colors.text, flex: 1 }]}
        >
          {agent?.name ?? "Agent"}
        </Text>
        <Button
          subtle
          onPress={() => navigation.navigate("AgentSettings", { agentId })}
        >
          Settings
        </Button>
      </View>
      {!workspace.connected && (
        <View style={{ paddingHorizontal: 16 }}>
          <Notice text={workspace.error ?? "Reconnecting…"} error />
          <Button subtle onPress={workspace.retry}>
            Retry connection
          </Button>
        </View>
      )}
      <FlatList
        ref={list}
        data={messages}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => message(item)}
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 20 }}
        onScroll={({ nativeEvent }) => {
          follow.current =
            nativeEvent.contentSize.height -
              nativeEvent.layoutMeasurement.height -
              nativeEvent.contentOffset.y <
            100;
        }}
        onContentSizeChange={() => {
          if (follow.current) list.current?.scrollToEnd({ animated: false });
        }}
        ListHeaderComponent={
          conversation?.historyCursor ? (
            <Button
              subtle
              disabled={working}
              onPress={() =>
                void perform(async () => {
                  const cursor = conversation.historyCursor!;
                  const page = await client.history(agentId, cursor);
                  workspace.prepend(agentId, page, cursor);
                  follow.current = false;
                })
              }
            >
              Load older messages
            </Button>
          ) : undefined
        }
        ListEmptyComponent={
          <Notice
            text={
              loading
                ? "Loading conversation…"
                : "Send a message to get started."
            }
          />
        }
      />
      {(error ?? conversation?.error) && (
        <View style={{ paddingHorizontal: 16 }}>
          <Notice text={(error ?? conversation?.error)!} error />
        </View>
      )}
      {conversation?.interrupted && (
        <Button
          subtle
          disabled={working || !workspace.connected}
          onPress={() =>
            void perform(async () =>
              workspace.merge(await client.chat(agentId, "continue")),
            )
          }
        >
          Continue interrupted turn
        </Button>
      )}
      {conversation?.queue
        ?.filter((item) => item.held)
        .map((item) => (
          <View
            key={item.requestId}
            style={[styles.row, { paddingHorizontal: 16 }]}
          >
            <Text numberOfLines={1} style={{ color: colors.muted, flex: 1 }}>
              {item.text}
            </Text>
            <Button
              subtle
              disabled={working}
              onPress={() =>
                void perform(async () =>
                  workspace.merge(
                    await client.queue(agentId, item.requestId, "resume"),
                  ),
                )
              }
            >
              Resume
            </Button>
            <Button
              subtle
              disabled={working}
              onPress={() =>
                void perform(async () =>
                  workspace.merge(
                    await client.queue(agentId, item.requestId, "remove"),
                  ),
                )
              }
            >
              Remove
            </Button>
          </View>
        ))}
      {running && (
        <View style={[styles.between, { paddingHorizontal: 16 }]}>
          <Label>{conversation.toolActivity?.name ?? "Working…"}</Label>
          <Button
            subtle
            danger
            disabled={working || !workspace.connected}
            onPress={() =>
              void perform(async () =>
                workspace.merge(await client.chat(agentId, "stop")),
              )
            }
          >
            Stop
          </Button>
        </View>
      )}
      <View
        style={{
          padding: 12,
          gap: 8,
          borderTopWidth: 0.5,
          borderColor: colors.line,
        }}
      >
        {modelsOpen && (
          <ScrollView style={{ maxHeight: 210 }}>
            {models.map(({ provider, model }) => (
              <Button
                key={`${provider.config.id}:${model.id}`}
                subtle
                disabled={sending}
                onPress={() => {
                  setPicked({
                    providerId: provider.config.id,
                    modelId: model.id,
                    options: {},
                  });
                  setModelsOpen(false);
                }}
              >{`${provider.config.name} · ${model.name}`}</Button>
            ))}
            {selected?.model.options.map((option) => (
              <View key={option.id}>
                <Label>{option.label}</Label>
                <View style={[styles.row, { flexWrap: "wrap" }]}>
                  {option.choices.map((choice) => (
                    <Button
                      key={choice.id}
                      subtle={selection?.options[option.id] !== choice.id}
                      onPress={() => {
                        if (selection)
                          setPicked({
                            ...selection,
                            options: {
                              ...selection.options,
                              [option.id]: choice.id,
                            },
                          });
                      }}
                    >
                      {choice.label}
                    </Button>
                  ))}
                </View>
              </View>
            ))}
            <Button
              subtle
              disabled={working || !workspace.connected || running}
              onPress={() =>
                void perform(async () =>
                  workspace.merge(await client.chat(agentId, "compact")),
                )
              }
            >
              Compact context
            </Button>
          </ScrollView>
        )}
        <View style={styles.between}>
          <Button
            subtle
            disabled={sending}
            onPress={() => setModelsOpen((value) => !value)}
          >
            {selected?.model.name ?? "No models available"}
          </Button>
          {running && (
            <Button
              subtle
              onPress={() =>
                setMode((value) => (value === "steer" ? "queue" : "steer"))
              }
            >
              {mode === "steer" ? "Steer" : "Queue"}
            </Button>
          )}
        </View>
        {!models.length && workspace.connected && (
          <Notice text="Set up a provider on your computer to send messages." />
        )}
        {attachments.map((attachment) => (
          <View key={attachment.id} style={styles.between}>
            <Label>{attachment.name}</Label>
            <Button
              subtle
              disabled={sending}
              onPress={() =>
                setAttachments((current) =>
                  current.filter((item) => item.id !== attachment.id),
                )
              }
            >
              Remove
            </Button>
          </View>
        ))}
        <TextInput
          accessibilityLabel="Message"
          multiline
          value={text}
          onChangeText={setText}
          editable={!sending}
          style={[
            styles.input,
            {
              color: colors.text,
              borderColor: colors.line,
              backgroundColor: colors.surface,
              maxHeight: 160,
              minHeight: 48,
            },
          ]}
        />
        <View style={styles.between}>
          <Button
            subtle
            disabled={working || sending || !workspace.connected}
            onPress={() => void perform(attach)}
          >
            Attach file
          </Button>
          <Button
            disabled={
              !selection ||
              !workspace.connected ||
              sending ||
              working ||
              (!text.trim() && !attachments.length)
            }
            onPress={() => void send()}
          >
            {sending ? "Sending…" : "Send"}
          </Button>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}
