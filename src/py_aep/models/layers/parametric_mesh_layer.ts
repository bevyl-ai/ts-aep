// Port of py_aep/models/layers/parametric_mesh_layer.py

import { INSPECT } from "../../../pyrt/index.ts";
import { LayerType, ParametricMeshType } from "../../enums/index.ts";
import { _PARAMETRIC_MESH_ACTIVE_GROUPS } from "../../synthesis/property.ts";
import {
  AttributeError,
  typeName,
  descriptor,
  descriptorsOf,
  getattr,
  type ClassAttributes,
} from "../../../pyrt/index.ts";
import { ChunkField, type EffectParamDefs } from "../descriptors.ts";
import { labelIndex } from "../preferences.ts";
import { AVLayer } from "./av_layer.ts";
import type { CompItem } from "../items/composition.ts";
import { Property } from "../properties/property.ts";
import { PropertyGroup } from "../properties/property_group.ts";

/** Keyword arguments of `ParametricMeshLayer._new`. */
type ParametricMeshLayerNewKw = {
  name: string;
  layerId: number;
  duration: number;
  containingComp: CompItem;
  meshType: ParametricMeshType;
  effectParamDefs?: EffectParamDefs | null;
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
 * const mesh = comp.parametricMeshLayers[0];
 * console.log(mesh.name);
 * ```
 * @see https://ae-scripting.docsforadobe.dev/layer/parametricmeshlayer/
 */
export class ParametricMeshLayer extends AVLayer {
  // NOTE(port): Layer.__init__ -> PropertyBase.__init__ assigns instance `_auto_name = None`, shadowing this class attribute in Python too; AVLayer.name's `self._auto_name` therefore sees None in both.
  static _autoName: string = "Mesh Layer";

  /** For a parametric mesh layer, its mesh type. Read / write. */
  declare parametricMeshType: ParametricMeshType;

  /** The ParametricMeshOptions object represents the options for a parametric mesh layer. */
  declare parametricMeshOptions: ParametricMeshOptions;

  /** The ParametricBevelOptions object represents the bevel options for a parametric mesh layer. */
  declare parametricBevelOptions: ParametricBevelOptions;

  constructor(...args: ConstructorParameters<typeof AVLayer>) {
    super(...args);
    this._updateOptions();
  }

  // Python `# type: ignore[override]`: keyword shape differs from AVLayer._new's; overloads keep the base static side assignable.
  static _new(kw: ParametricMeshLayerNewKw): ParametricMeshLayer;
  static _new(...args: never[]): never;
  static _new(kw: ParametricMeshLayerNewKw): ParametricMeshLayer {
    const { name, layerId, duration, containingComp, meshType, effectParamDefs = null } = kw;
    const layer = super._new<ParametricMeshLayer>({
      name,
      layerId,
      duration,
      containingComp,
      effectParamDefs,
    });
    layer._ldta.layerType = LayerType.PARAMETRIC_MESH;
    layer._ldta.label = labelIndex(containingComp._project._preferences, "Parametrics Label Index", 9);
    layer._ldta.threeDLayer = true;
    layer._ldta.collapseTransformation = true;
    // AE writes flags2=0x83 for mesh layers: effects are not applicable.
    layer._ldta.effectsActive = false;
    // AE expresses the layer's time fields in the comp's internal
    // timebase (e.g. 23976 for 29.97 fps), not a reduced rational.
    const timeBase = containingComp._cdta.internalTimebase;
    layer._ldta.startTimeDivisor = timeBase;
    layer._ldta.inPointDivisor = timeBase;
    layer._ldta.outPointDividend = Math.round(duration * timeBase);
    layer._ldta.outPointDivisor = timeBase;
    layer.parametricMeshType = meshType;
    // AE writes the active mesh type's option/bevel groups expanded
    // (tdsb=1) while the other mesh groups stay collapsed (tdsb=3, the
    // synthesized default). Override the active groups before the layer
    // is materialized so the written tdsb matches AE.
    const activeGroups = _PARAMETRIC_MESH_ACTIVE_GROUPS.get(ParametricMeshType.toBinary(meshType)) ?? [];
    for (const child of layer.properties) {
      if (activeGroups.includes(child.matchName) && child._tdsb != null) {
        child._tdsb._enableFlags = 1;
      }
    }
    return layer;
  }

  /** Update the parametric mesh options from the layer's current state. */
  _updateOptions(): void {
    // Plain instance attributes, read as own properties (Python's
    // `__dict__`): `getattr` on a missing one would search the layer's
    // properties for that name.
    const optionsCls = OPTION_TYPES.get(this._ldta.lightAndMeshType) ?? null;
    const oldOptions = Object.hasOwn(this, "parametricMeshOptions") ? this.parametricMeshOptions : null;
    if (oldOptions == null || oldOptions.constructor !== optionsCls) {
      Reflect.deleteProperty(this, "parametricMeshOptions");
      if (optionsCls != null) {
        this.parametricMeshOptions = new optionsCls(this);
      }
    }

    const bevelCls = BEVEL_OPTION_TYPES.get(this._ldta.lightAndMeshType) ?? null;
    const oldBevel = Object.hasOwn(this, "parametricBevelOptions") ? this.parametricBevelOptions : null;
    if (oldBevel == null || oldBevel.constructor !== bevelCls) {
      Reflect.deleteProperty(this, "parametricBevelOptions");
      if (bevelCls != null) {
        this.parametricBevelOptions = new bevelCls(this);
      }
    }
  }

  /**
   * `false` for Parametric Mesh layers: collapse transformation is
   * forced on and cannot be changed. Read-only.
   */
  get canSetCollapseTransformation(): boolean {
    return false;
  }

  /** `false` for Parametric Mesh layers (time remapping is not supported). Read-only. */
  get canSetTimeRemapEnabled(): boolean {
    return false;
  }

  static {
    // Class-body `ChunkField` assignment in Python, installed as a descriptor.
    descriptor(this, "parametricMeshType", ChunkField.enum(ParametricMeshType, "_ldta", "lightAndMeshType", {
      postSet: (obj: ParametricMeshLayer) => obj._updateOptions(),
    }));
  }
}

// Keyed by the raw ldta value (0-5, `ParametricMeshType.to_binary()`) so
// unknown mesh types from newer AE versions look up as None instead of raising.
export const OPTION_TYPES: Map<number, typeof ParametricMeshOptions> = new Map();
export const BEVEL_OPTION_TYPES: Map<number, typeof ParametricBevelOptions> = new Map();

/** Decorator that registers a ParametricMeshOptions subclass for one mesh_type. */
export function register(meshType: ParametricMeshType) {
  function decorator<M extends typeof ParametricMeshOptions>(cls: M): M {
    OPTION_TYPES.set(ParametricMeshType.toBinary(meshType), cls);
    return cls;
  }
  return decorator;
}

/** Decorator that registers a ParametricBevelOptions subclass for one mesh_type. */
export function registerBevel(meshType: ParametricMeshType) {
  function decorator<B extends typeof ParametricBevelOptions>(cls: B): B {
    BEVEL_OPTION_TYPES.set(ParametricMeshType.toBinary(meshType), cls);
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
  declare _propertyName: string;

  constructor(propertyName: string) {
    this._propertyName = propertyName;
  }

  get(obj: ParametricMeshOptions | ParametricBevelOptions | null, objtype: Function): T | this {
    if (obj == null) return this;
    const value = obj._properties(this._propertyName).value;
    return value;
  }

  set(obj: ParametricMeshOptions | ParametricBevelOptions, value: T): void {
    obj._properties(this._propertyName).value = value;
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
  static _matchName: string;

  declare _layer: ParametricMeshLayer;
  declare _group: PropertyGroup | null;

  constructor(layer: ParametricMeshLayer) {
    this._layer = layer;
    this._group = null;
  }

  _properties(name: string): Property {
    // Python casts both lookups; a wrong kind fails at its next attribute read.
    if (this._group == null) {
      const group = this._layer.property(this.constructor._matchName);
      if (!(group instanceof PropertyGroup)) throw new AttributeError(`'${typeName(group)}' object has no attribute 'property'`);
      this._group = group;
    }
    const child = this._group.property(name);
    if (!(child instanceof Property)) throw new AttributeError(`'${typeName(child)}' object has no attribute 'value'`);
    return child;
  }

  [INSPECT](): string {
    const result = new Map<string, number | boolean>();
    // NOTE(port): descriptors_of walks the MRO but vars(cls) is the class's own dict; same result because no base class declares descriptors.
    for (const [name] of descriptorsOf(this.constructor)) {
      result.set(name, getattr(this, name));
    }
    // NOTE(port): int/float — integral values are plain numbers by design (RULEBOOK §4); a float-valued option of 1.0 prints as "1" here where Python prints "1.0" (repr string only, never saved).
    const formatted = [...result].map(([key, value]) => `${key}=${String(value)}`).join(", ");
    return `<${Object.getPrototypeOf(this.constructor).name}(${formatted})>`;
  }
}

export class CubeMeshOptions extends ParametricMeshOptions {
  static _matchName = "ADBE CubeMeshOptionsSGrp";

  declare width: number;
  declare height: number;
  declare depth: number;
  declare smoothingAngle: number;

  static {
    descriptor(this, "width", new ParaMeshField<number>("Width"));
    descriptor(this, "height", new ParaMeshField<number>("Height"));
    descriptor(this, "depth", new ParaMeshField<number>("Depth"));
    descriptor(this, "smoothingAngle", new ParaMeshField<number>("Smoothing Angle"));
  }
}
register(ParametricMeshType.CUBE)(CubeMeshOptions);

export class SphereMeshOptions extends ParametricMeshOptions {
  static _matchName = "ADBE SphereMeshOptionsSGrp";

  declare radius: number;
  declare sides: number;
  declare sliceCaps: boolean;
  declare sliceStart: number;
  declare sliceEnd: number;
  declare smoothingAngle: number;

  static {
    descriptor(this, "radius", new ParaMeshField<number>("Radius"));
    descriptor(this, "sides", new ParaMeshField<number>("Sides"));
    descriptor(this, "sliceCaps", new ParaMeshField<boolean>("Slice Caps"));
    descriptor(this, "sliceStart", new ParaMeshField<number>("Slice Start"));
    descriptor(this, "sliceEnd", new ParaMeshField<number>("Slice End"));
    descriptor(this, "smoothingAngle", new ParaMeshField<number>("Smoothing Angle"));
  }
}
register(ParametricMeshType.SPHERE)(SphereMeshOptions);

export class PlaneMeshOptions extends ParametricMeshOptions {
  static _matchName = "ADBE PlaneMeshOptionsSGrp";

  declare width: number;
  declare length: number;
  declare cornerRadius: number;
  declare cornerSides: number;

  static {
    descriptor(this, "width", new ParaMeshField<number>("Width"));
    descriptor(this, "length", new ParaMeshField<number>("Length"));
    descriptor(this, "cornerRadius", new ParaMeshField<number>("Corner Radius"));
    descriptor(this, "cornerSides", new ParaMeshField<number>("Corner Sides"));
  }
}
register(ParametricMeshType.PLANE)(PlaneMeshOptions);

export class TorusMeshOptions extends ParametricMeshOptions {
  static _matchName = "ADBE TorusMeshOptionsSGrp";

  declare ringRadius: number;
  declare pipeRadius: number;
  declare ringSides: number;
  declare pipeSides: number;
  declare caps: boolean;
  declare sliceStart: number;
  declare sliceEnd: number;
  declare smoothingAngle: number;

  static {
    descriptor(this, "ringRadius", new ParaMeshField<number>("Ring Radius"));
    descriptor(this, "pipeRadius", new ParaMeshField<number>("Pipe Radius"));
    descriptor(this, "ringSides", new ParaMeshField<number>("Ring Sides"));
    descriptor(this, "pipeSides", new ParaMeshField<number>("Pipe Sides"));
    descriptor(this, "caps", new ParaMeshField<boolean>("Caps"));
    descriptor(this, "sliceStart", new ParaMeshField<number>("Slice Start"));
    descriptor(this, "sliceEnd", new ParaMeshField<number>("Slice End"));
    descriptor(this, "smoothingAngle", new ParaMeshField<number>("Smoothing Angle"));
  }
}
register(ParametricMeshType.TORUS)(TorusMeshOptions);

export class ConeMeshOptions extends ParametricMeshOptions {
  static _matchName = "ADBE ConeMeshOptionsSGrp";

  declare topRadius: number;
  declare bottomRadius: number;
  declare height: number;
  declare sides: number;
  declare topCap: boolean;
  declare bottomCap: boolean;
  declare sliceCaps: boolean;
  declare sliceStart: number;
  declare sliceEnd: number;
  declare smoothingAngle: number;

  static {
    descriptor(this, "topRadius", new ParaMeshField<number>("Top Radius"));
    descriptor(this, "bottomRadius", new ParaMeshField<number>("Bottom Radius"));
    descriptor(this, "height", new ParaMeshField<number>("Height"));
    descriptor(this, "sides", new ParaMeshField<number>("Sides"));
    descriptor(this, "topCap", new ParaMeshField<boolean>("Top Cap"));
    descriptor(this, "bottomCap", new ParaMeshField<boolean>("Bottom Cap"));
    descriptor(this, "sliceCaps", new ParaMeshField<boolean>("Slice Caps"));
    descriptor(this, "sliceStart", new ParaMeshField<number>("Slice Start"));
    descriptor(this, "sliceEnd", new ParaMeshField<number>("Slice End"));
    descriptor(this, "smoothingAngle", new ParaMeshField<number>("Smoothing Angle"));
  }
}
register(ParametricMeshType.CONE)(ConeMeshOptions);

export class CylinderMeshOptions extends ParametricMeshOptions {
  static _matchName = "ADBE CylinderMeshOptionsSGrp";

  declare radius: number;
  declare height: number;
  declare sides: number;
  declare topCap: boolean;
  declare bottomCap: boolean;
  declare sliceCaps: boolean;
  declare sliceStart: number;
  declare sliceEnd: number;
  declare smoothingAngle: number;

  static {
    descriptor(this, "radius", new ParaMeshField<number>("Radius"));
    descriptor(this, "height", new ParaMeshField<number>("Height"));
    descriptor(this, "sides", new ParaMeshField<number>("Sides"));
    descriptor(this, "topCap", new ParaMeshField<boolean>("Top Cap"));
    descriptor(this, "bottomCap", new ParaMeshField<boolean>("Bottom Cap"));
    descriptor(this, "sliceCaps", new ParaMeshField<boolean>("Slice Caps"));
    descriptor(this, "sliceStart", new ParaMeshField<number>("Slice Start"));
    descriptor(this, "sliceEnd", new ParaMeshField<number>("Slice End"));
    descriptor(this, "smoothingAngle", new ParaMeshField<number>("Smoothing Angle"));
  }
}
register(ParametricMeshType.CYLINDER)(CylinderMeshOptions);

/**
 * The ParametricBevelOptions object represents the bevel options for a parametric mesh layer.
 *
 * Info:
 *     This functionality was added in After Effects 26.0
 */
export class ParametricBevelOptions extends ParametricMeshOptions {}

export class CubeBevelOptions extends ParametricBevelOptions {
  static _matchName = "ADBE CubeBevelOptionsSGrp";

  declare radius: number;
  declare sides: number;

  static {
    descriptor(this, "radius", new ParaMeshField<number>("Radius"));
    descriptor(this, "sides", new ParaMeshField<number>("Sides"));
  }
}
registerBevel(ParametricMeshType.CUBE)(CubeBevelOptions);

export class ConeBevelOptions extends ParametricBevelOptions {
  static _matchName = "ADBE ConeBevelBevelSGrp";

  declare topRadius: number;
  declare topSides: number;
  declare bottomRadius: number;
  declare bottomSides: number;

  static {
    descriptor(this, "topRadius", new ParaMeshField<number>("Top Radius"));
    descriptor(this, "topSides", new ParaMeshField<number>("Top Sides"));
    descriptor(this, "bottomRadius", new ParaMeshField<number>("Bottom Radius"));
    descriptor(this, "bottomSides", new ParaMeshField<number>("Bottom Sides"));
  }
}
registerBevel(ParametricMeshType.CONE)(ConeBevelOptions);

export class CylinderBevelOptions extends ParametricBevelOptions {
  static _matchName = "ADBE CylinderBevelOptionsSGrp";

  declare radius: number;
  declare sides: number;

  static {
    descriptor(this, "radius", new ParaMeshField<number>("Radius"));
    descriptor(this, "sides", new ParaMeshField<number>("Sides"));
  }
}
registerBevel(ParametricMeshType.CYLINDER)(CylinderBevelOptions);
