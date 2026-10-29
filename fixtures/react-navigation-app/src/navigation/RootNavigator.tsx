import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { Checkout, Feed, NotFound, Product, Profile, Settings } from "../screens";
import type { RootStackParamList } from "./types";

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator();

function HomeTabs() {
  return (
    <Tab.Navigator>
      <Tab.Screen name="Feed" component={Feed} />
      <Tab.Screen name="Settings" component={Settings} />
    </Tab.Navigator>
  );
}

export function RootNavigator() {
  return (
    <Stack.Navigator>
      <Stack.Screen name="HomeTabs" component={HomeTabs} options={{ headerShown: false }} />
      <Stack.Screen name="Product" component={Product} />
      <Stack.Screen name="Profile" component={Profile} />
      <Stack.Screen name="Checkout" component={Checkout} />
      <Stack.Screen name={"NotFound"} component={NotFound} />
    </Stack.Navigator>
  );
}
