import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../test/render.tsx";
import { MessageAttachment } from "./MessageAttachment.tsx";
import "./chat.css";

it("renders media controls and named document downloads without overflowing narrow messages", async () => {
  const files = [
    { id: "video", name: "Demo.mp4", mediaType: "video/mp4", size: 2097152 },
    { id: "audio", name: "Recording.mp3", mediaType: "audio/mpeg", size: 2048 },
    { id: "pdf", name: "Report.pdf", mediaType: "application/pdf", size: 1024 },
    {
      id: "source",
      name: "render-script-with-a-very-long-name.py",
      mediaType: "application/octet-stream",
      size: 40,
    },
  ];
  await using _screen = await render(
    <div style={{ width: 260 }}>
      {files.map((attachment) => (
        <MessageAttachment
          key={attachment.id}
          attachment={attachment}
          agentId="agent"
        />
      ))}
    </div>,
  );
  expect(document.querySelector("video")?.controls).toBe(true);
  expect(document.querySelector("video")?.autoplay).toBe(false);
  expect(document.querySelector("audio")?.controls).toBe(true);
  await expect
    .element(page.getByRole("link", { name: "Report.pdf 1 KB" }))
    .toHaveAttribute("download", "Report.pdf");
  await expect
    .element(page.getByRole("link", { name: "Demo.mp4 2.0 MB" }))
    .toHaveAttribute("href", "/api/agents/agent/chat/attachments/video");

  for (const element of document.querySelectorAll(".chat-attachment"))
    expect(element.getBoundingClientRect().width).toBeLessThanOrEqual(260);

  document.querySelector("video")!.dispatchEvent(new Event("error"));
  await expect
    .element(
      page
        .getByText("Preview unavailable. Download the file to open it.")
        .first(),
    )
    .toBeVisible();
});
