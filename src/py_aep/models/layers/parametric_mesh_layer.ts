// Port of py_aep/models/layers/parametric_mesh_layer.py

import { LayerType, ParametricMeshType } from "../../enums/index.ts";
import { _PARAMETRIC_MESH_ACTIVE_GROUPS } from "../../synthesis/property.ts";
import {
  AttributeError,
  type_name,
  descriptor,
  descriptors_of,
  getattr,
  round,
  str,
  type ClassAttributes,
} from "../../../pyrt/index.ts";
import { ChunkField, type EffectParamDefs } from "../descriptors.ts";
import { label_index } from "../preferences.ts";
import { AVLayer } from "./av_layer.ts";
import type { CompItem } from "../items/composition.ts";
import { Property } from "../properties/property.ts";
import { PropertyGroup } from "../properties/property_group.ts";

/**
 * `type(None)` is NoneType, which is never `null` itself. Keeps the
 * `type(old) is not cls` check below true when an option is unset and no
 * class maps to the mesh type.
 */
export const NoneType = Symbol("NoneType");

export function _type_of(x: { constructor: Function } | null | undefined): Function | symbol {
  return x == null ? NoneType : x.constructor;
}

/** Keyword arguments of `ParametricMeshLayer._new`. */
type ParametricMeshLayerNewKw = {
  name: string;
  layer_id: number;
  duration: number;
  containing_comp: CompItem;
  mesh_type: ParametricMeshType;
  effect_param_defs?: EffectParamDefs | null;
};

/**
 * The ParametricMeshLayer object represents a parametric mesh layer within a composition.
 *
 *
 * Info:
 *     `ParametricMeshLayer` is a subclass of {@link AVLayer} object. All methods and
 *     attributes of {@link AVLayer} are available when working with `ParametricMeshLayer`.
 *
 * **Note:** This functionality was added in After Effects 26.0
 *
 * @example
 * ```ts
 * import { parse } from "@bevyl-ai/ts-aep";
 *
 * const app = parse("project.aep");
 * const comp = app.project.compositions[0];
 * const mesh = comp.parametric_mesh_layers[0];
 * console.log(mesh.name);
 * ```
 * @see https://ae-scripting.docsforadobe.dev/layer/parametricmeshlayer/
 */
export class ParametricMeshLayer extends AVLayer {
  // NOTE(port): Layer.__init__ -> PropertyBase.__init__ assigns instance `_auto_name = None`, shadowing this class attribute in Python too; AVLayer.name's `self._auto_name` therefore sees None in both.
  static _auto_name: string = "Mesh Layer";

  /** For a parametric mesh layer, its mesh type. Read / write. */
  declare parametric_mesh_type: ParametricMeshType;

  /** The ParametricMeshOptions object represents the options for a parametric mesh layer. */
  declare parametric_mesh_options: ParametricMeshOptions;

  /** The ParametricBevelOptions object represents the bevel options for a parametric mesh layer. */
  declare parametric_bevel_options: ParametricBevelOptions;

  constructor(...args: ConstructorParameters<typeof AVLayer>) {
    super(...args);
    this._update_options();
  }

  // Python `# type: ignore[override]`: keyword shape differs from AVLayer._new's; overloads keep the base static side assignable.
  static _new(kw: ParametricMeshLayerNewKw): ParametricMeshLayer;
  static _new(...args: never[]): never;
  static _new(kw: ParametricMeshLayerNewKw): ParametricMeshLayer {
    const { name, layer_id, duration, containing_comp, mesh_type, effect_param_defs = null } = kw;
    const layer = super._new<ParametricMeshLayer>({
      name,
      layer_id,
      duration,
      containing_comp,
      effect_param_defs,
    });
    layer._ldta.layer_type = LayerType.PARAMETRIC_MESH;
    layer._ldta.label = label_index(containing_comp._project._preferences, "Parametrics Label Index", 9);
    layer._ldta.three_d_layer = true;
    layer._ldta.collapse_transformation = true;
    // AE writes flags2=0x83 for mesh layers: effects are not applicable.
    layer._ldta.effects_active = false;
    // AE expresses the layer's time fields in the comp's internal
    // timebase (e.g. 23976 for 29.97 fps), not a reduced rational.
    const time_base = containing_comp._cdta.internal_timebase;
    layer._ldta.start_time_divisor = time_base;
    layer._ldta.in_point_divisor = time_base;
    layer._ldta.out_point_dividend = round(duration * time_base);
    layer._ldta.out_point_divisor = time_base;
    layer.parametric_mesh_type = mesh_type;
    // AE writes the active mesh type's option/bevel groups expanded
    // (tdsb=1) while the other mesh groups stay collapsed (tdsb=3, the
    // synthesized default). Override the active groups before the layer
    // is materialized so the written tdsb matches AE.
    const active_groups = _PARAMETRIC_MESH_ACTIVE_GROUPS.get(ParametricMeshType.to_binary(mesh_type)) ?? [];
    for (const child of layer.properties) {
      if (active_groups.includes(child.match_name) && child._tdsb != null) {
        child._tdsb._enable_flags = 1;
      }
    }
    return layer;
  }

  /** Update the parametric mesh options from the layer's current state. */
  _update_options(): void {
    // Plain instance attributes, read as own properties (Python's
    // `__dict__`): `getattr` on a missing one would search the layer's
    // properties for that name.
    const options_cls = OPTION_TYPES.get(this._ldta.light_and_mesh_type) ?? null;
    const old_options = Object.hasOwn(this, "parametric_mesh_options") ? this.parametric_mesh_options : null;
    if (_type_of(old_options) !== options_cls) {
      Reflect.deleteProperty(this, "parametric_mesh_options");
      if (options_cls != null) {
        this.parametric_mesh_options = new options_cls(this);
      }
    }

    const bevel_cls = BEVEL_OPTION_TYPES.get(this._ldta.light_and_mesh_type) ?? null;
    const old_bevel = Object.hasOwn(this, "parametric_bevel_options") ? this.parametric_bevel_options : null;
    if (_type_of(old_bevel) !== bevel_cls) {
      Reflect.deleteProperty(this, "parametric_bevel_options");
      if (bevel_cls != null) {
        this.parametric_bevel_options = new bevel_cls(this);
      }
    }
  }

  /**
   * `false` for Parametric Mesh layers: collapse transformation is
   * forced on and cannot be changed. Read-only.
   */
  get can_set_collapse_transformation(): boolean {
    return false;
  }

  /** `false` for Parametric Mesh layers (time remapping is not supported). Read-only. */
  get can_set_time_remap_enabled(): boolean {
    return false;
  }
}

// Class-body `ChunkField` assignment in Python, installed as a descriptor.
descriptor(
  ParametricMeshLayer,
  "parametric_mesh_type",
  ChunkField.enum(ParametricMeshType, "_ldta", "light_and_mesh_type", {
    post_set: (obj: ParametricMeshLayer) => obj._update_options(),
  }),
);

// Keyed by the raw ldta value (0-5, `ParametricMeshType.to_binary()`) so
// unknown mesh types from newer AE versions look up as None instead of raising.
export const OPTION_TYPES: Map<number, typeof ParametricMeshOptions> = new Map();
export const BEVEL_OPTION_TYPES: Map<number, typeof ParametricBevelOptions> = new Map();

/** Decorator that registers a ParametricMeshOptions subclass for one mesh_type. */
export function register(mesh_type: ParametricMeshType) {
  function decorator<M extends typeof ParametricMeshOptions>(cls: M): M {
    OPTION_TYPES.set(ParametricMeshType.to_binary(mesh_type), cls);
    return cls;
  }
  return decorator;
}

/** Decorator that registers a ParametricBevelOptions subclass for one mesh_type. */
export function register_bevel(mesh_type: ParametricMeshType) {
  function decorator<B extends typeof ParametricBevelOptions>(cls: B): B {
    BEVEL_OPTION_TYPES.set(ParametricMeshType.to_binary(mesh_type), cls);
    return cls;
  }
  return decorator;
}

/**
 * Descriptor for a parametric mesh layer property.
 *
 * @param property_name - Name of the property in the parametric mesh options group.
 */
export class ParaMeshField<T extends number | boolean = number> {
  declare _property_name: string;

  constructor(property_name: string) {
    this._property_name = property_name;
  }

  __get__(obj: ParametricMeshOptions | ParametricBevelOptions | null, objtype: Function): T | this {
    if (obj == null) return this;
    const value = obj._properties(this._property_name).value;
    return value;
  }

  __set__(obj: ParametricMeshOptions | ParametricBevelOptions, value: T): void {
    obj._properties(this._property_name).value = value;
  }
}

/**
 * The ParametricMeshOptions object represents the options for a parametric mesh layer.
 *
 * Info:
 *     This functionality was added in After Effects 26.0
 */
export class ParametricMeshOptions {
  declare ["constructor"]: ClassAttributes<typeof ParametricMeshOptions>;
  // Annotation-only in Python; each subclass sets its own value.
  static _match_name: string;

  declare _layer: ParametricMeshLayer;
  declare _group: PropertyGroup | null;

  constructor(layer: ParametricMeshLayer) {
    this._layer = layer;
    this._group = null;
  }

  _properties(name: string): Property {
    // Python casts both lookups; a wrong kind fails at its next attribute read.
    if (this._group == null) {
      const group = this._layer.property(this.constructor._match_name);
      if (!(group instanceof PropertyGroup)) throw new AttributeError(`'${type_name(group)}' object has no attribute 'property'`);
      this._group = group;
    }
    const child = this._group.property(name);
    if (!(child instanceof Property)) throw new AttributeError(`'${type_name(child)}' object has no attribute 'value'`);
    return child;
  }

  __repr__(): string {
    const result = new Map<string, unknown>();
    // NOTE(port): descriptors_of walks the MRO but vars(cls) is the class's own dict; same result because no base class declares descriptors.
    for (const [name] of descriptors_of(this.constructor)) {
      result.set(name, getattr(this, name));
    }
    // NOTE(port): int/float — integral values are plain numbers by design (RULEBOOK §4); a float-valued option of 1.0 prints as "1" here where Python prints "1.0" (repr string only, never saved).
    const formatted = [...result].map(([key, value]) => `${key}=${str(value)}`).join(", ");
    return `<${Object.getPrototypeOf(this.constructor).name}(${formatted})>`;
  }
}

export class CubeMeshOptions extends ParametricMeshOptions {
  static _match_name = "ADBE CubeMeshOptionsSGrp";

  declare width: number;
  declare height: number;
  declare depth: number;
  declare smoothing_angle: number;
}
descriptor(CubeMeshOptions, "width", new ParaMeshField<number>("Width"));
descriptor(CubeMeshOptions, "height", new ParaMeshField<number>("Height"));
descriptor(CubeMeshOptions, "depth", new ParaMeshField<number>("Depth"));
descriptor(CubeMeshOptions, "smoothing_angle", new ParaMeshField<number>("Smoothing Angle"));
register(ParametricMeshType.CUBE)(CubeMeshOptions);

export class SphereMeshOptions extends ParametricMeshOptions {
  static _match_name = "ADBE SphereMeshOptionsSGrp";

  declare radius: number;
  declare sides: number;
  declare slice_caps: boolean;
  declare slice_start: number;
  declare slice_end: number;
  declare smoothing_angle: number;
}
descriptor(SphereMeshOptions, "radius", new ParaMeshField<number>("Radius"));
descriptor(SphereMeshOptions, "sides", new ParaMeshField<number>("Sides"));
descriptor(SphereMeshOptions, "slice_caps", new ParaMeshField<boolean>("Slice Caps"));
descriptor(SphereMeshOptions, "slice_start", new ParaMeshField<number>("Slice Start"));
descriptor(SphereMeshOptions, "slice_end", new ParaMeshField<number>("Slice End"));
descriptor(SphereMeshOptions, "smoothing_angle", new ParaMeshField<number>("Smoothing Angle"));
register(ParametricMeshType.SPHERE)(SphereMeshOptions);

export class PlaneMeshOptions extends ParametricMeshOptions {
  static _match_name = "ADBE PlaneMeshOptionsSGrp";

  declare width: number;
  declare length: number;
  declare corner_radius: number;
  declare corner_sides: number;
}
descriptor(PlaneMeshOptions, "width", new ParaMeshField<number>("Width"));
descriptor(PlaneMeshOptions, "length", new ParaMeshField<number>("Length"));
descriptor(PlaneMeshOptions, "corner_radius", new ParaMeshField<number>("Corner Radius"));
descriptor(PlaneMeshOptions, "corner_sides", new ParaMeshField<number>("Corner Sides"));
register(ParametricMeshType.PLANE)(PlaneMeshOptions);

export class TorusMeshOptions extends ParametricMeshOptions {
  static _match_name = "ADBE TorusMeshOptionsSGrp";

  declare ring_radius: number;
  declare pipe_radius: number;
  declare ring_sides: number;
  declare pipe_sides: number;
  declare caps: boolean;
  declare slice_start: number;
  declare slice_end: number;
  declare smoothing_angle: number;
}
descriptor(TorusMeshOptions, "ring_radius", new ParaMeshField<number>("Ring Radius"));
descriptor(TorusMeshOptions, "pipe_radius", new ParaMeshField<number>("Pipe Radius"));
descriptor(TorusMeshOptions, "ring_sides", new ParaMeshField<number>("Ring Sides"));
descriptor(TorusMeshOptions, "pipe_sides", new ParaMeshField<number>("Pipe Sides"));
descriptor(TorusMeshOptions, "caps", new ParaMeshField<boolean>("Caps"));
descriptor(TorusMeshOptions, "slice_start", new ParaMeshField<number>("Slice Start"));
descriptor(TorusMeshOptions, "slice_end", new ParaMeshField<number>("Slice End"));
descriptor(TorusMeshOptions, "smoothing_angle", new ParaMeshField<number>("Smoothing Angle"));
register(ParametricMeshType.TORUS)(TorusMeshOptions);

export class ConeMeshOptions extends ParametricMeshOptions {
  static _match_name = "ADBE ConeMeshOptionsSGrp";

  declare top_radius: number;
  declare bottom_radius: number;
  declare height: number;
  declare sides: number;
  declare top_cap: boolean;
  declare bottom_cap: boolean;
  declare slice_caps: boolean;
  declare slice_start: number;
  declare slice_end: number;
  declare smoothing_angle: number;
}
descriptor(ConeMeshOptions, "top_radius", new ParaMeshField<number>("Top Radius"));
descriptor(ConeMeshOptions, "bottom_radius", new ParaMeshField<number>("Bottom Radius"));
descriptor(ConeMeshOptions, "height", new ParaMeshField<number>("Height"));
descriptor(ConeMeshOptions, "sides", new ParaMeshField<number>("Sides"));
descriptor(ConeMeshOptions, "top_cap", new ParaMeshField<boolean>("Top Cap"));
descriptor(ConeMeshOptions, "bottom_cap", new ParaMeshField<boolean>("Bottom Cap"));
descriptor(ConeMeshOptions, "slice_caps", new ParaMeshField<boolean>("Slice Caps"));
descriptor(ConeMeshOptions, "slice_start", new ParaMeshField<number>("Slice Start"));
descriptor(ConeMeshOptions, "slice_end", new ParaMeshField<number>("Slice End"));
descriptor(ConeMeshOptions, "smoothing_angle", new ParaMeshField<number>("Smoothing Angle"));
register(ParametricMeshType.CONE)(ConeMeshOptions);

export class CylinderMeshOptions extends ParametricMeshOptions {
  static _match_name = "ADBE CylinderMeshOptionsSGrp";

  declare radius: number;
  declare height: number;
  declare sides: number;
  declare top_cap: boolean;
  declare bottom_cap: boolean;
  declare slice_caps: boolean;
  declare slice_start: number;
  declare slice_end: number;
  declare smoothing_angle: number;
}
descriptor(CylinderMeshOptions, "radius", new ParaMeshField<number>("Radius"));
descriptor(CylinderMeshOptions, "height", new ParaMeshField<number>("Height"));
descriptor(CylinderMeshOptions, "sides", new ParaMeshField<number>("Sides"));
descriptor(CylinderMeshOptions, "top_cap", new ParaMeshField<boolean>("Top Cap"));
descriptor(CylinderMeshOptions, "bottom_cap", new ParaMeshField<boolean>("Bottom Cap"));
descriptor(CylinderMeshOptions, "slice_caps", new ParaMeshField<boolean>("Slice Caps"));
descriptor(CylinderMeshOptions, "slice_start", new ParaMeshField<number>("Slice Start"));
descriptor(CylinderMeshOptions, "slice_end", new ParaMeshField<number>("Slice End"));
descriptor(CylinderMeshOptions, "smoothing_angle", new ParaMeshField<number>("Smoothing Angle"));
register(ParametricMeshType.CYLINDER)(CylinderMeshOptions);

/**
 * The ParametricBevelOptions object represents the bevel options for a parametric mesh layer.
 *
 * Info:
 *     This functionality was added in After Effects 26.0
 */
export class ParametricBevelOptions extends ParametricMeshOptions {}

export class CubeBevelOptions extends ParametricBevelOptions {
  static _match_name = "ADBE CubeBevelOptionsSGrp";

  declare radius: number;
  declare sides: number;
}
descriptor(CubeBevelOptions, "radius", new ParaMeshField<number>("Radius"));
descriptor(CubeBevelOptions, "sides", new ParaMeshField<number>("Sides"));
register_bevel(ParametricMeshType.CUBE)(CubeBevelOptions);

export class ConeBevelOptions extends ParametricBevelOptions {
  static _match_name = "ADBE ConeBevelBevelSGrp";

  declare top_radius: number;
  declare top_sides: number;
  declare bottom_radius: number;
  declare bottom_sides: number;
}
descriptor(ConeBevelOptions, "top_radius", new ParaMeshField<number>("Top Radius"));
descriptor(ConeBevelOptions, "top_sides", new ParaMeshField<number>("Top Sides"));
descriptor(ConeBevelOptions, "bottom_radius", new ParaMeshField<number>("Bottom Radius"));
descriptor(ConeBevelOptions, "bottom_sides", new ParaMeshField<number>("Bottom Sides"));
register_bevel(ParametricMeshType.CONE)(ConeBevelOptions);

export class CylinderBevelOptions extends ParametricBevelOptions {
  static _match_name = "ADBE CylinderBevelOptionsSGrp";

  declare radius: number;
  declare sides: number;
}
descriptor(CylinderBevelOptions, "radius", new ParaMeshField<number>("Radius"));
descriptor(CylinderBevelOptions, "sides", new ParaMeshField<number>("Sides"));
register_bevel(ParametricMeshType.CYLINDER)(CylinderBevelOptions);
