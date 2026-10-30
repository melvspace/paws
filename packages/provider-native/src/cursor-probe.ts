import { Cursor, FileCredentialStore } from "@cursor/sdk";
import { cursorModel } from "./sdk.ts";

try {
  const saved = await new FileCredentialStore(
    process.env.PAWS_CURSOR_AUTH_FILE,
  ).load();
  const apiKey = process.env.CURSOR_API_KEY || saved?.apiKey;

  if (!apiKey) {
    process.stdout.write(
      JSON.stringify({ auth: "unauthenticated", models: [] }),
    );
  } else {
    const models = await Cursor.models.list({ apiKey });
    process.stdout.write(
      JSON.stringify({
        auth: "authenticated",
        models: models.map(cursorModel),
      }),
    );
  }
} catch (error) {
  if (error instanceof Error && error.name === "AuthenticationError") {
    process.stdout.write(
      JSON.stringify({ auth: "unauthenticated", models: [] }),
    );
  } else {
    process.exitCode = 1;
  }
}
