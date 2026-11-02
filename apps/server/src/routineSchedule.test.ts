import { Schema } from "effect";
import { RoutineTrigger, type RoutineFilterGroup } from "@paws/contracts";
import { expect, it } from "vite-plus/test";
import { matchesRoutineEvent, validateTrigger } from "./routineSchedule.ts";

const filters: RoutineFilterGroup = {
  combinator: "or",
  rules: [
    {
      combinator: "and",
      rules: [
        { path: "repo", operator: "equals", value: "paws" },
        {
          combinator: "or",
          rules: [
            { path: "branch", operator: "in", value: "main, release" },
            { path: "release", operator: "exists" },
          ],
        },
      ],
    },
    { path: "manual", operator: "equals", value: "true" },
  ],
};

it.each([
  [{ repo: "paws", branch: "main" }, true],
  [{ repo: "paws", branch: "release" }, true],
  [{ repo: "paws", release: false }, true],
  [{ repo: "paws", branch: "feature" }, false],
  [{ repo: "other", branch: "main" }, false],
  [{ repo: "other", manual: true }, true],
  [{}, false],
])("evaluates nested AND/OR groups for %j", (payload, expected) => {
  const trigger = { kind: "webhook", filters } as const;
  const decoded = Schema.decodeUnknownSync(RoutineTrigger)(trigger);
  expect(decoded).toEqual(trigger);
  validateTrigger(trigger);
  expect(matchesRoutineEvent(trigger, payload)).toBe(expected);
});

it("uses Boolean identities for empty groups", () => {
  expect(
    matchesRoutineEvent(
      { kind: "webhook", filters: { combinator: "and", rules: [] } },
      {},
    ),
  ).toBe(true);
  expect(
    matchesRoutineEvent(
      { kind: "webhook", filters: { combinator: "or", rules: [] } },
      {},
    ),
  ).toBe(false);
});

it("rejects invalid paths and limits the whole tree's depth, groups, and conditions", () => {
  const leaf = { path: "repo", operator: "exists" } as const;
  const validate = (group: RoutineFilterGroup) =>
    validateTrigger({ kind: "webhook", filters: group });
  expect(() =>
    validate({
      combinator: "and",
      rules: Array.from({ length: 20 }, () => leaf),
    }),
  ).not.toThrow();
  expect(() =>
    validate({
      combinator: "or",
      rules: [
        { combinator: "and", rules: Array.from({ length: 20 }, () => leaf) },
        leaf,
      ],
    }),
  ).toThrow("20 JSON field filters");
  expect(() =>
    validate({
      combinator: "and",
      rules: [{ combinator: "or", rules: [{ ...leaf, path: "" }] }],
    }),
  ).toThrow("dot-separated paths");
  expect(() =>
    validate({
      combinator: "and",
      rules: Array.from({ length: 20 }, () => ({
        combinator: "or",
        rules: [],
      })),
    }),
  ).toThrow("20 filter groups");
  let deep: RoutineFilterGroup = { combinator: "and", rules: [leaf] };

  for (let index = 0; index < 4; index += 1)
    deep = { combinator: "or", rules: [deep] };

  expect(() => validate(deep)).not.toThrow();
  expect(() => validate({ combinator: "and", rules: [deep] })).toThrow(
    "five levels",
  );
});

it("rejects malformed group data at the contract boundary", () => {
  const decode = Schema.decodeUnknownSync(RoutineTrigger);
  expect(() => decode({ kind: "webhook", filters: [] })).toThrow();
  expect(() =>
    decode({ kind: "webhook", filters: { combinator: "xor", rules: [] } }),
  ).toThrow();
  expect(() =>
    decode({
      kind: "webhook",
      filters: {
        combinator: "or",
        rules: [
          { combinator: "and", rules: [{ path: "repo", operator: "invalid" }] },
        ],
      },
    }),
  ).toThrow();
});
