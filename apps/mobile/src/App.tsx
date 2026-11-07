import {
  NavigationContainer,
  DarkTheme,
  DefaultTheme,
} from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar, useColorScheme } from "react-native";
import { AgentScreen, CreateAgentScreen } from "./AgentScreen.tsx";
import { ChatScreen } from "./ChatScreen.tsx";
import { ConnectionScreen } from "./ConnectionScreen.tsx";
import { AgentSettingsScreen, SettingsScreen } from "./SettingsScreen.tsx";
import { Button, Notice, Palette, dark, light } from "./ui.tsx";
import { useWorkspace } from "./useWorkspace.ts";

export type Routes = {
  Agents: undefined;
  Chat: { agentId: string };
  Create: undefined;
  Settings: undefined;
  AgentSettings: { agentId: string };
};
const Stack = createNativeStackNavigator<Routes>();

export default function App() {
  const workspace = useWorkspace();
  const isDark = useColorScheme() === "dark";
  const colors = isDark ? dark : light;
  const theme = {
    ...(isDark ? DarkTheme : DefaultTheme),
    colors: {
      ...(isDark ? DarkTheme : DefaultTheme).colors,
      background: colors.background,
      card: colors.background,
      text: colors.text,
      border: colors.line,
      primary: colors.accent,
    },
  };

  return (
    <SafeAreaProvider>
      <Palette.Provider value={colors}>
        <StatusBar barStyle={isDark ? "light-content" : "dark-content"} />
        {workspace.restoring ? (
          <SafeAreaView
            style={{ flex: 1, padding: 24, backgroundColor: colors.background }}
          >
            <Notice text="Opening Paws…" />
          </SafeAreaView>
        ) : workspace.connection ? (
          <NavigationContainer theme={theme}>
            <Stack.Navigator
              screenOptions={{
                contentStyle: { backgroundColor: colors.background },
              }}
            >
              <Stack.Screen
                name="Agents"
                options={({ navigation }) => ({
                  title: "Paws",
                  headerRight: () => (
                    <Button
                      subtle
                      onPress={() => navigation.navigate("Settings")}
                    >
                      Settings
                    </Button>
                  ),
                })}
              >
                {(props) => <AgentScreen {...props} workspace={workspace} />}
              </Stack.Screen>
              <Stack.Screen name="Chat" options={{ title: "Chat" }}>
                {(props) => (
                  <SafeAreaView edges={["bottom"]} style={{ flex: 1 }}>
                    <ChatScreen {...props} workspace={workspace} />
                  </SafeAreaView>
                )}
              </Stack.Screen>
              <Stack.Screen
                name="Create"
                options={{ title: "New agent", presentation: "modal" }}
              >
                {(props) => (
                  <CreateAgentScreen {...props} workspace={workspace} />
                )}
              </Stack.Screen>
              <Stack.Screen
                name="Settings"
                options={{ title: "Settings", presentation: "modal" }}
              >
                {() => <SettingsScreen workspace={workspace} />}
              </Stack.Screen>
              <Stack.Screen
                name="AgentSettings"
                options={{ title: "Agent settings", presentation: "modal" }}
              >
                {(props) => (
                  <AgentSettingsScreen {...props} workspace={workspace} />
                )}
              </Stack.Screen>
            </Stack.Navigator>
          </NavigationContainer>
        ) : (
          <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
            <ConnectionScreen workspace={workspace} />
          </SafeAreaView>
        )}
      </Palette.Provider>
    </SafeAreaProvider>
  );
}
