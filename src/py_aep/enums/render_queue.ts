/**
 * Render queue item enumerations for After Effects.
 *
 * These enums match the values used in After Effects ExtendScript.
 */

import { int, defineEnum, type EnumValue } from "../../pyrt/index.ts";

/**
 * Format for getting render settings.
 *
 * @see https://ae-scripting.docsforadobe.dev/renderqueue/outputmodule/#outputmodulegetsettings
 */
export const GetSettingsFormat = defineEnum("GetSettingsFormat", {
  SPEC: 3412,
  NUMBER: 3413,
  NUMBER_SETTABLE: 3414,
  STRING: 3415,
  STRING_SETTABLE: 3416,
});
export type GetSettingsFormat = EnumValue<typeof GetSettingsFormat>;

/**
 * Logging level for rendering.
 *
 * @see https://ae-scripting.docsforadobe.dev/renderqueue/renderqueueitem/#renderqueueitemlogtype
 */
export const LogType = defineEnum("LogType", {
  ERRORS_ONLY: 3212,
  ERRORS_AND_SETTINGS: 3213,
  ERRORS_AND_PER_FRAME_INFO: 3214,
}, {
  /** Convert binary value to LogType. */
  fromBinary(value: number) {
    return this.ofOrNull(value + 3212) ?? this.ERRORS_ONLY;
  },

  /** Convert LogType to binary value. */
  toBinary(self: number): number {
    return int(self) - 3212;
  },
});
export type LogType = EnumValue<typeof LogType>;

/**
 * Status of a render queue item.
 *
 * @see https://ae-scripting.docsforadobe.dev/renderqueue/renderqueueitem/#renderqueueitemstatus
 */
export const RQItemStatus = defineEnum("RQItemStatus", {
  WILL_CONTINUE: 3012,
  NEEDS_OUTPUT: 3013,
  UNQUEUED: 3014,
  QUEUED: 3015,
  RENDERING: 3016,
  USER_STOPPED: 3017,
  ERR_STOPPED: 3018,
  DONE: 3019,
}, {
  /** Convert binary value to RQItemStatus. */
  fromBinary(value: number) {
    return this.ofOrNull(value + 3013) ?? this.UNQUEUED;
  },

  /** Convert RQItemStatus to binary value. */
  toBinary(self: number): number {
    return int(self) - 3013;
  },
});
export type RQItemStatus = EnumValue<typeof RQItemStatus>;
