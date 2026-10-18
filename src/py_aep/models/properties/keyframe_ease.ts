import { float, getattr, setattr } from "../../../pyrt/index.ts";
import { _validate_number, validate_f8 } from "../validators.ts";

/**
 * The `KeyframeEase` object encapsulates the keyframe ease settings of a
 * layer's AE property. Keyframe ease is determined by the `speed` and
 * `influence` values.
 *
 *
 * ```ts
 * import { parse } from "@bevyl-ai/ts-aep";
 *
 * const app = parse("project.aep");
 * const comp = app.project.compositions[0];
 * const position = comp.layers[0].transform.property("ADBE Position");
 * const keyframe = position.keyframes[0];
 * console.log(keyframe.outTemporalEase[0].speed);
 * console.log(keyframe.outTemporalEase[0].influence);
 * ```
 *
 * @see https://ae-scripting.docsforadobe.dev/other/keyframeease/
 * @example
 */
export class KeyframeEase {
  declare _kf_data: object | null;
  declare _dimension_index: number;
  declare _direction: string;
  declare _speed_factor: number;
  declare _speed: number;
  declare _influence: number;

  constructor(speed: number = 0.0, influence: number = 0.0) {
    validate_f8(speed);
    // The setter enforces the 0.1-100 user range, but 0.0 is the
    // "no ease" sentinel the parser constructs with, so allow it here.
    _validate_number({ min: 0.0, max: 100.0 })(influence);
    this._kf_data = null;
    this._dimension_index = 0;
    this._direction = "";
    this._speed_factor = 1.0;
    this._speed = speed;
    this._influence = influence;
  }

  /**
   * Wrap binary keyframe data as a `KeyframeEase` view.
   *
   * @param kf_data - The backing keyframe-data chunk body.
   * @param dimension_index - Index into per-dimension speed/influence arrays.
   * @param direction - Either `"in"` or `"out"`.
   * @param speed_factor - Unit-conversion factor applied to the raw speed.
   */
  static _from_binary(
    kf_data: object | null,
    dimension_index: number,
    direction: string,
    speed_factor: number = 1.0,
  ): KeyframeEase {
    // `cls.__new__(cls)`: skip `__init__`, the backing data is supplied.
    const obj: KeyframeEase = Object.create(this.prototype);
    obj._kf_data = kf_data;
    obj._dimension_index = dimension_index;
    obj._direction = direction;
    obj._speed_factor = speed_factor;
    return obj;
  }

  /**
   * Copy `other`'s speed and influence into this chunk-backed ease.
   *
   * Bypasses the public setters' user-facing influence range (0.1-100)
   * because 0.0 is the parser's "no ease" sentinel and a user may pass
   * a `KeyframeEase()` built with it.
   */
  _write_from(other: KeyframeEase): void {
    const speed = other.speed;
    const influence = other.influence;
    validate_f8(speed);
    _validate_number({ min: 0.0, max: 100.0 })(influence);
    if (this._kf_data == null) {
      this._speed = speed;
      this._influence = influence;
      return;
    }
    const raw_speed = this._speed_factor ? speed / this._speed_factor : speed;
    const raw_influence = influence / 100;
    if (this._is_array()) {
      getattr(this._kf_data, `${this._direction}_speed`)[this._dimension_index] = raw_speed;
      getattr(this._kf_data, `${this._direction}_influence`)[this._dimension_index] = raw_influence;
    } else {
      setattr(this._kf_data, `${this._direction}_speed`, raw_speed);
      setattr(this._kf_data, `${this._direction}_influence`, raw_influence);
    }
  }

  /** Whether the backing kf_data stores speed/influence as arrays. */
  _is_array(): boolean {
    return Array.isArray(getattr(this._kf_data, `${this._direction}_speed`));
  }

  /**
   * The speed value of the keyframe. The units depend on the type of
   * keyframe, and are displayed in the Keyframe Velocity dialog box.
   * Read / Write.
   */
  get speed(): number {
    if (this._kf_data == null) {
      return this._speed;
    }
    const raw = getattr(this._kf_data, `${this._direction}_speed`);
    if (Array.isArray(raw)) {
      return float(raw[this._dimension_index]) * this._speed_factor;
    }
    return float(raw) * this._speed_factor;
  }

  set speed(value: number) {
    validate_f8(value);
    if (this._kf_data == null) {
      this._speed = value;
      return;
    }
    const field_name = `${this._direction}_speed`;
    const binary_value = this._speed_factor ? value / this._speed_factor : value;
    if (this._is_array()) {
      getattr(this._kf_data, field_name)[this._dimension_index] = binary_value;
    } else {
      setattr(this._kf_data, field_name, binary_value);
    }
  }

  /**
   * The influence value of the keyframe, as shown in the Keyframe
   * Velocity dialog box. This is a percentage value between 0.1 and
   * 100. Read / Write.
   */
  get influence(): number {
    if (this._kf_data == null) {
      return this._influence;
    }
    const raw = getattr(this._kf_data, `${this._direction}_influence`);
    if (Array.isArray(raw)) {
      return float(raw[this._dimension_index]) * 100;
    }
    return float(raw) * 100;
  }

  set influence(value: number) {
    // 0.1 is the minimum AE's *dialog* accepts, not the field's range:
    // separating a dimension-separated Position writes `1/dt` percent
    // per side, which is 0.0833 for a 12 s segment (measured on AE
    // 2026). Bounding by the UI limit would reject a value AE itself
    // stores, so this bounds by what the f8 field can mean instead.
    _validate_number({ min: 0.0, max: 100.0 })(value);
    if (this._kf_data == null) {
      this._influence = value;
      return;
    }
    const field_name = `${this._direction}_influence`;
    const binary_value = value / 100;
    if (this._is_array()) {
      getattr(this._kf_data, field_name)[this._dimension_index] = binary_value;
    } else {
      setattr(this._kf_data, field_name, binary_value);
    }
  }
}
