import { useEffect, useRef, useState } from "react";
import {
  BackHandler,
  KeyboardAvoidingView,
  Linking,
  Platform,
  ScrollView,
  Text,
  View,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { pairRemote } from "@paws/client-runtime/remote";
import { Button, Field, Label, Notice, styles, usePalette } from "./ui.tsx";
import { usePairing } from "./usePairing.ts";
import { errorText, type Workspace } from "./useWorkspace.ts";

export function ConnectionScreen({ workspace }: { workspace: Workspace }) {
  const colors = usePalette();
  const pairing = usePairing(workspace);
  const [scanning, setScanning] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const scanned = useRef(false);
  const [advanced, setAdvanced] = useState(false);
  const [address, setAddress] = useState("");
  const [token, setToken] = useState("");
  const [manualBusy, setManualBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = pairing.busy || manualBusy;

  useEffect(() => {
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      if (busy) return true;

      if (scanning) setScanning(false);
      else if (pairing.pending) pairing.cancel();
      else if (pairing.offer) pairing.clearOffer();
      else return false;

      return true;
    });

    return () => back.remove();
  }, [
    busy,
    scanning,
    pairing.pending,
    pairing.offer,
    pairing.cancel,
    pairing.clearOffer,
  ]);

  async function connect() {
    setManualBusy(true);
    setError(null);

    try {
      const connection = await pairRemote(address, token);
      await workspace.connect(connection);
      setToken("");
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setManualBusy(false);
    }
  }

  const failure = error ?? pairing.error ?? workspace.error;

  if (scanning) {
    return (
      <View style={[styles.page, { gap: 16 }]}>
        <Text style={[styles.title, { color: colors.text }]}>
          Scan pairing QR
        </Text>
        <Notice text="On your computer, open Settings → Sharing & access → Show pairing QR." />
        {permission?.granted && pairing.foreground ? (
          <CameraView
            style={{ flex: 1, borderRadius: 16, overflow: "hidden" }}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onMountError={() =>
              setError(
                "Camera unavailable. Check camera access in Android settings, or use nearby computer pairing.",
              )
            }
            onBarcodeScanned={({ data }) => {
              if (scanned.current) return;

              scanned.current = true;
              pairing.readQr(data);
              setScanning(false);
            }}
          />
        ) : (
          <View style={{ flex: 1, justifyContent: "center", gap: 12 }}>
            <Notice text="Allow camera access to scan the QR code on your computer." />
            <Button
              onPress={() => {
                if (permission?.canAskAgain === false) {
                  void Linking.openSettings().catch(() =>
                    setError(
                      "Open Android settings and allow camera access for Paws.",
                    ),
                  );
                } else {
                  void requestPermission().catch(() =>
                    setError(
                      "Could not request camera access. Use Android settings to allow it.",
                    ),
                  );
                }
              }}
            >
              {permission?.canAskAgain === false
                ? "Open camera settings"
                : "Allow camera"}
            </Button>
          </View>
        )}
        {error && <Notice text={error} error />}
        <Button subtle onPress={() => setScanning(false)}>
          Cancel
        </Button>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        contentContainerStyle={[styles.content, { flexGrow: 1 }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ gap: 12, marginTop: 32, marginBottom: 12 }}>
          <Text style={[styles.title, { color: colors.text, fontSize: 42 }]}>
            Paws
          </Text>
          <Text style={{ color: colors.muted, fontSize: 16, lineHeight: 24 }}>
            Connect to your computer.
          </Text>
        </View>
        {pairing.pending ? (
          <>
            <Text style={[styles.heading, { color: colors.text }]}>
              {pairing.pending.peer.name}
            </Text>
            <Text
              selectable
              style={{
                color: colors.text,
                fontSize: 36,
                fontWeight: "600",
                letterSpacing: 6,
              }}
            >
              {pairing.pending.ticket.verificationCode}
            </Text>
            <Notice text="On your computer, open Settings → Sharing & access. Check that this code matches, then tap Allow." />
            <Button subtle onPress={pairing.cancel}>
              Cancel request
            </Button>
          </>
        ) : pairing.offer ? (
          <>
            <Text style={[styles.heading, { color: colors.text }]}>
              {pairing.offer.identity.name}
            </Text>
            <Notice text="Pair with this computer?" />
            <Button disabled={busy} onPress={() => void pairing.confirmQr()}>
              {busy ? "Connecting…" : "Connect"}
            </Button>
            <Button subtle disabled={busy} onPress={pairing.clearOffer}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button
              disabled={busy}
              onPress={() => {
                scanned.current = false;
                setScanning(true);
              }}
            >
              Scan QR code
            </Button>
            <View style={[styles.between, { marginTop: 16 }]}>
              <Label>Nearby computers</Label>
              <Button
                subtle
                disabled={busy || pairing.searching}
                onPress={() => void pairing.scan()}
              >
                {pairing.searching ? "Searching…" : "Discover"}
              </Button>
            </View>
            {pairing.peers.map((peer) => (
              <View
                key={peer.id}
                style={[
                  styles.between,
                  styles.divider,
                  { borderColor: colors.line, paddingVertical: 12 },
                ]}
              >
                <Text style={[styles.heading, { color: colors.text, flex: 1 }]}>
                  {peer.name}
                </Text>
                <Button
                  subtle
                  disabled={busy}
                  onPress={() => void pairing.request(peer)}
                >
                  Connect
                </Button>
              </View>
            ))}
            {pairing.searched &&
              !pairing.searching &&
              !pairing.peers.length && (
                <Notice text="No computers found. Connect to the same Wi-Fi and turn on Settings → Sharing & access on your computer, or scan its pairing QR." />
              )}
            <Button
              subtle
              disabled={busy}
              onPress={() => setAdvanced((value) => !value)}
            >
              {advanced ? "Hide advanced connection" : "Advanced connection"}
            </Button>
            {advanced && (
              <>
                <Field
                  label="HTTPS gateway address"
                  value={address}
                  onChangeText={setAddress}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  editable={!busy}
                />
                <Field
                  label="Connection token"
                  value={token}
                  onChangeText={setToken}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!busy}
                />
                <Button
                  disabled={busy || !address.trim() || !token.trim()}
                  onPress={() => void connect()}
                >
                  {manualBusy ? "Connecting…" : "Connect to gateway"}
                </Button>
              </>
            )}
          </>
        )}
        {failure && <Notice text={failure} error />}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
