// T3 Code uses one app registry shared by the transport and React bindings.
import { AtomRegistry } from "effect/reactivity";

export const appAtomRegistry = AtomRegistry.make();
