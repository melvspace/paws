// A bounded SSE reader with owned cancellation (the SDK reader leaves cancel rejections unhandled).
export async function openEventStream(
  url: URL,
  headers: Record<string, string>,
  signal: AbortSignal,
) {
  const response = await fetch(url, { headers, signal });

  if (!response.ok || !response.body)
    throw new Error("Provider event stream unavailable");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
      let buffer = "";

      try {
        while (!signal.aborted) {
          const chunk = await reader.read();

          if (chunk.done) break;

          buffer += decoder
            .decode(chunk.value, { stream: true })
            .replaceAll("\r\n", "\n");

          if (buffer.length > 4 * 1024 * 1024)
            throw new Error("Provider event exceeded limit");

          let end = buffer.indexOf("\n\n");

          while (end >= 0) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = frame
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");

            if (data) yield JSON.parse(data);

            end = buffer.indexOf("\n\n");
          }
        }
      } catch (error) {
        if (!signal.aborted) throw error;
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    },
  };
}
