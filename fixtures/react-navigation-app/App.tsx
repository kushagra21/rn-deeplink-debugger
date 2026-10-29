import { NavigationContainer } from "@react-navigation/native";
import { linking } from "./src/navigation/linking";
import { RootNavigator } from "./src/navigation/RootNavigator";

export default function App() {
  return (
    <NavigationContainer linking={linking}>
      <RootNavigator />
    </NavigationContainer>
  );
}
