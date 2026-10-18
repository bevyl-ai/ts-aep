import { float, getattr, setattr } from "../../../pyrt/index.ts";
import { _validateNumber, validateF8 } from "../validators.ts";

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
  declare _kfData: object | null;
  declare _dimensionIndex: number;
  declare _direction: string;
  declare _speedFactor: number;
  declare _speed: number;
  declare _influence: number;

  constructor(speed: number = 0.0, influence: number = 0.0) {
    validateF8(speed);
    // The setter enforces the 0.1-100 user range, but 0.0 is the
    // "no ease" sentinel the parser constructs with, so allow it here.
    _validateNumber({ min: 0.0, max: 100.0 })(influence);
    this._kfData = null;
    this._dimensionIndex = 0;
    this._direction = "";
    this._speedFactor = 1.0;
    this._speed = speed;
    this._influence = influence;
  }

  /**
   * Wrap binary keyframe data as a `KeyframeEase` view.
   *
   * @param kfData - The backing keyframe-data chunk body.
   * @param dimensionIndex - Index into per-dimension speed/influence arrays.
   * @param direction - Either `"in"` or `"out"`.
   * @param speedFactor - Unit-conversion factor applied to the raw speed.
   */
  static _fromBinary(
    kfData: object | null,
    dimensionIndex: number,
    direction: string,
    speedFactor: number = 1.0,
  ): KeyframeEase {
    // `cls.__new__(cls)`: skip `__init__`, the backing data is supplied.
    const obj: KeyframeEase = Object.create(this.prototype);
    obj._kfData = kfData;
    obj._dimensionIndex = dimensionIndex;
    obj._direction = direction;
    obj._speedFactor = speedFactor;
    return obj;
  }

  /**
   * Copy `other`'s speed and influence into this chunk-backed ease.
   *
   * Bypasses the public setters' user-facing influence range (0.1-100)
   * because 0.0 is the parser's "no ease" sentinel and a user may pass
   * a `KeyframeEase()` built with it.
   */
  _writeFrom(other: KeyframeEase): void {
    const speed = other.speed;
    const influence = other.influence;
    validateF8(speed);
    _validateNumber({ min: 0.0, max: 100.0 })(influence);
    if (this._kfData == null) {
      this._speed = speed;
      this._influence = influence;
      return;
    }
    const rawSpeed = this._speedFactor ? speed / this._speedFactor : speed;
    const rawInfluence = influence / 100;
    if (this._isArray()) {
      getattr(this._kfData, `${this._direction}Speed`)[this._dimensionIndex] = rawSpeed;
      getattr(this._kfData, `${this._direction}Influence`)[this._dimensionIndex] = rawInfluence;
    } else {
      setattr(this._kfData, `${this._direction}Speed`, rawSpeed);
      setattr(this._kfData, `${this._direction}Influence`, rawInfluence);
    }
  }

  /** Whether the backing kf_data stores speed/influence as arrays. */
  _isArray(): boolean {
    return Array.isArray(getattr(this._kfData, `${this._direction}Speed`));
  }

  /**
   * The speed value of the keyframe. The units depend on the type of
   * keyframe, and are displayed in the Keyframe Velocity dialog box.
   * Read / Write.
   */
  get speed(): number {
    if (this._kfData == null) {
      return this._speed;
    }
    const raw = getattr(this._kfData, `${this._direction}Speed`);
    if (Array.isArray(raw)) {
      return float(raw[this._dimensionIndex]) * this._speedFactor;
    }
    return float(raw) * this._speedFactor;
  }

  set speed(value: number) {
    validateF8(value);
    if (this._kfData == null) {
      this._speed = value;
      return;
    }
    const fieldName = `${this._direction}Speed`;
    const binaryValue = this._speedFactor ? value / this._speedFactor : value;
    if (this._isArray()) {
      getattr(this._kfData, fieldName)[this._dimensionIndex] = binaryValue;
    } else {
      setattr(this._kfData, fieldName, binaryValue);
    }
  }

  /**
   * The influence value of the keyframe, as shown in the Keyframe
   * Velocity dialog box. This is a percentage value between 0.1 and
   * 100. Read / Write.
   */
  get influence(): number {
    if (this._kfData == null) {
      return this._influence;
    }
    const raw = getattr(this._kfData, `${this._direction}Influence`);
    if (Array.isArray(raw)) {
      return float(raw[this._dimensionIndex]) * 100;
    }
    return float(raw) * 100;
  }

  set influence(value: number) {
    // 0.1 is the minimum AE's *dialog* accepts, not the field's range:
    // separating a dimension-separated Position writes `1/dt` percent
    // per side, which is 0.0833 for a 12 s segment (measured on AE
    // 2026). Bounding by the UI limit would reject a value AE itself
    // stores, so this bounds by what the f8 field can mean instead.
    _validateNumber({ min: 0.0, max: 100.0 })(value);
    if (this._kfData == null) {
      this._influence = value;
      return;
    }
    const fieldName = `${this._direction}Influence`;
    const binaryValue = value / 100;
    if (this._isArray()) {
      getattr(this._kfData, fieldName)[this._dimensionIndex] = binaryValue;
    } else {
      setattr(this._kfData, fieldName, binaryValue);
    }
  }
}
