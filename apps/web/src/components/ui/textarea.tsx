// Adapted from T3 Code ui/textarea.tsx (MIT).
import { Field } from "@base-ui/react/field";
import { mergeProps } from "@base-ui/react/merge-props";
import type { ComponentProps } from "react";

export function Textarea(props: ComponentProps<"textarea">) {
  return (
    <Field.Control
      render={(fieldProps) => (
        <textarea data-slot="textarea" {...mergeProps(fieldProps, props)} />
      )}
    />
  );
}
