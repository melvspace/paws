import {
  Fragment,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Form } from "@base-ui/react/form";
import { Select } from "@base-ui/react/select";
import { Bot, CheckIcon, ClockIcon, ChevronDownIcon } from "lucide-react";
import type {
  ChatMessage,
  ChatQueueAction,
  ChatModelReference,
  ChatHandoff,
  ProviderSnapshot,
  ChatInteraction,
  Conversation,
  SendChat,
} from "@paws/contracts";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { Textarea } from "../components/ui/textarea.tsx";
import "./chat.css";
import { MessageMarkdown } from "./MessageMarkdown.tsx";
import { messageTime } from "./messageTime.ts";
import { MessageAttachment } from "./MessageAttachment.tsx";
import { ContextHandoff } from "./ContextHandoff.tsx";
import { handoffPresentation } from "./handoffPresentation.ts";
import { useChatPreferences } from "../settings/chatPreferences.ts";
import { ChatRecovery } from "./ChatRecovery.tsx";
import { SecretRequestForm } from "./SecretRequestForm.tsx";

type Reply = NonNullable<SendChat["reply"]>;

function toolProgress(activity: NonNullable<Conversation["toolActivity"]>) {
  const labels: Record<string, string> = {
    paws_exec: "Running a workspace command",
    paws_read_attachment: "Opening an attachment",
    paws_view_image: "Viewing an image",
    paws_send_message: "Sending a message",
    request_secret: "Requesting private input",
    paws_finish_turn: "Finishing",
  };
  const label =
    activity.status === "failed"
      ? "Tool failed"
      : activity.status === "completed"
        ? "Tool finished; working on reply"
        : (labels[activity.name] ?? "Using tools");

  return `${label} · ${activity.count} calls`;
}

function InteractionReceipt({ interaction }: { interaction: ChatInteraction }) {
  const labels = {
    action_clicked: `Selected: ${interaction.action.label}`,
    form_submitted: "Form submitted",
    secret_saved: "Secret provided securely",
    secret_declined: "Secret request declined",
  };
  const delivery = {
    queued: "Queued for next turn",
    steered: "Sent to active turn",
    delivered: "",
    failed: "Delivery could not be confirmed",
    cancelled: "Cancelled",
  };

  return (
    <div className="chat-card-receipt">
      <span className="chat-card-answered" role="status">
        {labels[interaction.type]}
        {interaction.delivery &&
          delivery[interaction.delivery] &&
          ` · ${delivery[interaction.delivery]}`}
      </span>
      {interaction.fields.length > 0 && (
        <dl className="chat-card-summary">
          {interaction.fields.map((field) => (
            <div key={field.id}>
              <dt>{field.label}</dt>
              <dd>{field.displayValue || "—"}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function MessageControls({
  message,
  disabled,
  onReply,
}: {
  message: ChatMessage;
  disabled: boolean;
  onReply: (reply: Reply) => Promise<boolean>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [validationError, setValidationError] = useState<string | null>(null);
  const card = message.card;

  if (
    !card ||
    (!card.actions.length && !card.fields.length && !card.secretRequest)
  )
    return null;
  if (message.interaction && message.interaction.delivery !== "cancelled")
    return <InteractionReceipt interaction={message.interaction} />;
  if (message.response)
    return <span className="chat-card-answered">Answered</span>;

  if (card.secretRequest)
    return (
      <SecretRequestForm
        messageId={message.id}
        label={card.secretRequest.label}
        disabled={disabled}
        onReply={onReply}
      />
    );

  return (
    <Form
      className="chat-card-form"
      onSubmit={(event) => {
        event.preventDefault();
        const missing = card.fields.find(
          (field) => field.required && !values[field.id]?.trim(),
        );

        if (missing) {
          setValidationError(`${missing.label} is required.`);

          return;
        }

        setValidationError(null);
        const submitter = (event.nativeEvent as SubmitEvent).submitter;
        const actionId =
          submitter instanceof HTMLButtonElement
            ? submitter.value
            : (card.actions[0]?.id ?? "submit");
        void onReply({ messageId: message.id, actionId, values });
      }}
    >
      {card.fields.map((field) => {
        const id = `${message.id}-${field.id}`;
        const setValue = (value: string) =>
          setValues((current) => ({ ...current, [field.id]: value }));

        return (
          <label key={field.id} htmlFor={id} className="chat-card-field">
            <span className="chat-field-label">
              <span>
                {field.label}
                {field.required && <span aria-hidden> *</span>}
              </span>
              {!field.required && (
                <span className="chat-field-hint">Optional</span>
              )}
            </span>
            {field.type === "select" ? (
              <Select.Root
                name={field.id}
                value={values[field.id] ?? ""}
                onValueChange={(value) => setValue(value ?? "")}
                required={field.required}
                disabled={disabled}
                items={field.choices.map((choice) => ({
                  value: choice.id,
                  label: choice.label,
                }))}
              >
                <Select.Trigger id={id} className="chat-select-trigger">
                  <Select.Value placeholder="Select…" />
                  <ChevronDownIcon size={14} />
                </Select.Trigger>
                <Select.Portal>
                  <Select.Positioner
                    className="ui-popover-positioner"
                    sideOffset={4}
                  >
                    <Select.Popup className="chat-select-popup">
                      {field.choices.map((choice) => (
                        <Select.Item
                          key={choice.id}
                          value={choice.id}
                          className="chat-select-item"
                        >
                          <Select.ItemText>{choice.label}</Select.ItemText>
                        </Select.Item>
                      ))}
                    </Select.Popup>
                  </Select.Positioner>
                </Select.Portal>
              </Select.Root>
            ) : field.type === "textarea" ? (
              <Textarea
                id={id}
                value={values[field.id] ?? ""}
                onChange={(event) => setValue(event.target.value)}
                required={field.required}
                maxLength={4000}
                disabled={disabled}
              />
            ) : (
              <Input
                id={id}
                value={values[field.id] ?? ""}
                onChange={(event) => setValue(event.target.value)}
                required={field.required}
                maxLength={4000}
                disabled={disabled}
              />
            )}
          </label>
        );
      })}
      {validationError && (
        <span role="alert" className="chat-form-error">
          {validationError}
        </span>
      )}
      <div className="chat-card-actions">
        {(card.actions.length
          ? card.actions
          : [{ id: "submit", label: "Submit" }]
        ).map((action) => (
          <Button
            key={action.id}
            type="submit"
            variant="outline"
            value={action.id}
            disabled={disabled}
          >
            {action.label}
          </Button>
        ))}
      </div>
    </Form>
  );
}

export function ChatHistory({
  conversation,
  busy,
  error,
  onReply,
  selectedModel,
  onQueueUpdate,
  onContinue,
  onRestoreDraft,
  providers = [],
  outgoing = {},
  onRetryMessage,
}: {
  outgoing?: Readonly<Record<string, "sending" | "failed">>;
  onRetryMessage?: (id: string) => Promise<boolean>;
  onQueueUpdate?: (action: ChatQueueAction) => Promise<boolean>;
  onContinue?: () => Promise<boolean>;
  onRestoreDraft?: (text: string) => void;
  providers?: readonly ProviderSnapshot[];
  selectedModel?: ChatModelReference | undefined;
  conversation: Conversation | undefined;
  busy: boolean;
  error: string | null;
  onReply: (reply: Reply) => Promise<boolean>;
}) {
  const history = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const { messageDisplay } = useChatPreferences();
  const heldIds = new Set(
    conversation?.queue
      ?.filter((entry) => entry.held)
      .map((entry) => entry.requestId),
  );
  const messages = (conversation?.messages ?? []).filter(
    (message) =>
      (messageDisplay === "streaming" || !message.streaming) &&
      !heldIds.has(message.id),
  );
  const times = messages.map((message) => messageTime(message.createdAt));
  const running = conversation?.status === "running";
  const failure = error ?? conversation?.error;
  const handoffs = handoffPresentation(
    conversation?.handoffs ?? [],
    conversation?.messages ?? [],
  );
  const anchoredHandoffs = new Map<string, ChatHandoff[]>();
  const messageIds = new Set(messages.map((message) => message.id));

  for (const handoff of handoffs) {
    const anchor = messageIds.has(handoff.beforeMessageId)
      ? handoff.beforeMessageId
      : "";
    anchoredHandoffs.set(anchor, [
      ...(anchoredHandoffs.get(anchor) ?? []),
      handoff,
    ]);
  }

  const previous = conversation?.selection;
  const previousProvider = providers.find(
    (item) => item.config.id === previous?.providerId,
  );
  const previousModel = previous
    ? {
        providerId: previous.providerId,
        modelId: previous.modelId,
        name:
          previousProvider?.models.find((item) => item.id === previous.modelId)
            ?.name ??
          conversation?.messages.findLast(
            (message) =>
              message.model?.providerId === previous.providerId &&
              message.model.modelId === previous.modelId,
          )?.model?.name ??
          previous.modelId,
        ...(previousProvider ? { driver: previousProvider.config.driver } : {}),
      }
    : undefined;

  const pending: ChatHandoff | undefined =
    selectedModel &&
    previous &&
    messages.length &&
    selectedModel.providerId !== previous.providerId
      ? {
          id: "draft",
          kind: "provider-switch",
          beforeMessageId: "",
          from: previousModel ? [previousModel] : [],
          to: selectedModel,
          status: "pending",
        }
      : undefined;

  useLayoutEffect(() => {
    if (follow.current && history.current)
      history.current.scrollTop = history.current.scrollHeight;
  }, [
    conversation?.revision,
    messageDisplay,
    error,
    selectedModel?.providerId,
    selectedModel?.modelId,
    messages.length,
  ]);

  return (
    <div
      className="chat-history messenger-history"
      ref={history}
      onLoadCapture={() => {
        if (follow.current && history.current)
          history.current.scrollTop = history.current.scrollHeight;
      }}
      onScroll={() => {
        const element = history.current;

        if (element)
          follow.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            100;
      }}
    >
      {!messages.length &&
      !failure &&
      !running &&
      !heldIds.size &&
      !conversation?.interrupted ? (
        <div className="chat-empty">
          <Bot size={28} aria-hidden />
          <p>No messages</p>
        </div>
      ) : null}
      <div
        className="chat-message-list"
        role="log"
        aria-label="Conversation"
        aria-live="polite"
        aria-relevant="additions"
      >
        {messages.map((message, index) => {
          const time = times[index];
          const startsDay = time && time.day !== times[index - 1]?.day;
          const sending = outgoing[message.id] === "sending";
          const deliveryLabel = sending
            ? "Sending"
            : message.delivery === "queued"
              ? "Queued"
              : message.delivery === "steered"
                ? "Sent to active turn"
                : message.delivery === "failed"
                  ? "Delivery could not be confirmed"
                  : message.delivery === "cancelled"
                    ? "Cancelled"
                    : "Sent";
          const timestamp = time ? (
            <span className="chat-message-meta">
              <time
                className="chat-message-time"
                dateTime={time.dateTime}
                title={time.fullLabel}
                aria-label={time.fullLabel}
              >
                {time.label}
              </time>
              {message.role === "user" && (
                <span
                  className="chat-message-send-state"
                  role="status"
                  aria-label={deliveryLabel}
                  title={deliveryLabel}
                >
                  {sending || message.delivery === "queued" ? (
                    <ClockIcon aria-hidden />
                  ) : message.delivery === "failed" ||
                    message.delivery === "cancelled" ? null : (
                    <CheckIcon aria-hidden />
                  )}
                </span>
              )}
            </span>
          ) : null;

          return (
            <Fragment key={message.id}>
              {startsDay && (
                <div className="chat-date-separator">
                  <time dateTime={time.day}>{time.dayLabel}</time>
                </div>
              )}
              {anchoredHandoffs.get(message.id)?.map((handoff) => (
                <ContextHandoff
                  key={handoff.id}
                  handoff={handoff}
                  providers={providers}
                />
              ))}
              <article
                className="chat-message"
                data-role={message.role}
                aria-label={message.role === "user" ? "You" : "Agent"}
              >
                <div
                  className="chat-message-bubble"
                  data-inline-time={
                    time && !message.attachments?.length && !message.card
                      ? ""
                      : undefined
                  }
                  style={
                    time
                      ? ({
                          "--message-time-label": JSON.stringify(time.label),
                        } as CSSProperties)
                      : undefined
                  }
                >
                  {message.role === "assistant" ? (
                    <MessageMarkdown text={message.text} />
                  ) : message.text ? (
                    <p>{message.text}</p>
                  ) : null}
                  {(message.delivery === "failed" ||
                    message.delivery === "cancelled") && (
                    <span className="chat-message-delivery" role="status">
                      {
                        {
                          failed: "Delivery could not be confirmed",
                          cancelled: "Cancelled",
                        }[message.delivery]
                      }
                    </span>
                  )}
                  {outgoing[message.id] === "failed" && onRetryMessage && (
                    <Button
                      variant="ghost"
                      className="chat-reuse-message"
                      disabled={busy}
                      onClick={() => void onRetryMessage(message.id)}
                    >
                      Retry message
                    </Button>
                  )}
                  {message.role === "user" &&
                    message.delivery === "cancelled" &&
                    onRestoreDraft && (
                      <Button
                        variant="ghost"
                        className="chat-reuse-message"
                        onClick={() => onRestoreDraft(message.text)}
                      >
                        Use as draft
                      </Button>
                    )}
                  {message.attachments?.map((attachment) => (
                    <MessageAttachment
                      key={attachment.id}
                      attachment={attachment}
                      agentId={conversation!.agentId}
                    />
                  ))}
                  <MessageControls
                    message={message}
                    disabled={busy}
                    onReply={onReply}
                  />
                  {timestamp}
                </div>
              </article>
            </Fragment>
          );
        })}
        {anchoredHandoffs.get("")?.map((handoff) => (
          <ContextHandoff
            key={handoff.id}
            handoff={handoff}
            providers={providers}
          />
        ))}
        {running && (
          <div className="chat-working" role="status">
            {conversation?.activity === "compact"
              ? "Compacting context…"
              : conversation?.toolActivity
                ? toolProgress(conversation.toolActivity)
                : "Thinking…"}
          </div>
        )}
        {pending && (
          <ContextHandoff handoff={pending} providers={providers} pending />
        )}
        {conversation && onQueueUpdate && onContinue && (
          <ChatRecovery
            conversation={conversation}
            busy={busy}
            onUpdate={onQueueUpdate}
            onContinue={onContinue}
          />
        )}
        {failure && (
          <div className="chat-error" role="alert">
            {failure}
          </div>
        )}
      </div>
    </div>
  );
}
