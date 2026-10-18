/**
 * Text document enumerations for After Effects.
 *
 * These enums match the values used in After Effects ExtendScript.
 */

import { getOrThrow, int, intEnum, type EnumValue } from "../../pyrt/index.ts";

/**
 * Auto kerning type option for text characters.
 *
 * @see https://ae-scripting.docsforadobe.dev/text/textdocument/#textdocumentautokerntype
 */
export const AutoKernType = intEnum(
  "AutoKernType",
  {
    NO_AUTO_KERN: 11412,
    METRIC_KERN: 11413,
    OPTICAL_KERN: 11414,
  },
  {
    /** Convert COS value (0-2) to AutoKernType. */
    fromBinary(value: number) {
      return this.of(value + 11412);
    },
    /** Convert AutoKernType to COS value (0-2). */
    toBinary(self: number): number {
      return int(self) - 11412;
    },
  },
);
export type AutoKernType = EnumValue<typeof AutoKernType>;

/**
 * Baseline direction option for text characters.
 *
 * This is significant for Japanese language in vertical texts.
 * `BASELINE_VERTICAL_CROSS_STREAM` is also known as Tate-Chu-Yoko.
 *
 * @see https://ae-scripting.docsforadobe.dev/text/textdocument/#textdocumentbaselinedirection
 */
export const BaselineDirection = intEnum(
  "BaselineDirection",
  {
    BASELINE_WITH_STREAM: 11612,
    BASELINE_VERTICAL_ROTATED: 11613,
    BASELINE_VERTICAL_CROSS_STREAM: 11614,
  },
  {
    /**
     * Convert COS value (1-3) to BaselineDirection.
     *
     * COS stores this 1-based (`member value - 11611`).
     */
    fromBinary(value: number) {
      return this.of(value + 11611);
    },
    /** Convert BaselineDirection to COS value (1-3). */
    toBinary(self: number): number {
      return int(self) - 11611;
    },
  },
);
export type BaselineDirection = EnumValue<typeof BaselineDirection>;

/**
 * Box auto fit policy for paragraph text boxes.
 *
 * @see https://ae-scripting.docsforadobe.dev/text/textdocument/#textdocumentboxautofitpolicy
 */
export const BoxAutoFitPolicy = intEnum(
  "BoxAutoFitPolicy",
  {
    NONE: 13412,
    HEIGHT_CURSOR: 13413,
    HEIGHT_PRECISE_BOUNDS: 13414,
    HEIGHT_BASELINE: 13415,
  },
  {
    /** Convert COS value (0-3) to BoxAutoFitPolicy. */
    fromBinary(value: number) {
      return this.ofOrNull(value + 13412) ?? this.NONE;
    },
    /** Convert BoxAutoFitPolicy to COS value (0-3). */
    toBinary(self: number): number {
      return int(self) - 13412;
    },
  },
);
export type BoxAutoFitPolicy = EnumValue<typeof BoxAutoFitPolicy>;

/**
 * First baseline alignment for paragraph text boxes.
 *
 * @see https://ae-scripting.docsforadobe.dev/text/textdocument/#textdocumentboxfirstbaselinealignment
 */
export const BoxFirstBaselineAlignment = intEnum(
  "BoxFirstBaselineAlignment",
  {
    MINIMUM_VALUE_ROMAN: 13012,
    ASCENT: 13013,
    CAP_HEIGHT: 13014,
    LEADING: 13015,
    X_HEIGHT: 13016,
    EM_BOX: 13017,
    LEGACY_METRIC: 13018,
    MINIMUM_VALUE_ASIAN: 13019,
    TYPO_ASCENT: 13020,
  },
  {
    /** Convert COS value (0-8) to BoxFirstBaselineAlignment. */
    fromBinary(value: number) {
      return this.ofOrNull(value + 13012) ?? this.ASCENT;
    },
    /** Convert BoxFirstBaselineAlignment to COS value (0-8). */
    toBinary(self: number): number {
      return int(self) - 13012;
    },
  },
);
export type BoxFirstBaselineAlignment = EnumValue<typeof BoxFirstBaselineAlignment>;

/**
 * Vertical alignment for paragraph text boxes.
 *
 * @see https://ae-scripting.docsforadobe.dev/text/textdocument/#textdocumentboxverticalalignment
 */
export const BoxVerticalAlignment = intEnum(
  "BoxVerticalAlignment",
  {
    TOP: 12812,
    CENTER: 12813,
    BOTTOM: 12814,
    JUSTIFY: 12815,
  },
  {
    /** Convert COS value (0-3) to BoxVerticalAlignment. */
    fromBinary(value: number) {
      return this.ofOrNull(value + 12812) ?? this.TOP;
    },
    /** Convert BoxVerticalAlignment to COS value (0-3). */
    toBinary(self: number): number {
      return int(self) - 12812;
    },
  },
);
export type BoxVerticalAlignment = EnumValue<typeof BoxVerticalAlignment>;

/**
 * Text composer engine type.
 *
 * @see https://ae-scripting.docsforadobe.dev/text/textdocument/#textdocumentcomposerengine
 */
export const ComposerEngine = intEnum("ComposerEngine", {
  LATIN_CJK_ENGINE: 10413,
  UNIVERSAL_TYPE_ENGINE: 10414,
});
export type ComposerEngine = EnumValue<typeof ComposerEngine>;

/**
 * Digit set option for text characters.
 *
 * @see https://ae-scripting.docsforadobe.dev/text/textdocument/#textdocumentdigitset
 */
export const DigitSet = intEnum(
  "DigitSet",
  {
    DEFAULT_DIGITS: 12012,
    ARABIC_DIGITS: 12013,
    HINDI_DIGITS: 12014,
    FARSI_DIGITS: 12015,
    ARABIC_DIGITS_RTL: 12016,
  },
  {
    /** Convert COS value (0-4) to DigitSet. */
    fromBinary(value: number) {
      return this.of(value + 12012);
    },
    /** Convert DigitSet to COS value (0-4). */
    toBinary(self: number): number {
      return int(self) - 12012;
    },
  },
);
export type DigitSet = EnumValue<typeof DigitSet>;

/**
 * Font baseline option for superscript and subscript.
 *
 * @see https://ae-scripting.docsforadobe.dev/text/textdocument/#textdocumentfontbaselineoption
 */
export const FontBaselineOption = intEnum(
  "FontBaselineOption",
  {
    FONT_NORMAL_BASELINE: 11212,
    FONT_FAUXED_SUPERSCRIPT: 11213,
    FONT_FAUXED_SUBSCRIPT: 11214,
  },
  {
    /** Convert COS value (0-2) to FontBaselineOption. */
    fromBinary(value: number) {
      return this.of(value + 11212);
    },
    /** Convert FontBaselineOption to COS value (0-2). */
    toBinary(self: number): number {
      return int(self) - 11212;
    },
  },
);
export type FontBaselineOption = EnumValue<typeof FontBaselineOption>;

/**
 * Font caps option for text characters.
 *
 * @see https://ae-scripting.docsforadobe.dev/text/textdocument/#textdocumentfontcapsoption
 */
export const FontCapsOption = intEnum(
  "FontCapsOption",
  {
    FONT_NORMAL_CAPS: 11012,
    FONT_SMALL_CAPS: 11013,
    FONT_ALL_CAPS: 11014,
    FONT_ALL_SMALL_CAPS: 11015,
  },
  {
    /** Convert COS value (0-3) to FontCapsOption. */
    fromBinary(value: number) {
      return this.of(value + 11012);
    },
    /** Convert FontCapsOption to COS value (0-3). */
    toBinary(self: number): number {
      return int(self) - 11012;
    },
  },
);
export type FontCapsOption = EnumValue<typeof FontCapsOption>;

/**
 * Paragraph leading type.
 *
 * @see https://ae-scripting.docsforadobe.dev/text/textdocument/#textdocumentleadingtype
 */
export const LeadingType = intEnum(
  "LeadingType",
  {
    ROMAN_LEADING_TYPE: 10812,
    JAPANESE_LEADING_TYPE: 10813,
  },
  {
    /** Convert COS value (0-1) to LeadingType. */
    fromBinary(value: number) {
      return this.of(value + 10812);
    },
    /** Convert LeadingType to COS value (0-1). */
    toBinary(self: number): number {
      return int(self) - 10812;
    },
  },
);
export type LeadingType = EnumValue<typeof LeadingType>;

/**
 * Line join type for text stroke.
 *
 * @see https://ae-scripting.docsforadobe.dev/text/textdocument/#textdocumentlinejointype
 */
export const LineJoinType = intEnum(
  "LineJoinType",
  {
    LINE_JOIN_MITER: 11812,
    LINE_JOIN_ROUND: 11813,
    LINE_JOIN_BEVEL: 11814,
  },
  {
    /** Convert COS value (0-2) to LineJoinType. */
    fromBinary(value: number) {
      return this.of(value + 11812);
    },
    /** Convert LineJoinType to COS value (0-2). */
    toBinary(self: number): number {
      return int(self) - 11812;
    },
  },
);
export type LineJoinType = EnumValue<typeof LineJoinType>;

/**
 * Line orientation for text layers.
 *
 * @see https://ae-scripting.docsforadobe.dev/text/textdocument/#textdocumentlineorientation
 */
export const LineOrientation = intEnum(
  "LineOrientation",
  {
    HORIZONTAL: 13212,
    VERTICAL_RIGHT_TO_LEFT: 13213,
    VERTICAL_LEFT_TO_RIGHT: 13214,
  },
  {
    /**
     * Convert COS value to LineOrientation.
     *
     * COS 1/2 are swapped relative to the enum's numeric order
     * (1 = left-to-right, 2 = right-to-left).
     */
    fromBinary(value: number) {
      return _LINE_ORIENTATION_BINARY_MAP.get(value) ?? this.HORIZONTAL;
    },
    /** Convert LineOrientation to COS value. */
    toBinary(self: number): number {
      return getOrThrow(_LINE_ORIENTATION_TO_BINARY, self);
    },
  },
);
export type LineOrientation = EnumValue<typeof LineOrientation>;

export const _LINE_ORIENTATION_BINARY_MAP: Map<number, LineOrientation> = new Map<number, LineOrientation>([
  [0, LineOrientation.HORIZONTAL],
  [1, LineOrientation.VERTICAL_LEFT_TO_RIGHT],
  [2, LineOrientation.VERTICAL_RIGHT_TO_LEFT],
]);
export const _LINE_ORIENTATION_TO_BINARY: Map<LineOrientation, number> = new Map<LineOrientation, number>(
  [..._LINE_ORIENTATION_BINARY_MAP].map(([k, v]): [LineOrientation, number] => [v, k]),
);

/**
 * Paragraph direction for text layers.
 *
 * @see https://ae-scripting.docsforadobe.dev/text/textdocument/#textdocumentdirection
 */
export const ParagraphDirection = intEnum(
  "ParagraphDirection",
  {
    DIRECTION_LEFT_TO_RIGHT: 10212,
    DIRECTION_RIGHT_TO_LEFT: 10213,
  },
  {
    /** Convert COS value (0-1) to ParagraphDirection. */
    fromBinary(value: number) {
      return this.of(value + 10212);
    },
    /** Convert ParagraphDirection to COS value (0-1). */
    toBinary(self: number): number {
      return int(self) - 10212;
    },
  },
);
export type ParagraphDirection = EnumValue<typeof ParagraphDirection>;

/**
 * Paragraph justification for text layers.
 *
 * @see https://ae-scripting.docsforadobe.dev/text/textdocument/#textdocumentjustification
 */
export const ParagraphJustification = intEnum(
  "ParagraphJustification",
  {
    MULTIPLE_JUSTIFICATIONS: 7412,
    LEFT_JUSTIFY: 7413,
    RIGHT_JUSTIFY: 7414,
    CENTER_JUSTIFY: 7415,
    FULL_JUSTIFY_LASTLINE_LEFT: 7416,
    FULL_JUSTIFY_LASTLINE_RIGHT: 7417,
    FULL_JUSTIFY_LASTLINE_CENTER: 7418,
    FULL_JUSTIFY_LASTLINE_FULL: 7419,
  },
  {
    /**
     * Convert COS value (0-6) to ParagraphJustification.
     *
     * COS 0 is `LEFT_JUSTIFY`; the `MULTIPLE_JUSTIFICATIONS` sentinel
     * is never stored, so the offset is the member value minus 7413.
     */
    fromBinary(value: number) {
      return this.of(value + 7413);
    },
    /** Convert ParagraphJustification to COS value (0-6). */
    toBinary(self: number): number {
      return int(self) - 7413;
    },
  },
);
export type ParagraphJustification = EnumValue<typeof ParagraphJustification>;

/**
 * Variable Font Spacing behavior for a text layer.
 *
 * The value of the `ADBE Text Variable Font Spacing` property in the
 * text layer's More Options group. Controls how After Effects handles
 * character-spacing compensation when animating variable-font axes
 * changes character widths.
 *
 * **Note:** This functionality was added in After Effects 26.0. The enum
 * values match the property's stored value directly.
 */
export const VariableFontSpacing = intEnum("VariableFontSpacing", {
  ADAPTIVE: 1,
  PER_CHARACTER: 2,
  DEFAULT: 3,
});
export type VariableFontSpacing = EnumValue<typeof VariableFontSpacing>;
