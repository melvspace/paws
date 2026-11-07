import { useEffect, useState } from "react";
import type { EnvironmentState, PairingCode } from "@paws/contracts";
import { decidePairingRequest, loadEnvironments } from "@paws/client-runtime";
import { pairingQr } from "@paws/client-runtime/pairing";
import { QRCodeSVG } from "qrcode.react";
import { Button } from "../components/ui/button.tsx";

export function DevicePairing({
  state,
  pairing,
  onChange,
}: {
  state: EnvironmentState;
  pairing: typeof PairingCode.Type | null;
  onChange(state: EnvironmentState): void;
}) {
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let disposed = false;
    let active = false;
    const timer = setInterval(() => {
      setNow(Date.now());

      if (active) return;

      active = true;
      void loadEnvironments()
        .then((next) => {
          if (!disposed) onChange(next);
        })
        .catch(() => {
          if (!disposed)
            setError(
              "Could not check device requests. Reopen Sharing & access to retry.",
            );
        })
        .finally(() => {
          active = false;
        });
    }, 2000);

    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [onChange]);

  async function decide(id: string, decision: "approve" | "deny") {
    setPending(true);
    setError("");

    try {
      await decidePairingRequest(id, decision);
      onChange(await loadEnvironments());
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not update device access. Try again.",
      );
    } finally {
      setPending(false);
    }
  }

  const expired = pairing && Date.parse(pairing.expiresAt) <= now;

  return (
    <>
      {pairing && !expired && state.addresses.length > 0 && (
        <div className="environment-pairing-qr">
          <QRCodeSVG
            role="img"
            aria-label="Scan to pair with this computer"
            value={pairingQr({
              protocol: "paws-pair-v1",
              identity: state.local,
              addresses: state.addresses.slice(0, 16),
              ...pairing,
            })}
            size={288}
            marginSize={4}
            bgColor="#ffffff"
            fgColor="#202124"
            title="Scan to pair with this computer"
          />
          <p>On your phone, open Paws and tap Scan QR code.</p>
        </div>
      )}
      {expired && (
        <p role="status" className="environment-feedback">
          Pairing QR expired. Create a new code to scan again.
        </p>
      )}
      {!!state.pendingPairings?.length && (
        <div className="environment-rows" aria-label="Device pairing requests">
          {state.pendingPairings.map((request) => (
            <div key={request.id} className="environment-row">
              <span>
                {request.identity.name}
                <small>
                  Allow only if this code matches your phone:{" "}
                  <strong>{request.verificationCode}</strong>
                </small>
              </span>
              <div className="environment-page-actions">
                <Button
                  variant="ghost"
                  aria-label={`Deny ${request.identity.name}`}
                  disabled={pending}
                  onClick={() => void decide(request.id, "deny")}
                >
                  Deny
                </Button>
                <Button
                  variant="ghost"
                  aria-label={`Allow ${request.identity.name}`}
                  disabled={pending}
                  onClick={() => void decide(request.id, "approve")}
                >
                  Allow
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="environment-feedback">
          {error}
        </p>
      )}
    </>
  );
}
