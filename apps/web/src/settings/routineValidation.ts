import type { RoutineFilterGroup, SaveRoutine } from "@paws/contracts";

export type RoutineField =
  | "name"
  | "instruction"
  | "timeoutMinutes"
  | "minutes"
  | "at"
  | "expression"
  | "timezone"
  | "filters";

export function routineValidation(draft: SaveRoutine) {
  const errors: Partial<Record<RoutineField, string>> = {};

  if (!draft.name.trim()) errors.name = "Enter a name.";
  else if (draft.name.length > 80) errors.name = "Use at most 80 characters.";

  if (!draft.instruction.trim()) errors.instruction = "Enter an instruction.";
  else if (draft.instruction.length > 32000)
    errors.instruction = "Use at most 32,000 characters.";

  if (
    !Number.isInteger(draft.timeoutMinutes) ||
    draft.timeoutMinutes < 1 ||
    draft.timeoutMinutes > 1440
  )
    errors.timeoutMinutes = "Use a whole number from 1 to 1,440.";

  const trigger = draft.trigger;

  if (
    trigger.kind === "interval" &&
    (!Number.isInteger(trigger.minutes) ||
      trigger.minutes < 1 ||
      trigger.minutes > 525600)
  )
    errors.minutes = "Use a whole number from 1 to 525,600.";

  if (trigger.kind === "once" && !Number.isFinite(Date.parse(trigger.at)))
    errors.at = "Choose a valid date and time.";

  if (trigger.kind === "cron") {
    if (
      trigger.expression.trim().split(/\s+/).length !== 5 ||
      /[H?]/.test(trigger.expression)
    )
      errors.expression = "Enter a deterministic five-field cron expression.";

    try {
      new Intl.DateTimeFormat("en", { timeZone: trigger.timezone });
    } catch {
      errors.timezone = "Enter a valid timezone.";
    }
  }

  if (trigger.kind === "webhook") {
    let conditions = 0;
    let groups = 0;

    function check(group: RoutineFilterGroup, depth: number) {
      groups += 1;

      if (depth > 4 || groups > 20) {
        errors.filters = "Use up to 20 groups nested at most five levels deep.";

        return;
      }

      for (const rule of group.rules) {
        if ("rules" in rule) {
          check(rule, depth + 1);
        } else {
          conditions += 1;

          if (!validRoutineFilterPath(rule.path))
            errors.filters ??= "Correct the highlighted filter fields.";
        }
      }
    }

    check(trigger.filters, 0);

    if (conditions > 20) errors.filters = "Use up to 20 filter conditions.";
  }

  return errors;
}

export function validRoutineFilterPath(path: string) {
  return /^[a-zA-Z0-9_.-]{1,200}$/.test(path);
}
