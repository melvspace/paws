import { ChevronDownIcon } from "lucide-react";
import { Button } from "../components/ui/button.tsx";
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
} from "../components/ui/menu.tsx";
import { useChatPreferences } from "./chatPreferences.ts";
import { FollowUpModePicker } from "../workspace/FollowUpModePicker.tsx";

// T3 Code places this preference in Settings → Chat → Follow-ups.
export function ChatSettings() {
  const { followUpMode, setFollowUpMode, messageDisplay, setMessageDisplay } =
    useChatPreferences();

  return (
    <>
      <section aria-labelledby="messages-heading">
        <h3 id="messages-heading">Messages</h3>
        <div className="chat-settings-row">
          <div>
            <h4>Agent message display</h4>
            <p>
              Show each message when it is complete, or stream text as it is
              written.
            </p>
          </div>
          <Menu>
            <MenuTrigger
              render={<Button variant="outline" />}
              aria-label="Agent message display"
            >
              {messageDisplay === "whole" ? "Whole messages" : "Streaming"}
              <ChevronDownIcon size={14} aria-hidden />
            </MenuTrigger>
            <MenuPopup aria-label="Agent message display">
              <MenuRadioGroup
                value={messageDisplay}
                onValueChange={(value) => {
                  if (value === "whole" || value === "streaming")
                    setMessageDisplay(value);
                }}
              >
                <MenuRadioItem
                  value="whole"
                  className="ui-menu-radio-item"
                  closeOnClick
                >
                  Whole messages
                </MenuRadioItem>
                <MenuRadioItem
                  value="streaming"
                  className="ui-menu-radio-item"
                  closeOnClick
                >
                  Streaming
                </MenuRadioItem>
              </MenuRadioGroup>
            </MenuPopup>
          </Menu>
        </div>
      </section>
      <section aria-labelledby="follow-ups-heading">
        <h3 id="follow-ups-heading">Follow-ups</h3>
        <div className="chat-settings-row">
          <div>
            <h4>Follow-up behavior</h4>
            <p>
              Steer the current turn or queue messages until it finishes.
              Providers without steering support use the queue.
            </p>
            <p>
              Ctrl/Cmd+Enter uses the other mode for one message. Shift+Enter
              adds a newline.
            </p>
          </div>
          <FollowUpModePicker value={followUpMode} onChange={setFollowUpMode} />
        </div>
      </section>
    </>
  );
}
