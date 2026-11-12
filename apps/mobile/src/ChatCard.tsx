import { useState } from "react";
import { View } from "react-native";
import type { ChatMessage, SendChat } from "@paws/contracts";
import { Button, Field, Label, Notice } from "./ui.tsx";

type Reply = NonNullable<SendChat["reply"]>;

export function ChatCard({
  message,
  disabled,
  reply,
}: {
  message: ChatMessage;
  disabled: boolean;
  reply(value: Reply): Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const card = message.card;
  disabled ||= !!message.dismissed;

  if (!card) return null;

  if (message.response) return <Label>{message.response}</Label>;

  async function submit(actionId: string, secretValue?: string) {
    if (disabled) return;

    if (
      card?.fields.some((field) => field.required && !values[field.id]?.trim())
    ) {
      setError("Complete the required fields.");

      return;
    }

    setError(null);
    try {
      await reply({
        messageId: message.id,
        actionId,
        values,
        ...(secretValue !== undefined ? { secret: secretValue } : {}),
      });
      setSecret("");
    } catch {
      setError("Could not send your response. Try again.");
    }
  }

  return (
    <View style={{ gap: 12, marginTop: 12 }}>
      {card.fields.map((field) =>
        field.type === "select" ? (
          <View key={field.id} style={{ gap: 4 }}>
            <Label>
              {field.label}
              {field.required ? " *" : ""}
            </Label>
            {field.choices.map((choice) => (
              <Button
                key={choice.id}
                disabled={disabled}
                subtle={values[field.id] !== choice.id}
                onPress={() =>
                  setValues((current) => ({
                    ...current,
                    [field.id]: choice.id,
                  }))
                }
              >
                {choice.label}
              </Button>
            ))}
          </View>
        ) : (
          <Field
            key={field.id}
            label={`${field.label}${field.required ? " *" : ""}`}
            value={values[field.id] ?? ""}
            onChangeText={(value) =>
              setValues((current) => ({ ...current, [field.id]: value }))
            }
            editable={!disabled}
            multiline={field.type === "textarea"}
          />
        ),
      )}
      {card.secretRequest ? (
        <>
          <Field
            label={card.secretRequest.label}
            value={secret}
            onChangeText={setSecret}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            editable={!disabled}
          />
          <Button
            disabled={disabled || !secret}
            onPress={() => void submit("save", secret)}
          >
            Send securely
          </Button>
          <Button
            subtle
            disabled={disabled}
            onPress={() => void submit("decline")}
          >
            Decline
          </Button>
        </>
      ) : (
        card.actions.map((action) => (
          <Button
            key={action.id}
            disabled={disabled}
            onPress={() => void submit(action.id)}
          >
            {action.label}
          </Button>
        ))
      )}
      {error && <Notice text={error} error />}
    </View>
  );
}
