// Native MCP capability supplied by the selected provider adapter.
export interface McpHarnessClient {
  request(
    input: {
      action: "tools" | "call";
      tool?: string | undefined;
      arguments?: Readonly<Record<string, unknown>> | undefined;
    },
    signal: AbortSignal,
  ): Promise<unknown>;
  authenticate(
    onAuthorization: (url: string) => void,
    callback: Promise<string>,
    signal: AbortSignal,
  ): Promise<void>;
}
