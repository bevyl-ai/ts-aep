/**
 * Integrity checks for the output-module rules tables.
 *
 * These tests make the clamp/sync bypass writes safe: values written
 * outside the descriptors (depth pairing, singleton clamps) are proven to
 * stay inside the tables, so re-validation on the bypass path is never
 * needed.
 */

import { expect, test } from "bun:test";
import {
  _CONDITIONAL_RULES,
  _FORMAT_RULES,
  _KIND_RULES,
  allowedValues,
  type Constraints,
  type RuleValue,
} from "../../src/py_aep/data/output_module_rules.ts";
import { AudioChannels, AudioCodec, FormatKind, OutputAudio, OutputChannels, OutputColorDepth, OutputColorMode, OutputFormat } from "../../src/py_aep/enums/index.ts";
import { _DEPTH_MINUS, _DEPTH_PLUS, OM_SETTINGS } from "../../src/py_aep/models/renderqueue/output_module.ts";
import {
  dictGet,
  getitem,
  int,
  pyAssert,
  pyBool,
  pyEq,
  pyOr,
  repr,
  sorted,
} from "../../src/pyrt/index.ts";

// Context keys the OutputModule._rules_context builder can provide.
const _CONDITION_KEYS = new Set([
  "Channels",
  "Audio Channels",
  "Audio Sample Rate",
  "Audio Codec",
  "Video Codec",
  "Audio Format",
  "Audio Layer",
  "Multiplexer",
  "BitRate",
]);

// Keys a rule may constrain: OM settings plus format-option fields.
const _FO_CONSTRAINT_KEYS = new Set([
  "Audio Bitrate",
  "Audio Codec",
  "Audio Format",
  "BitRate",
  "Multiplexer",
  "Video Codec",
]);

const _ALL_CHANNELS = new Set(OutputChannels.members());

function* _iterAllConstraintDicts(): Generator<Constraints> {
  for (const rules of _KIND_RULES.values()) {
    yield rules;
  }
  for (const rules of _FORMAT_RULES.values()) {
    yield rules;
  }
  for (const entries of _CONDITIONAL_RULES.values()) {
    for (const [_, constraints] of entries) {
      yield constraints;
    }
  }
}

test("test_every_format_has_a_kind", () => {
  // A new OutputFormat member must be classified before it ships.
  for (const fmt of OutputFormat.members()) {
    expect(FormatKind.has(OutputFormat.kind(fmt))).toBe(true);
  }
});

test("test_constraint_keys_are_known_settings", () => {
  const valid = new Set([...OM_SETTINGS.keys(), ..._FO_CONSTRAINT_KEYS]);
  for (const constraints of _iterAllConstraintDicts()) {
    for (const key of constraints.keys()) {
      pyAssert(valid.has(key), `unknown constraint key ${repr(key)}`);
    }
  }
});

test("test_condition_keys_are_buildable_context", () => {
  for (const entries of _CONDITIONAL_RULES.values()) {
    for (const [conditions, _] of entries) {
      for (const key of conditions.keys()) {
        pyAssert(_CONDITION_KEYS.has(key), `unknown condition key ${repr(key)}`);
      }
    }
  }
});

test("test_no_empty_allowed_sets", () => {
  // An empty set would make a setting unwritable for the format.
  for (const constraints of _iterAllConstraintDicts()) {
    for (const [key, values] of constraints) {
      pyAssert(pyBool(values), `empty allowed set for ${repr(key)}`);
    }
  }
});

/** Check the channels<->depth pairing closure for one rule branch. */
function _depthClosureOk(channels: ReadonlySet<RuleValue>, depths: ReadonlySet<RuleValue>): [boolean, string] {
  const depthRepr = (ds: Iterable<RuleValue>) =>
    `[${[...sorted(ds)].map((d) => `<OutputColorDepth.${OutputColorDepth.nameOf(OutputColorDepth.of(d))}: ${d}>`).join(", ")}]`;
  if (channels.has(OutputChannels.RGBA)) {
    for (const depth of depths) {
      const base = int(depth);
      if (_DEPTH_PLUS.has(base) && !depths.has(getitem(_DEPTH_PLUS, base))) {
        return [false, `${base} has no +alpha pair in ${depthRepr(depths)}`];
      }
    }
  }
  if ([OutputChannels.RGB, OutputChannels.ALPHA].some((c) => channels.has(c))) {
    for (const depth of depths) {
      const plus = int(depth);
      if (_DEPTH_MINUS.has(plus) && !depths.has(getitem(_DEPTH_MINUS, plus))) {
        return [false, `${plus} has no base pair in ${depthRepr(depths)}`];
      }
    }
  }
  return [true, ""];
}

// ids=lambda f: f.name
test.each(OutputFormat.members().map((fmt): [string, OutputFormat] => [OutputFormat.nameOf(fmt), fmt]))(
  "test_depth_pairing_closed_under_channel_sync[%s]",
  (_id: string, fmt: OutputFormat) => {
    /**
     * `_syncAfterChannels` can never write an out-of-table depth.
     *
     * For every rule branch (format level and each conditional entry), any
     * depth reachable through the RGBA pairing maps (`_DEPTH_PLUS/_MINUS`)
     * from an allowed depth under allowed channels must itself be allowed.
     */
    const fmtRules: Constraints = dictGet(_FORMAT_RULES, fmt, new Map<string, ReadonlySet<RuleValue>>());
    const branches: [Constraints, Map<string, RuleValue | RuleValue[]> | null][] = [[fmtRules, null]];
    for (const [conditions, constraints] of dictGet(_CONDITIONAL_RULES, fmt, [])) {
      const merged: Constraints = new Map([...fmtRules, ...constraints]);
      branches.push([merged, conditions]);
    }
    for (const [branch, conditions] of branches) {
      const depths = dictGet(branch, "Depth");
      if (depths == null) continue;
      let channels: ReadonlySet<RuleValue> = dictGet(branch, "Channels", _ALL_CHANNELS);
      // A branch conditioned on specific channels only ever applies
      // there (e.g. the generated parity rows): narrow accordingly.
      const condChannels = dictGet(pyOr(conditions, new Map<string, RuleValue | RuleValue[]>()), "Channels");
      if (condChannels != null) {
        const condList = Array.isArray(condChannels) ? condChannels : [condChannels];
        channels = new Set([...channels].filter((c) => new Set(condList).has(c)));
      }
      const [ok, why] = _depthClosureOk(channels, depths);
      pyAssert(ok, `${OutputFormat.nameOf(fmt)}: ${why}`);
    }
  },
);

test("test_forced_color_values_are_color_modes", () => {
  // Singleton "Color" sets drive the clamp; their value must be a real
  // OutputColorMode so the raw byte write is well-formed.
  for (const entries of _CONDITIONAL_RULES.values()) {
    for (const [_, constraints] of entries) {
      for (const value of dictGet(constraints, "Color", [])) {
        expect(OutputColorMode.has(value)).toBe(true);
      }
    }
  }
});

test("test_allowed_values_kind_and_format_merge", () => {
  expect(pyEq(allowedValues(OutputFormat.MP3, "Video Output"), new Set([false]))).toBe(true);
  expect(pyEq(allowedValues(OutputFormat.MP3, "Output Audio"), new Set([OutputAudio.ON]))).toBe(true);
  expect(
    pyEq(allowedValues(OutputFormat.TIFF_SEQUENCE, "Output Audio"), new Set([OutputAudio.OFF])),
  ).toBe(true);
  // Movies leave both toggles free.
  expect(allowedValues(OutputFormat.AVI, "Video Output") == null).toBe(true);
  expect(allowedValues(OutputFormat.AVI, "Output Audio") == null).toBe(true);
  // Unconstrained key -> None (NOT an empty set).
  expect(allowedValues(OutputFormat.TIFF_SEQUENCE, "Channels") == null).toBe(true);
});

test("test_allowed_values_conditional_replaces_format_row", () => {
  // Without context the WAV union applies; with the GSM codec the
  // conditional row replaces it.
  const union = allowedValues(OutputFormat.WAV, "Audio Sample Rate");
  expect(union != null && union.has(96000)).toBe(true);
  const gsm = allowedValues(
    OutputFormat.WAV,
    "Audio Sample Rate",
    new Map([["Audio Codec", AudioCodec.GSM_6_10]]),
  );
  expect(pyEq(gsm, new Set([8000, 11025, 22050, 44100]))).toBe(true);
  const channels = allowedValues(
    OutputFormat.WAV,
    "Audio Channels",
    new Map([["Audio Codec", AudioCodec.GSM_6_10]]),
  );
  expect(pyEq(channels, new Set([AudioChannels.MONO]))).toBe(true);
});

test("test_allowed_values_missing_context_is_permissive", () => {
  // No codec in context -> the conditional rows do not narrow.
  expect(allowedValues(OutputFormat.WAV, "Audio Channels") == null).toBe(true);
  expect(allowedValues(OutputFormat.WAV, "Audio Channels", new Map()) == null).toBe(true);
});
