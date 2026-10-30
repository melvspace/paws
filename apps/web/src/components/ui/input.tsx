import { Input as InputPrimitive } from "@base-ui/react/input";

export function Input(props: InputPrimitive.Props) {
  return <InputPrimitive data-slot="input" {...props} />;
}
