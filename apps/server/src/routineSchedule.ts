import { CronExpressionParser } from "cron-parser";
import type {
  RoutineFilter,
  RoutineFilterGroup,
  RoutineTrigger,
} from "@paws/contracts";

export function validateTrigger(trigger: RoutineTrigger) {
  if (trigger.kind === "once" && !Number.isFinite(Date.parse(trigger.at)))
    throw new Error("Choose a valid execution time.");

  if (
    trigger.kind === "interval" &&
    (!Number.isInteger(trigger.minutes) ||
      trigger.minutes < 1 ||
      trigger.minutes > 525600)
  )
    throw new Error("Use an interval of 1–525600 minutes.");

  if (trigger.kind === "cron") {
    new Intl.DateTimeFormat("en", { timeZone: trigger.timezone });

    if (
      trigger.expression.trim().split(/\s+/).length !== 5 ||
      /[H?]/.test(trigger.expression)
    )
      throw new Error("Use a deterministic five-field cron expression.");

    CronExpressionParser.parse(trigger.expression, {
      tz: trigger.timezone,
    }).next();
  }

  if (trigger.kind === "webhook") {
    let filters = 0;
    let groups = 0;

    function validateGroup(group: RoutineFilterGroup, depth: number) {
      groups += 1;

      if (depth > 4 || groups > 20)
        throw new Error(
          "Use up to 20 filter groups nested at most five levels deep.",
        );

      for (const rule of group.rules) {
        if ("rules" in rule) {
          validateGroup(rule, depth + 1);
        } else {
          filters += 1;

          if (filters > 20 || !/^[a-zA-Z0-9_.-]{1,200}$/.test(rule.path))
            throw new Error(
              "Use up to 20 JSON field filters with dot-separated paths.",
            );
        }
      }
    }

    validateGroup(trigger.filters, 0);
  }
}

export function nextRoutineTime(
  trigger: RoutineTrigger,
  after: number,
): string | null {
  if (trigger.kind === "webhook") return null;
  if (trigger.kind === "once")
    return Date.parse(trigger.at) > after
      ? new Date(trigger.at).toISOString()
      : null;
  if (trigger.kind === "interval")
    return new Date(after + trigger.minutes * 60000).toISOString();

  const expression = CronExpressionParser.parse(trigger.expression, {
    currentDate: after,
    tz: trigger.timezone,
  });
  const date = expression.next();
  // cron-parser shifts a nonexistent local hour forward. Require the resulting
  // local hour/minute to match the expression so that DST gaps are skipped.
  const fields = expression.fields;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: trigger.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date.toDate());
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);

  if (
    !fields.hour.values.some((value) => value === hour) ||
    !fields.minute.values.some((value) => value === minute)
  )
    return nextRoutineTime(trigger, date.toDate().getTime());

  return date.toISOString();
}

export function matchesRoutineEvent(
  trigger: Extract<RoutineTrigger, { kind: "webhook" }>,
  payload: unknown,
) {
  const field = (path: string) =>
    path
      .split(".")
      .reduce<unknown>(
        (value, key) =>
          value && typeof value === "object" && Object.hasOwn(value, key)
            ? Reflect.get(value, key)
            : undefined,
        payload,
      );

  function matches(filter: RoutineFilter | RoutineFilterGroup): boolean {
    if ("rules" in filter)
      return filter.combinator === "and"
        ? filter.rules.every(matches)
        : filter.rules.some(matches);

    const value = field(filter.path);

    if (filter.operator === "exists") return value !== undefined;
    if (filter.operator === "in")
      return (filter.value ?? "")
        .split(",")
        .map((item) => item.trim())
        .includes(String(value));

    return String(value) === filter.value;
  }

  return matches(trigger.filters);
}

export function advanceRoutineTime(
  trigger: RoutineTrigger,
  due: number,
  now: number,
) {
  if (trigger.kind === "interval") {
    const interval = trigger.minutes * 60000;

    return new Date(
      due + (Math.floor((now - due) / interval) + 1) * interval,
    ).toISOString();
  }

  return nextRoutineTime(trigger, now);
}
