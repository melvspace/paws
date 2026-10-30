import { Schema } from "effect";
import { withJsonRpc, type ProbeLaunch } from "@paws/provider-core/process";

const Login = Schema.Struct({
  loginId: Schema.String,
  verificationUrl: Schema.String,
  userCode: Schema.String,
});
const Completed = Schema.Struct({
  loginId: Schema.optional(Schema.NullOr(Schema.String)),
  success: Schema.Boolean,
});

export async function signInCodex(
  launch: ProbeLaunch,
  onUrl: (url: string, code?: string) => void,
) {
  await withJsonRpc(
    { ...launch, args: [...launch.args, "app-server", "--listen", "stdio://"] },
    async (rpc) => {
      await rpc.request("initialize", {
        clientInfo: { name: "paws", title: "Paws", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      rpc.notify("initialized");
      const completed = new Promise<typeof Completed.Type>(
        (resolve, reject) => {
          rpc.onNotification((method, params) => {
            if (method !== "account/login/completed") return;

            try {
              resolve(Schema.decodeUnknownSync(Completed)(params));
            } catch {
              reject(new Error("Invalid sign-in response."));
            }
          });
        },
      );
      const login = Schema.decodeUnknownSync(Login)(
        await rpc.request("account/login/start", { type: "chatgptDeviceCode" }),
      );
      onUrl(login.verificationUrl, login.userCode);
      const result = await completed;

      if (!result.success || result.loginId !== login.loginId)
        throw new Error("Sign-in did not complete.");
    },
  );
}
