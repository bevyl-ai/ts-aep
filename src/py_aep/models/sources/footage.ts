import {
  AttributeError,
  NotImplementedError,
  ValueError,
  b,
  bytes_,
  bytes_eq,
  descriptor,
  float_repr,
  py_cmp,
  repr,
  round,
  type ClassAttributes,
} from "../../../pyrt/index.ts";
import { to_dividend_divisor } from "../../binary/bin_utils.ts";
import { ChunkNotFoundError, find_by_type, find_chunks_after, toggle_flag_chunk } from "../../binary/utils.ts";
import { PROFILE_TYPE_OCIO, build_icc_envelope, parse_envelope } from "../../color/envelope.ts";
import { default_icc_library } from "../../color/icc.ts";
import { ocio_color_profile_envelope, require_ocio_config } from "../../color/ocio.ts";
import { AlphaMode, FieldSeparationType, LinearLightMode, PulldownPhase } from "../../enums/index.ts";
import { map_media_color_space, profile_id_for_name } from "../../enums/mappings.ts";
import { ChunkField } from "../descriptors.ts";
import { _validate_number, validate_bool, validate_conform_frame_rate, validate_rgb_color, validate_string } from "../validators.ts";

import type { Chunk, ListChunk } from "../../binary/chunk.ts";
import type { SspcChunk } from "../../binary/footage_chunks.ts";
import type { U1Chunk, Utf8Chunk } from "../../binary/scalar_chunks.ts";
import type { ColorProfile } from "../../color/envelope.ts";
import type { IccProfileLibrary } from "../../color/icc.ts";
import type { Project } from "../project.ts";

/** `apid` value meaning "no profile assigned" (the media's own profile wins). */
export const _UNASSIGNED_PROFILE = bytes_.repeat(b("\xff"), 16);

/**
 * `LIST:CLRS` records and the first file version (format, minor) that has
 * them; each is a marker chunk and the `Utf8` that follows it. AE 2025
 * (96.9) added `hdrm` - AE 2022-2024 drop it when they save a file that has
 * it (clrs_ae20XX.aep fixtures) - and `Mcsp`/`ocsp` arrived with 93.40
 * (samples/versions: absent from the AE 2018 project, present from AE 2022).
 */
export const _CLRS_RECORDS_SINCE: ReadonlyArray<readonly [string, readonly [number, number]]> = [
  ["hdrm", [96, 9]],
  ["Mcsp", [93, 40]],
  ["ocsp", [93, 40]],
];

/**
 * Reject an alpha interpretation for footage that has no alpha channel.
 *
 * The `sspc` alpha byte doubles as the "no alpha channel" marker (3), so
 * writing a mode over it would claim an alpha channel the media does not
 * have. AE greys the whole alpha section out for such footage.
 */
export function _validate_has_alpha(value: AlphaMode, instance: { hasAlpha?: boolean } | null = null): void {
  if (instance != null && !instance.hasAlpha) {
    throw new ValueError(
      "cannot set alphaMode: the footage has no alpha channel " +
        "(hasAlpha is False)",
    );
  }
}

/** The smallest non-zero conform rate After Effects can open a project with. */
export const _MIN_CONFORM_FRAME_RATE = 0.0005;

/**
 * Move an image sequence to `rate`, keeping its frame count.
 *
 * A sequence's stored duration is its frame count over its rate. AE takes
 * the rate to the nearest thousandth (29.97, not the 16.16 slot's
 * 29.9700012) and leaves the fraction unreduced: 12 frames is 12/24 at
 * 24 fps, 1200/2997 at 29.97 (measured on AE 2026).
 */
export function _retime_sequence(sspc: SspcChunk, rate: number): void {
  const frames = round(sspc.duration * sspc.native_frame_rate);
  sspc.native_frame_rate = rate;
  _store_frames_over_rate(sspc, frames, round(rate, 3));
}

/**
 * Store a sequence's duration as AE does: `frames` over `rate`, the
 * fraction unreduced (3/30, not 1/10, in every AE-authored sequence).
 */
export function _store_frames_over_rate(sspc: SspcChunk, frames: number, rate: number): void {
  const [rate_num, rate_den] = to_dividend_divisor(rate);
  if (frames * rate_den <= 0xffffffff) {
    sspc.duration_dividend = frames * rate_den;
    sspc.duration_divisor = rate_num;
  } else {
    // Too many frames for the unreduced form in the u4 dividend (a huge
    // frame range at a fractional rate): store it reduced.
    sspc.duration = frames / rate;
  }
}

/**
 * The `FootageSource` object holds information describing the source of some
 * footage. It is used as the `main_source` of a `FootageItem` object, or the
 * `proxy_source` of a `CompItem` object or `FootageItem`.
 *
 * @see https://ae-scripting.docsforadobe.dev/sources/footagesource/
 */
export class FootageSource {
  declare ["constructor"]: ClassAttributes<typeof FootageSource>;
  /**
   * Whether the item display name lives in this source's own `opti` chunk.
   *
   * AE keeps a solid's and a placeholder's name there and leaves the
   * item-level `Utf8` chunk empty; file footage is named through that `Utf8`
   * chunk instead.
   */
  static _owns_name: boolean = false;

  /**
   * Defines how the alpha information in the footage is interpreted.
   * If `has_alpha` is `false`, this attribute has no relevant meaning.
   * Read / Write.
   */
  declare alphaMode: AlphaMode;

  /**
   * How the fields are to be separated in non-still footage.
   * Read / Write.
   */
  declare fieldSeparationType: FieldSeparationType;

  /**
   * When `true`, the footage has an alpha component. In this case, the
   * attributes `alpha_mode`, `invert_alpha`, and `premultiplied` have valid
   * values. When `false`, those attributes have no relevant meaning for the
   * footage. Read-only.
   */
  declare hasAlpha: boolean;

  /**
   * When `true`, After Effects uses special algorithms to determine how to
   * perform high-quality field separation. Read / Write.
   */
  declare highQualityFieldSeparation: boolean;

  /**
   * When `true`, an alpha channel in a footage clip or proxy should be
   * inverted. This attribute is valid only if an alpha is present. If
   * `has_alpha` is `false`, or if `alpha_mode` is
   * {@link AlphaMode | AlphaMode.IGNORE}, this attribute is
   * ignored. Read / Write.
   */
  declare invertAlpha: boolean;

  /**
   * The number of times that the footage is to be played consecutively
   * when used in a composition. Read / Write.
   */
  declare loop: number;

  /**
   * The color to be premultiplied. This attribute is valid only if
   * the `alpha_mode` is
   * {@link AlphaMode | AlphaMode.PREMULTIPLIED}.
   * Read / Write.
   */
  declare premulColor: number[];

  /**
   * The Interpret As Linear Light setting from the Interpret Footage \>
   * Color Management tab. Read / Write.
   *
   * **Note:** Not exposed in ExtendScript.
   */
  declare interpretAsLinearLight: LinearLightMode;

  /**
   * A frame rate to use instead of the `native_frame_rate` value. If
   * set to 0, the `native_frame_rate` is used instead. Read / Write.
   *
   * A sequence of stills has no rate of its own, so its assumed rate is
   * kept as the native rate and reads back here; setting one rescales
   * the duration over the new rate, and `0` is ignored (a sequence
   * always runs at some assumed rate). A placeholder keeps its rate the
   * same way, but its duration stays in seconds. Matches After Effects.
   *
   * **Note:** Unlike ExtendScript, a proxy reports its own rate. ExtendScript
   * reads a proxy's rate as assumed only when the item's main source
   * is a sequence or a placeholder: a sequence or placeholder proxy
   * of a movie or comp reads 0, even right after setting it, and an
   * unconformed movie proxy of a sequence reads its native rate.
   *
   * @throws {@link ValueError} If the rate is outside 0-999 or between 0 and 0.0005 (After Effects
   *   cannot open a project holding such a rate).
   */
  get conformFrameRate(): number {
    const sspc = this._sspc;
    if (this._rate_is_assumed) {
      return sspc.conform_frame_rate || sspc.native_frame_rate;
    }
    return sspc.conform_frame_rate;
  }

  set conformFrameRate(value: number) {
    validate_conform_frame_rate(value);
    if (0 < value && value < _MIN_CONFORM_FRAME_RATE) {
      // AE 2026 takes the rate to the nearest thousandth: below 0.0005
      // that is 0, and AE refuses to open the project ("zero
      // denominator in ratio multiply"); 0.0005 opens, as a 3000 s
      // 3-frame sequence.
      throw new ValueError(
        "conformFrameRate must be 0 or at least " +
          `${float_repr(_MIN_CONFORM_FRAME_RATE)}, got ${float_repr(value)}`,
      );
    }
    const sspc = this._sspc;
    if (!this._rate_is_assumed) {
      sspc.conform_frame_rate = value;
      return;
    }
    if (!value) return;
    // AE keeps an assumed rate in the native slot and the conform slot
    // at 0.
    sspc.conform_frame_rate = 0.0;
    if (this._is_sequence) {
      _retime_sequence(sspc, value);
    } else {
      sspc.native_frame_rate = value;
    }
  }

  /**
   * The effective frame rate as displayed and rendered in compositions.
   * If `remove_pulldown` is active, the rate is multiplied by 0.8.
   * Read-only.
   */
  declare displayFrameRate: number;

  /**
   * Controls which pulldown phase to remove from the source footage.
   * {@link PulldownPhase | PulldownPhase.OFF} by default.
   * Read / Write.
   */
  declare removePulldown: PulldownPhase;

  /**
   * Co-set the `sspc` premultiplied flag bit with the alpha mode.
   *
   * AE writes the mode byte and bit 0 of the alpha flags together:
   * premultiplied (1) sets the bit, straight (0) clears it, and ignore
   * (2) leaves it as it was (AE 2026, a PNG and an FBX alike). It
   * rejects a premultiplied interpretation - resetting the footage to
   * straight alpha when the file is opened - if the bit is clear.
   */
  _on_alpha_mode_set(): void {
    const mode = this.alphaMode;
    if (mode !== AlphaMode.IGNORE) {
      this._sspc.premultiplied = mode === AlphaMode.PREMULTIPLIED;
    }
  }

  /**
   * Co-set a field order when a 3:2 pulldown phase is applied.
   *
   * AE requires field separation to be set whenever a standard 3:2
   * pulldown phase (binary 1-5) is removed; a file with such a phase but
   * no field order is rejected ("field order must be set before 3:2
   * pulldown can be removed"). The 24P-advance phases (binary 6-10) are
   * exempt. Mirror AE's Interpret Footage dialog, which forces a field
   * order and defaults to Upper Field First.
   */
  _on_remove_pulldown_set(): void {
    if (
      1 <= this._sspc.remove_pulldown &&
      this._sspc.remove_pulldown <= 5 &&
      this.fieldSeparationType === FieldSeparationType.OFF
    ) {
      this.fieldSeparationType = FieldSeparationType.UPPER_FIELD_FIRST;
    }
  }

  /** The native frame rate of the footage. Read-only. */
  declare nativeFrameRate: number;

  declare _width: number;
  declare _height: number;
  declare _pixel_aspect: number;
  declare _footage_missing: boolean;
  // Type-only accessor stubs: the ChunkField descriptors below replace them, so
  // FileSource can override with accessors as in Python.
  get _start_frame(): number {
    throw new Error("unreachable: replaced by ChunkField descriptor");
  }
  get _end_frame(): number {
    throw new Error("unreachable: replaced by ChunkField descriptor");
  }

  get _has_audio(): boolean {
    return this._sspc.audio_sample_rate > 0;
  }

  /** Total duration in seconds (with conform and loop). */
  get _duration(): number {
    const sspc = this._sspc;
    const conform = sspc.conform_frame_rate;
    if (conform === 0) {
      return sspc.duration * sspc.loop;
    }
    // A conform plays the same frames at another rate, so AE's duration
    // is the frame count over that rate: exactly 48 / 24 = 2.0 s for a
    // 48-frame 23.976 movie. Rescaling the stored duration instead drifts
    // by the 16.16 error of the stored native rate (1.999998 s).
    const frames = round(sspc.duration * sspc.native_frame_rate);
    return (frames / conform) * sspc.loop;
  }

  get _frame_duration(): number {
    // Rounded, not truncated: a 48-frame 23.976 movie lasts 48 frames,
    // though its 16.16 stored rate puts the product at 47.99995.
    return round(this._duration * this.displayFrameRate);
  }

  declare _sspc: SspcChunk;
  declare _linl: U1Chunk | null;
  declare _clrs: ListChunk | null;
  declare _project: Project | null;

  constructor(kw: {
    _sspc: SspcChunk;
    _linl?: U1Chunk | null;
    _clrs?: ListChunk | null;
  }) {
    const { _sspc, _linl = null, _clrs = null } = kw;
    this._sspc = _sspc;
    this._linl = _linl;
    this._clrs = _clrs;
    this._project = null;
  }

  /**
   * Whether the source is an image sequence (a folder of frames).
   *
   * A sequence has no frame rate of its own, so AE keeps its "assume this
   * frame rate" in the native-rate slot instead of the conform slot.
   */
  get _is_sequence(): boolean {
    return false;
  }

  /**
   * Whether this source's project is for After Effects on Windows
   * (see `py_aep.parse`'s `platform`).
   */
  get _windows(): boolean {
    return this._project != null && this._project._windows;
  }

  /**
   * Whether a newly built image sequence takes its rate from its first
   * frame (an animated GIF). A replace then keeps that rate: neither a
   * placeholder's or sequence's assumed rate nor a movie's conform carries
   * over (AE 2026).
   */
  _rate_from_media: boolean = false;

  /**
   * Whether the native-rate slot holds a rate the user chose rather
   * than one measured from media: a sequence's "assume this frame rate",
   * or the rate a placeholder was created with.
   */
  get _rate_is_assumed(): boolean {
    return this._is_sequence;
  }

  /**
   * Copy the Interpret Footage settings AE carries over to `new`.
   *
   * AE keeps what the user chose in the Interpret Footage dialog when a
   * source is replaced, and takes everything it measures from the new
   * file: the dimensions, duration, native frame rate, the alpha
   * interpretation (re-estimated per file) and the embedded colour
   * profile record. Verified against AE 2026 for `replace()`,
   * `replace_with_sequence()` and `replace_with_placeholder()` over
   * movie, sequence, still and placeholder sources. Replacing with a
   * solid carries nothing - AE builds that source from the call's
   * arguments.
   */
  _carry_interpretation_to(new_: FootageSource): void {
    const old_sspc = this._sspc,
      new_sspc = new_._sspc;
    new_sspc.field_separation_type = old_sspc.field_separation_type;
    new_sspc.high_quality_field_separation = old_sspc.high_quality_field_separation;
    new_sspc.remove_pulldown = old_sspc.remove_pulldown;
    new_sspc.loop = old_sspc.loop;
    new_sspc.pixel_aspect = old_sspc.pixel_aspect;

    // A sequence of stills has no rate of its own, so AE keeps its
    // "assume this frame rate" as the native rate and leaves the conform
    // slot at 0; a placeholder keeps its rate the same way. That assumed
    // rate is not a conform: it carries to another sequence, but
    // replacing with a movie leaves the movie playing at its own rate. A
    // real conform carries to either. A new sequence takes whatever rate
    // the old source plays at, so an unconformed movie hands on its own
    // rate; a still or an audio file has none (its native slot is 0),
    // and a new placeholder takes its rate from the call's arguments.
    let rate = this.conformFrameRate;
    if (new_._is_sequence) {
      rate = rate || this._sspc.native_frame_rate;
      if (rate && !new_._rate_from_media) {
        // A sequence's stored duration is its frame count over its
        // rate, so it has to move with the rate; a movie keeps the
        // duration it measured and gets the conform factor applied.
        _retime_sequence(new_sspc, rate);
      }
    } else if (
      rate &&
      !this._rate_is_assumed &&
      !new_._rate_is_assumed &&
      !new_.isStill
    ) {
      new_sspc.conform_frame_rate = rate;
    }

    this._carry_color_management_to(new_);
  }

  /**
   * Attach a newly built source to `project` and fit its colour
   * records to it.
   *
   * Every path that attaches a new source to a project calls this
   * (`FootageItem._new`, a replace, a proxy). A source is built with the
   * `LIST:CLRS` records of the latest release (`build_pin_list`); After
   * Effects writes the older layout when it saves an older version, so
   * the records the project's file version predates are dropped
   * (`_CLRS_RECORDS_SINCE`). A file source also records the input colour
   * space of an OCIO-managed project (see `FileSource._join_project`).
   */
  _join_project(project: Project): void {
    this._project = project;
    if (this._clrs == null) return;
    const head = project._head;
    const version = [head.file_format_version, head._format_subversion];
    const dropped = new Set(
      _CLRS_RECORDS_SINCE.filter(([, since]) => py_cmp(version, since) < 0).map(
        ([marker]) => marker,
      ),
    );
    const chunks = this._clrs.chunks;
    const kept: Chunk[] = [];
    let index = 0;
    while (index < chunks.length) {
      if (dropped.has(chunks[index].chunk_type)) {
        index += 2; // the marker and the Utf8 that follows it
        continue;
      }
      kept.push(chunks[index]);
      index += 1;
    }
    chunks.splice(0, chunks.length, ...kept);
  }

  /**
   * Copy the Color Management choices AE carries over to `new`.
   *
   * The assigned profile (`apid` plus the `ocsp` envelope that holds its
   * bytes) only carries when one is assigned; when it is not, the new
   * source keeps the profile AE derives from the new file. In an OCIO
   * project every file has an assigned space - the one the config's file
   * rules gave it or one the user picked - and it carries even when the
   * new file's rules would pick another (AE 2026). The embedded profile
   * record is always the new file's.
   */
  _carry_color_management_to(new_: FootageSource): void {
    const old_clrs = this._clrs,
      new_clrs = new_._clrs;
    if (old_clrs == null || new_clrs == null) return;
    for (const chunk_type of ["ipws", "linl"] as const) {
      const old_chunk = find_by_type(old_clrs.chunks, chunk_type);
      const new_chunk = find_by_type(new_clrs.chunks, chunk_type);
      new_chunk.value = old_chunk.value;
    }
    toggle_flag_chunk(new_clrs, "prgb", this.preserveRgb);

    const old_apid = find_by_type(old_clrs.chunks, "apid");
    if (bytes_eq(old_apid.data, _UNASSIGNED_PROFILE)) {
      const old_profile = this._ocsp_profile();
      if (old_profile == null || !old_profile.is_ocio) return;
    }
    find_by_type(new_clrs.chunks, "apid").data = old_apid.data;
    const old_ocsp = this._ocsp_utf8();
    const new_ocsp = new_._ocsp_utf8();
    if (old_ocsp != null && new_ocsp != null) {
      new_ocsp.value = old_ocsp.value;
    }
  }

  /**
   * Write the item display name into the source's own `opti` chunk.
   *
   * The counterpart of `_resolve_name`: it must store the name where that
   * method reads it back from, or the rename is lost on save. Only called
   * for a source that owns its name (see `_owns_name`).
   */
  _store_name(value: string): void {
    throw new NotImplementedError();
  }

  /**
   * ICC library for Adobe-CMS profile writes - the owning project's
   * (honouring `icc_profile_dirs`) when wired, else the global default.
   */
  _icc_lib(): IccProfileLibrary {
    if (this._project != null) {
      return this._project._icc_lib();
    }
    return default_icc_library();
  }

  /**
   * When `true`, the footage Preserve RGB setting is enabled.
   * From the Interpret Footage \> Color Management tab. Read / Write.
   *
   * **Note:** Not exposed in ExtendScript.
   */
  get preserveRgb(): boolean {
    if (this._clrs == null) return false;
    return this._clrs.chunks.some((c) => c.chunk_type === "prgb");
  }

  set preserveRgb(value: boolean) {
    validate_bool(value);
    if (this._clrs == null) {
      throw new AttributeError(
        "Cannot set preserveRgb: no CLRS container. Update the value in After Effects then re-parse the project to modify this footage source.",
      );
    }
    toggle_flag_chunk(this._clrs, "prgb", value);
  }

  /**
   * The media color space from the Interpret Footage \>
   * Color Management tab. Read / Write.
   *
   * Returns `"Embedded"`, `"Working Color Space"`, the name of an assigned
   * OCIO color space, or the name of an Adobe ICC profile (e.g.
   * `"Apple RGB"`). As with {@link Project.workingSpace | working_space},
   * an assigned OCIO space reads back as AE's stored `colorProfileName`:
   * `"<family>/<name>"` for a direct color-space pick (e.g.
   * `"ACES/ACES - ACEScg"`), or the target name for a role/alias pick.
   *
   * Writable: `"Working Color Space"`, `"Embedded"`, an Adobe ICC profile
   * name, or - in OCIO mode - any color space, role, alias or
   * `display/view` pair of the project's OCIO configuration (the
   * `"<family>/<name>"` form this getter returns is accepted too). The
   * config must be resolvable, since the envelope AE writes depends on
   * which kind the name is. An Adobe profile is identified by its 16-byte
   * ID and its ICC bytes are discovered on disk
   * (`ColorProfileNotFoundError` if not installed).
   *
   * **Note:** Assigning back what this getter returns is lossy for a ROLE pick.
   * AE stores the role's TARGET, not the role, and many roles can
   * share one target (ACES 1.2 points `rendering`, `scene_linear` and
   * `compositing_linear` all at `ACES - ACEScg`), so which role was
   * chosen is not recoverable from the file. Re-assigning the target
   * name records a direct color-space pick instead - the same color
   * transform, different bytes. Pass the role name (e.g.
   * `"matte_paint"`) to write a role pick.
   *
   * **Note:** Not exposed in ExtendScript.
   */
  get mediaColorSpace(): string {
    if (this._clrs == null) return "Embedded";
    const ipws_chunk = find_by_type(this._clrs.chunks, "ipws");
    if (ipws_chunk.value) return "Working Color Space";
    // In OCIO mode the assigned color space is carried as an OCIO envelope in
    // the `ocsp` Utf8 (apid is the unmanaged sentinel). In Adobe mode `ocsp`
    // holds the embedded/override profile and `apid` is the discriminator.
    const ocsp = this._ocsp_profile();
    if (ocsp != null && ocsp.profile_type === PROFILE_TYPE_OCIO) {
      return ocsp.name;
    }
    const apid_chunk = find_by_type(this._clrs.chunks, "apid");
    return map_media_color_space(false, apid_chunk.data);
  }

  set mediaColorSpace(value: string) {
    validate_string(value);
    if (this._clrs == null) {
      throw new AttributeError(
        "Cannot set mediaColorSpace: no CLRS container. Update the " +
          "value in After Effects then re-parse the project to modify " +
          "this footage source.",
      );
    }
    const ipws_chunk = find_by_type(this._clrs.chunks, "ipws");
    const apid_chunk = find_by_type(this._clrs.chunks, "apid");
    if (value === "Working Color Space") {
      // AE sets ipws, clears the override id, and empties the ocsp Utf8.
      ipws_chunk.value = 1;
      apid_chunk.data = bytes_.repeat(b("\xff"), 16);
      this._write_ocsp("");
      return;
    }
    ipws_chunk.value = 0;
    if (value === "Embedded") {
      // Revert to the file's embedded profile (mirrored in the Mcsp Utf8).
      apid_chunk.data = bytes_.repeat(b("\xff"), 16);
      this._write_ocsp(this._embedded_envelope());
      return;
    }
    if (profile_id_for_name(value) != null) {
      // Adobe ICC override: apid is the catalogued profile ID and the ocsp
      // carries the embedded ICC bytes (discovered from the standard Adobe
      // Color dirs). For most profiles the bytes hash to the same ID; the
      // handful AE generates a private variant for (Apple/Adobe RGB,
      // ColorMatch, ROMM) embed the on-disk copy AE still recognizes.
      const lib = this._icc_lib();
      apid_chunk.data = lib.hash_for(value);
      this._write_ocsp(build_icc_envelope(value, lib.bytes_for(value)));
      return;
    }
    // Treat any other name as an OCIO color space (no ICC, apid unmanaged).
    // The envelope depends on the SELECTION KIND, so the config is
    // required - AE-verified against a direct-pick and a role-pick sample.
    apid_chunk.data = bytes_.repeat(b("\xff"), 16);
    this._write_ocsp(this._ocio_envelope(value));
  }

  /** Build the OCIO envelope AE writes for `name` (see {@link py_aep.color.ocio.ocio_color_profile_envelope | ocio_color_profile_envelope}). */
  _ocio_envelope(name: string): string {
    const project = this._project;
    const config = require_ocio_config(
      project != null ? project.ocioConfigurationFile : null,
      `build the color-profile envelope for ${repr(name)}`,
    );
    return ocio_color_profile_envelope(config, name);
  }

  /** The `Utf8` chunk after the CLRS `ocsp` marker (the assigned space). */
  _ocsp_utf8(): Utf8Chunk | null {
    if (this._clrs == null) return null;
    let after: Utf8Chunk[];
    try {
      after = find_chunks_after(this._clrs.chunks, "Utf8", "ocsp");
    } catch (e) {
      if (!(e instanceof ChunkNotFoundError)) throw e;
      return null;
    }
    return after?.length > 0 ? after[0] : null;
  }

  _ocsp_profile(): ColorProfile | null {
    const utf8 = this._ocsp_utf8();
    if (utf8 == null || !utf8.value.includes("baseColorProfile")) return null;
    return parse_envelope(utf8.value);
  }

  /** The embedded source profile envelope (CLRS `Mcsp` Utf8), or `{}`. */
  _embedded_envelope(): string {
    if (this._clrs == null) return "{}";
    let after: Utf8Chunk[];
    try {
      after = find_chunks_after(this._clrs.chunks, "Utf8", "Mcsp");
    } catch (e) {
      if (!(e instanceof ChunkNotFoundError)) throw e;
      return "{}";
    }
    return after?.length > 0 ? after[0].value : "{}";
  }

  _write_ocsp(envelope: string): void {
    const utf8 = this._ocsp_utf8();
    if (utf8 == null) {
      throw new AttributeError(
        "Cannot set mediaColorSpace: no 'ocsp' color chunk in CLRS.",
      );
    }
    utf8.value = envelope;
  }

  /**
   * Whether the footage is still; When `false`, it has a
   * time-based component. Read-only.
   */
  get isStill(): boolean {
    return this._sspc.duration === 0;
  }
}

// Descriptor fields. Each reads from / writes to a chunk attribute, so
// assigning to them mutates the underlying binary data.
descriptor(
  FootageSource,
  "alphaMode",
  ChunkField.enum(AlphaMode, "_sspc", "alpha_mode_raw", {
    validate: _validate_has_alpha,
    post_set: "_on_alpha_mode_set",
  }),
);
descriptor(
  FootageSource,
  "fieldSeparationType",
  ChunkField.enum(FieldSeparationType, "_sspc", "field_separation_type"),
);
descriptor(
  FootageSource,
  "hasAlpha",
  new ChunkField("_sspc", "has_alpha", { read_only: true }),
);
descriptor(
  FootageSource,
  "highQualityFieldSeparation",
  ChunkField.bool("_sspc", "high_quality_field_separation"),
);
descriptor(
  FootageSource,
  "invertAlpha",
  ChunkField.bool("_sspc", "invert_alpha"),
);
descriptor(
  FootageSource,
  "loop",
  new ChunkField("_sspc", "loop", {
    validate: _validate_number({ min: 1, max: 9999, integer: true }),
  }),
);
descriptor(
  FootageSource,
  "premulColor",
  new ChunkField("_sspc", "premul_color", { validate: validate_rgb_color }),
);
descriptor(
  FootageSource,
  "interpretAsLinearLight",
  ChunkField.enum(LinearLightMode, "_linl", "value", {
    default: LinearLightMode.OFF,
  }),
);
descriptor(
  FootageSource,
  "displayFrameRate",
  new ChunkField("_sspc", "display_frame_rate", { read_only: true }),
);
descriptor(
  FootageSource,
  "removePulldown",
  ChunkField.enum(PulldownPhase, "_sspc", "remove_pulldown", {
    post_set: "_on_remove_pulldown_set",
  }),
);
descriptor(
  FootageSource,
  "nativeFrameRate",
  new ChunkField("_sspc", "native_frame_rate", { read_only: true }),
);
descriptor(
  FootageSource,
  "_width",
  new ChunkField("_sspc", "width", { read_only: true }),
);
descriptor(
  FootageSource,
  "_height",
  new ChunkField("_sspc", "height", { read_only: true }),
);
descriptor(
  FootageSource,
  "_pixel_aspect",
  new ChunkField("_sspc", "pixel_aspect", { read_only: true }),
);
descriptor(
  FootageSource,
  "_footage_missing",
  new ChunkField("_sspc", "footage_missing_at_save", { read_only: true }),
);
descriptor(
  FootageSource,
  "_start_frame",
  new ChunkField("_sspc", "start_frame", { read_only: true }),
);
descriptor(
  FootageSource,
  "_end_frame",
  new ChunkField("_sspc", "end_frame", { read_only: true }),
);
