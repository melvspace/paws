import { createContext, useContext, type ReactNode } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from "react-native";

export const light = {
  background: "#f7f7f6",
  surface: "#ffffff",
  text: "#202124",
  muted: "#686a70",
  line: "#dedfe2",
  accent: "#2563eb",
  danger: "#c52c38",
};
export const dark: typeof light = {
  background: "#171719",
  surface: "#222225",
  text: "#f1f1f2",
  muted: "#a3a3ac",
  line: "#38383d",
  accent: "#8ab4ff",
  danger: "#ff929c",
};
export const Palette = createContext(light);
export const usePalette = () => useContext(Palette);

export function Button({
  children,
  onPress,
  disabled = false,
  subtle = false,
  danger = false,
}: {
  children: string;
  onPress(): void;
  disabled?: boolean;
  subtle?: boolean;
  danger?: boolean;
}) {
  const colors = usePalette();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: subtle ? "transparent" : colors.accent,
          opacity: disabled ? 0.4 : pressed ? 0.65 : 1,
        },
      ]}
    >
      <Text
        style={{
          color: danger
            ? colors.danger
            : subtle
              ? colors.accent
              : colors.background,
          fontWeight: "600",
          fontSize: 15,
        }}
      >
        {children}
      </Text>
    </Pressable>
  );
}

export function Label({ children }: { children: ReactNode }) {
  const colors = usePalette();

  return (
    <Text style={[styles.label, { color: colors.muted }]}>{children}</Text>
  );
}

export function Field({ label, ...props }: TextInputProps & { label: string }) {
  const colors = usePalette();

  return (
    <View style={styles.field}>
      <Label>{label}</Label>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={colors.muted}
        {...props}
        style={[
          styles.input,
          {
            color: colors.text,
            borderColor: colors.line,
            backgroundColor: colors.surface,
          },
          props.style,
        ]}
      />
    </View>
  );
}

export function Notice({
  text,
  error = false,
}: {
  text: string;
  error?: boolean;
}) {
  const colors = usePalette();

  return (
    <Text
      accessibilityRole={error ? "alert" : "text"}
      accessibilityLiveRegion="polite"
      style={[styles.notice, { color: error ? colors.danger : colors.muted }]}
    >
      {text}
    </Text>
  );
}

export const styles = StyleSheet.create({
  page: { flex: 1, padding: 20 },
  content: { padding: 20, gap: 16 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  between: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  title: { fontSize: 28, fontWeight: "700", letterSpacing: -0.8 },
  heading: { fontSize: 18, fontWeight: "600" },
  label: { fontSize: 13, fontWeight: "500" },
  field: { gap: 8 },
  input: { borderWidth: 1, borderRadius: 10, padding: 12, fontSize: 16 },
  button: {
    minHeight: 44,
    paddingHorizontal: 14,
    justifyContent: "center",
    alignItems: "center",
    borderRadius: 10,
  },
  notice: { paddingVertical: 10, fontSize: 14, lineHeight: 21 },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth },
});
