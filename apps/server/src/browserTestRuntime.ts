import { browserHomeUrl } from "@paws/contracts";
import { launchAgentBrowser } from "./browserRuntime.ts";

// Browser integration tests keep the default home page off the public network.
export async function launchBrowserFixture(root: string, agentId: string) {
  const runtime = await launchAgentBrowser(root, agentId);
  await runtime.context.route(`${browserHomeUrl}**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<title>Google fixture</title><input aria-label="Search">',
    }),
  );

  return runtime;
}
