import { useId, useState } from "react";
import { validRoutineFilterPath } from "./routineValidation.ts";
import { Select } from "@base-ui/react/select";
import type { RoutineFilterGroup } from "@paws/contracts";
import {
  CheckIcon,
  ChevronDownIcon,
  ListFilterIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import {
  QueryBuilder,
  type ActionProps,
  type CombinatorSelectorProps,
  type FieldSelectorProps,
  type OperatorSelectorProps,
  type RuleGroupType,
  type ValueEditorProps,
} from "react-querybuilder";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";

// A named field keeps the freeform selector visible even when every path is empty.
const fields = [{ name: "path", label: "Field" }];

const operators = [
  { name: "equals", value: "equals", label: "equals" },
  { name: "in", value: "in", label: "is one of" },
  { name: "exists", value: "exists", label: "exists", arity: "unary" as const },
];

function FieldEditor({
  value,
  handleOnChange,
  disabled,
  context,
}: FieldSelectorProps) {
  const id = useId();
  const [touched, setTouched] = useState(false);
  const invalid =
    (touched || context?.showErrors === true) &&
    !validRoutineFilterPath(value ?? "");

  return (
    <label className="routine-condition-path">
      <span>Field</span>
      <Input
        className="routine-condition-field"
        aria-label="Field"
        aria-invalid={invalid}
        aria-describedby={invalid ? id : undefined}
        onBlur={() => setTouched(true)}
        value={value}
        disabled={disabled}
        onChange={(event) => handleOnChange(event.target.value)}
      />
      {invalid && (
        <span className="routine-field-error" id={id} role="alert">
          {value
            ? "Use 1–200 letters, numbers, dots, underscores, or hyphens."
            : "Enter a JSON field path."}
        </span>
      )}
    </label>
  );
}

function OperatorSelector({
  value,
  handleOnChange,
  disabled,
}: OperatorSelectorProps) {
  return (
    <Select.Root
      value={value}
      onValueChange={(next) => {
        if (next) handleOnChange(next);
      }}
      disabled={disabled}
      items={operators}
    >
      <Select.Trigger
        className="routine-condition-operator"
        aria-label="Condition"
      >
        <Select.Value />
        <ChevronDownIcon size={12} aria-hidden />
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner className="ui-popover-positioner" sideOffset={4}>
          <Select.Popup className="routine-condition-menu">
            {operators.map((operator) => (
              <Select.Item
                className="routine-condition-option"
                key={operator.value}
                value={operator.value}
              >
                <Select.ItemText>{operator.label}</Select.ItemText>
                <Select.ItemIndicator>
                  <CheckIcon size={13} aria-hidden />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

function ValueEditor({
  operator,
  value,
  handleOnChange,
  disabled,
}: ValueEditorProps) {
  if (operator === "exists") return null;

  return (
    <label>
      <span>{operator === "in" ? "Values, comma-separated" : "Value"}</span>
      <Input
        value={typeof value === "string" ? value : ""}
        disabled={disabled}
        onChange={(event) => handleOnChange(event.target.value)}
      />
    </label>
  );
}

function AddCondition({ handleOnClick, disabled }: ActionProps) {
  return (
    <Button variant="ghost" onClick={handleOnClick} disabled={disabled}>
      <PlusIcon size={13} aria-hidden />
      Add filter
    </Button>
  );
}

function RemoveCondition({ handleOnClick, path, disabled }: ActionProps) {
  return (
    <Button
      variant="ghost"
      className="routine-condition-remove"
      aria-label={`Remove filter ${path.map((index) => index + 1).join(".")}`}
      onClick={handleOnClick}
      disabled={disabled}
    >
      <XIcon size={14} aria-hidden />
    </Button>
  );
}

function CombinatorSelector({
  value,
  handleOnChange,
  disabled,
}: CombinatorSelectorProps) {
  return (
    <div
      className="routine-condition-match"
      role="group"
      aria-label="Match conditions"
    >
      <ListFilterIcon size={13} aria-hidden />
      {["and", "or"].map((combinator) => (
        <Button
          key={combinator}
          variant="ghost"
          aria-pressed={value === combinator}
          disabled={disabled}
          onClick={() => handleOnChange(combinator)}
          title={
            combinator === "and"
              ? "Match all conditions"
              : "Match any condition"
          }
        >
          {combinator.toUpperCase()}
        </Button>
      ))}
    </div>
  );
}

function AddGroup({ handleOnClick, disabled }: ActionProps) {
  return (
    <Button variant="ghost" onClick={handleOnClick} disabled={disabled}>
      <PlusIcon size={13} aria-hidden />
      Add group
    </Button>
  );
}

function RemoveGroup({ handleOnClick, path, disabled }: ActionProps) {
  return (
    <Button
      variant="ghost"
      className="routine-condition-remove-group"
      aria-label={`Remove group ${path.map((index) => index + 1).join(".")}`}
      onClick={handleOnClick}
      disabled={disabled}
    >
      <XIcon size={14} aria-hidden />
    </Button>
  );
}

function toQuery(group: RoutineFilterGroup, id = "filters"): RuleGroupType {
  return {
    id,
    combinator: group.combinator,
    rules: group.rules.map((rule, index) => {
      const ruleId = `${id}.${index}`;

      return "rules" in rule
        ? toQuery(rule, ruleId)
        : {
            id: ruleId,
            field: rule.path,
            operator: rule.operator,
            value: rule.value ?? "",
          };
    }),
  };
}

function fromQuery(query: RuleGroupType): RoutineFilterGroup {
  return {
    combinator: query.combinator === "or" ? "or" : "and",
    rules: query.rules.map((rule) => {
      if ("rules" in rule) return fromQuery(rule);

      return {
        path: rule.field,
        operator:
          rule.operator === "exists"
            ? "exists"
            : rule.operator === "in"
              ? "in"
              : "equals",
        value: typeof rule.value === "string" ? rule.value : "",
      };
    }),
  };
}

function needsCommit(
  previous: RoutineFilterGroup,
  next: RoutineFilterGroup,
): boolean {
  if (
    previous.combinator !== next.combinator ||
    next.rules.length < previous.rules.length
  )
    return true;

  return next.rules.some((rule, index) => {
    const old = previous.rules[index];

    if (!old) return false;
    if ("rules" in rule) return "rules" in old && needsCommit(old, rule);

    return !("rules" in old) && old.operator !== rule.operator;
  });
}

const controls = {
  fieldSelector: FieldEditor,
  operatorSelector: OperatorSelector,
  valueEditor: ValueEditor,
  combinatorSelector: CombinatorSelector,
  addRuleAction: AddCondition,
  removeRuleAction: RemoveCondition,
  addGroupAction: AddGroup,
  removeGroupAction: RemoveGroup,
};

export function RoutineConditionBuilder({
  filters,
  onChange,
  onCommit,
  showErrors = false,
}: {
  filters: RoutineFilterGroup;
  onChange: (filters: RoutineFilterGroup) => void;
  onCommit: () => void;
  showErrors?: boolean;
}) {
  return (
    <div className="routine-condition-builder" onBlur={onCommit}>
      <QueryBuilder
        query={toQuery(filters)}
        fields={fields}
        operators={operators}
        controlElements={controls}
        context={{ showErrors }}
        onAddRule={(rule) => ({ ...rule, field: "" })}
        getDefaultOperator="equals"
        getDefaultValue={() => ""}
        addRuleToNewGroups={false}
        maxLevels={4}
        enableMountQueryChange={false}
        resetOnFieldChange={false}
        resetOnOperatorChange={false}
        onQueryChange={(next: RuleGroupType) => {
          const updated = fromQuery(next);
          onChange(updated);

          if (needsCommit(filters, updated)) onCommit();
        }}
      />
    </div>
  );
}
