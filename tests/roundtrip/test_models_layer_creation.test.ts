/** Tests for CompItem layer creation methods. */

import { describe, expect, test } from "bun:test";
import { Path, TypeError_, ValueError, contains, len, py_assert, py_eq } from "../../src/pyrt/index.ts";
import { approx, make_tmp_path, raises } from "../../src/pyrt/pytest.ts";
import { new as new_, parse as parse_aep } from "../../src/py_aep/index.ts";
import { LineOrientation } from "../../src/py_aep/enums/index.ts";
import { AVLayer } from "../../src/py_aep/models/layers/av_layer.ts";
import { CameraLayer } from "../../src/py_aep/models/layers/camera_layer.ts";
import { LightLayer } from "../../src/py_aep/models/layers/light_layer.ts";
import { ShapeLayer } from "../../src/py_aep/models/layers/shape_layer.ts";
import { TextLayer } from "../../src/py_aep/models/layers/text_layer.ts";
import { Property } from "../../src/py_aep/models/properties/property.ts";
import { FolderItem } from "../../src/py_aep/models/items/folder.ts";
import { FootageItem } from "../../src/py_aep/models/items/footage.ts";
import { SolidSource } from "../../src/py_aep/models/sources/solid.ts";
import "../../src/py_aep/binary/_register.ts";
import { as_instance } from "../helpers.ts";

const SAMPLES_DIR = new Path(import.meta.dir, "..", "..", "samples", "models");

// Use comp_misc.aep which has a 0-layer comp named "comment" (100x100, 1s)
const EMPTY_COMP_AEP = SAMPLES_DIR.div("composition", "comp_misc.aep");

// ---------------------------------------------------------------------------
// add_null
// ---------------------------------------------------------------------------

describe("TestAddNull", () => {
  test("test_returns_av_layer", () => {
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const layer = comp.addNull();
    expect(layer instanceof AVLayer).toBe(true);
  });

  test("test_null_layer_flag", () => {
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const layer = comp.addNull();
    expect(layer.nullLayer).toBe(true);
  });

  test("test_auto_name", () => {
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const n1 = comp.addNull();
    const n2 = comp.addNull();
    expect(n1.name).toBe("Null 1");
    expect(n2.name).toBe("Null 2");
  });

  test("test_added_at_top", () => {
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const n1 = comp.addNull();
    const n2 = comp.addNull();
    expect(comp.layers[0]).toBe(n2);
    expect(comp.layers[1]).toBe(n1);
  });

  test("test_layer_count", () => {
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    expect(len(comp.layers)).toBe(0);
    comp.addNull();
    expect(len(comp.layers)).toBe(1);
  });

  test("test_duration_defaults_to_comp", () => {
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const layer = comp.addNull();
    expect(approx(layer.outPoint, comp.duration)).toBe(true);
  });

  test("test_custom_duration_honored", () => {
    // py_aep honors an explicit duration (unlike AE's addNull, which
    // ignores it); the layer out-point is the requested span.
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const layer = comp.addNull(0.5);
    expect(approx(layer.outPoint, 0.5)).toBe(true);
  });

  test("test_has_source", () => {
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const layer = comp.addNull();
    py_assert(layer.source != null);
    expect(layer.source.name).toBe("Null 1");
  });

  test("test_source_matches_ae_null_solid", () => {
    // layer_misc.aep holds a null made by AE's addNull: a white 100x100
    // solid.
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("layer", "layer_misc.aep"));
    const ae_solid = as_instance(app.project.footages.find((f) => f.name === "Null 1"), FootageItem);
    const layer = app.project.compositions[0].addNull();
    app.project.save(tmp_path.div("out.aep"));
    const solid = as_instance(
      parse_aep(tmp_path.div("out.aep")).project.footages.find(
        (f) => f.id === as_instance(layer.source, FootageItem).id,
      ),
      FootageItem,
    );
    const solid_color = as_instance(solid.mainSource, SolidSource).color;
    const ae_solid_color = as_instance(ae_solid.mainSource, SolidSource).color;
    expect(py_eq(solid_color, ae_solid_color)).toBe(true);
    expect(py_eq(ae_solid_color, [1.0, 1.0, 1.0])).toBe(true);
    expect(py_eq([solid.width, solid.height], [ae_solid.width, ae_solid.height])).toBe(true);
  });

  test("test_unique_ids_across_layers", () => {
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const n1 = comp.addNull();
    const n2 = comp.addNull();
    expect(n1.id).not.toBe(n2.id);
  });

  test("test_transform_exists", () => {
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const layer = comp.addNull();
    expect(layer.transform != null).toBe(true);
    expect(layer.transform.property("ADBE Position") != null).toBe(true);
    expect(layer.transform.property("ADBE Opacity") != null).toBe(true);
  });

  test("test_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const layer = comp.addNull();
    const layer_id = layer.id;

    app.project.save(tmp_path.div("out.aep"));
    const app2 = parse_aep(tmp_path.div("out.aep"));
    const comp2 = app2.project.compositions[0];

    expect(len(comp2.layers)).toBe(1);
    const lyr2 = comp2.layers[0];
    expect(lyr2.id).toBe(layer_id);
    expect(lyr2.nullLayer).toBe(true);
    expect(lyr2.name).toBe("Null 1");
  });
});

// ---------------------------------------------------------------------------
// add_shape
// ---------------------------------------------------------------------------

describe("TestAddShape", () => {
  test("test_returns_shape_layer", () => {
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const layer = comp.addShape();
    expect(layer instanceof ShapeLayer).toBe(true);
  });

  test("test_auto_name", () => {
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const s1 = comp.addShape();
    const s2 = comp.addShape();
    expect(s1.name).toBe("Shape Layer 1");
    expect(s2.name).toBe("Shape Layer 2");
  });

  test("test_added_at_top", () => {
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const s1 = comp.addShape();
    const s2 = comp.addShape();
    expect(comp.layers[0]).toBe(s2);
    expect(comp.layers[1]).toBe(s1);
  });

  test("test_transform_exists", () => {
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const layer = comp.addShape();
    expect(layer.transform != null).toBe(true);
  });

  test("test_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const layer = comp.addShape();
    const layer_id = layer.id;

    app.project.save(tmp_path.div("out.aep"));
    const app2 = parse_aep(tmp_path.div("out.aep"));
    const comp2 = app2.project.compositions[0];

    expect(len(comp2.layers)).toBe(1);
    const lyr2 = comp2.layers[0];
    expect(lyr2.id).toBe(layer_id);
    expect(lyr2 instanceof ShapeLayer).toBe(true);
    expect(lyr2.name).toBe("Shape Layer 1");
  });
});

// ---------------------------------------------------------------------------
// add_camera
// ---------------------------------------------------------------------------

describe("TestAddCamera", () => {
  test("test_returns_camera_layer", () => {
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const layer = comp.addCamera("MyCam", [50, 50]);
    expect(layer instanceof CameraLayer).toBe(true);
  });

  test("test_auto_name", () => {
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const c1 = comp.addCamera();
    const c2 = comp.addCamera();
    expect(c1.name).toBe("Camera 1");
    expect(c2.name).toBe("Camera 2");
  });

  test("test_center_point_sets_position", () => {
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const cam = comp.addCamera("Cam", [100, 200]);
    const pos = cam.transform.property("ADBE Position");
    expect(approx(pos.value[2], -138.8887, { rel: 1e-3 })).toBe(true);
  });

  test("test_center_point_sets_anchor", () => {
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const cam = comp.addCamera("Cam", [100, 200]);
    const anchor = cam.transform.property("ADBE Anchor Point");
    expect(approx(anchor.value[0], 100.0)).toBe(true);
    expect(approx(anchor.value[1], 200.0)).toBe(true);
  });

  test("test_default_center_point", () => {
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const cam = comp.addCamera("Cam");
    const anchor = cam.transform.property("ADBE Anchor Point");
    expect(approx(anchor.value[0], comp.width / 2)).toBe(true);
    expect(approx(anchor.value[1], comp.height / 2)).toBe(true);
  });

  test("test_zoom_uses_pixel_aspect", () => {
    // AE's default-50mm zoom is width * pixel_aspect / 0.72 (see the
    // "ZV" formula in binary/comp_skeleton.py).
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    comp.pixelAspect = 2.0;
    const cam = comp.addCamera("Cam");
    const pos = cam.transform.property("ADBE Position");
    expect(approx(pos.value[2], -comp.width * 2.0 / 0.72)).toBe(true);
  });

  test("test_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const cam = comp.addCamera("TestCam", [50, 50]);
    const cam_id = cam.id;

    app.project.save(tmp_path.div("out.aep"));
    const app2 = parse_aep(tmp_path.div("out.aep"));
    const comp2 = app2.project.compositions[0];

    expect(len(comp2.layers)).toBe(1);
    const lyr2 = comp2.layers[0];
    expect(lyr2.id).toBe(cam_id);
    expect(lyr2 instanceof CameraLayer).toBe(true);
    expect(lyr2.name).toBe("TestCam");
  });
});

// ---------------------------------------------------------------------------
// add_light
// ---------------------------------------------------------------------------

describe("TestAddLight", () => {
  test("test_returns_light_layer", () => {
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const layer = comp.addLight("MyLight", [50, 50]);
    expect(layer instanceof LightLayer).toBe(true);
  });

  test("test_auto_name", () => {
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const l1 = comp.addLight();
    const l2 = comp.addLight();
    expect(l1.name).toBe("Light 1");
    expect(l2.name).toBe("Light 2");
  });

  test("test_center_point_sets_position", () => {
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const light = comp.addLight("L", [300, 400]);
    const pos = light.transform.property("ADBE Position");
    expect(approx(pos.value[2], -69.4444, { rel: 1e-3 })).toBe(true);
  });

  test("test_zoom_uses_pixel_aspect", () => {
    // Lights share the camera's width * pixel_aspect / 0.72 zoom and
    // report position z as -zoom/2.
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    comp.pixelAspect = 2.0;
    const light = comp.addLight("L");
    const pos = light.transform.property("ADBE Position");
    expect(approx(pos.value[2], -comp.width * 2.0 / 0.72 / 2)).toBe(true);
  });

  test("test_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const light = comp.addLight("TestLight", [50, 50]);
    const light_id = light.id;

    app.project.save(tmp_path.div("out.aep"));
    const app2 = parse_aep(tmp_path.div("out.aep"));
    const comp2 = app2.project.compositions[0];

    expect(len(comp2.layers)).toBe(1);
    const lyr2 = comp2.layers[0];
    expect(lyr2.id).toBe(light_id);
    expect(lyr2 instanceof LightLayer).toBe(true);
    expect(lyr2.name).toBe("TestLight");
  });
});

// ---------------------------------------------------------------------------
// add_solid
// ---------------------------------------------------------------------------

describe("TestAddSolid", () => {
  test("test_returns_av_layer", () => {
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const layer = comp.addSolid([1.0, 0.0, 0.0], "RedSolid");
    expect(layer instanceof AVLayer).toBe(true);
  });

  test("test_name", () => {
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const layer = comp.addSolid([0.0, 1.0, 0.0], "GreenSolid");
    expect(layer.name).toBe("GreenSolid");
  });

  test("test_dimensions_default_to_comp", () => {
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const layer = comp.addSolid([0.0, 0.0, 1.0], "BlueSolid");
    expect(layer.width).toBe(comp.width);
    expect(layer.height).toBe(comp.height);
  });

  test("test_custom_dimensions", () => {
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const layer = comp.addSolid([1.0, 1.0, 0.0], "YellowSolid", 640, 480);
    expect(layer.width).toBe(640);
    expect(layer.height).toBe(480);
  });

  test("test_source_color", () => {
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const layer = comp.addSolid([1.0, 0.5, 0.0], "OrangeSolid");

    const source = as_instance(layer.source, FootageItem);
    expect(source.mainSource instanceof SolidSource).toBe(true);
    const color = as_instance(source.mainSource, SolidSource).color;
    expect(approx(color[0], 1.0)).toBe(true);
    expect(approx(color[1], 0.5)).toBe(true);
    expect(approx(color[2], 0.0)).toBe(true);
  });

  test("test_invalid_color_raises", () => {
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    raises(ValueError, () => comp.addSolid([2.0, 0.0, 0.0], "BadColor"));
  });

  test("test_malformed_color_with_auto_name_raises", () => {
    // The auto-name path subscripts the color; malformed input must
    // still surface as a validation error, not TypeError/IndexError.
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    raises(ValueError, () => comp.addSolid([0.2, 0.3]));
    raises(ValueError, () => comp.addSolid([2.0, 0.0, 0.0]));
    // @ts-expect-error a non-list color is rejected at runtime
    raises(TypeError_, () => comp.addSolid(0.5));
  });

  test("test_solid_in_solids_folder", () => {
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const layer = comp.addSolid([0.0, 0.0, 0.0], "BlackSolid");
    const solids_folder =
      app.project.rootFolder.items.find((item) => item.name === "Solids") ?? null;
    expect(solids_folder != null).toBe(true);
    expect(contains(as_instance(solids_folder, FolderItem).items, layer.source)).toBe(true);
  });

  /**
   * AE 2026 records the Solids folder it creates in `sfid` and keeps
   * filling it once renamed or moved into another folder.
   */
  test("test_solids_folder_tracked_by_id", () => {
    const tmp_path = make_tmp_path();
    const app = new_();
    let comp = app.project.rootFolder.addComp("C", 100, 100, 1.0, 1.0, 24.0);
    const first = comp.addSolid([1.0, 0.0, 0.0], "A");
    const folder = as_instance(as_instance(first.source, FootageItem).parentFolder, FolderItem);
    expect(app.project._solids_folder_id).toBe(folder.id);
    folder.name = "Renamed";
    const holder = app.project.rootFolder.addFolder("Holder");
    folder.parentFolder = holder;
    const out = tmp_path.div("solids.aep");
    app.project.save(out);

    const project = parse_aep(out).project;
    comp = project.compositions[0];
    const second = comp.addSolid([0.0, 1.0, 0.0], "B");
    expect(as_instance(as_instance(second.source, FootageItem).parentFolder, FolderItem).name).toBe("Renamed");
    expect(py_eq(project.rootFolder.folders.map((f) => f.name), ["Holder"])).toBe(true);
  });

  /**
   * With no recorded id, AE 2026 reuses a root folder carrying the
   * Solids name and leaves `sfid` at 0.
   */
  test("test_solids_folder_found_by_name_keeps_id_unset", () => {
    const app = new_();
    const existing = app.project.rootFolder.addFolder("Solids");
    const comp = app.project.rootFolder.addComp("C", 100, 100, 1.0, 1.0, 24.0);
    const layer = comp.addSolid([1.0, 0.0, 0.0], "A");
    expect(as_instance(layer.source, FootageItem).parentFolder).toBe(existing);
    expect(app.project._solids_folder_id).toBe(0);
  });

  test("test_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const layer = comp.addSolid([1.0, 0.0, 0.0], "RedSolid", 200, 200);
    const layer_id = layer.id;

    app.project.save(tmp_path.div("out.aep"));
    const app2 = parse_aep(tmp_path.div("out.aep"));
    const comp2 = app2.project.compositions[0];

    expect(len(comp2.layers)).toBe(1);
    const lyr2 = comp2.layers[0];
    expect(lyr2.id).toBe(layer_id);
    expect(lyr2 instanceof AVLayer).toBe(true);
    expect(lyr2.name).toBe("RedSolid");
    expect(as_instance(lyr2, AVLayer).width).toBe(200);
    expect(as_instance(lyr2, AVLayer).height).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// add (generic item)
// ---------------------------------------------------------------------------

describe("TestAddItem", () => {
  test("test_add_comp_as_layer", () => {
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const other_comp = app.project.compositions[1];
    const layer = comp.add(other_comp);
    expect(layer instanceof AVLayer).toBe(true);
    expect(layer.source).toBe(other_comp);
  });

  test("test_add_invalid_item_raises", () => {
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    // @ts-expect-error a folder is not an AVItem (type: ignore[arg-type])
    raises(ValueError, () => comp.add(app.project.rootFolder));
  });

  test("test_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const other_comp = app.project.compositions[1];
    const layer = comp.add(other_comp);
    const layer_id = layer.id;

    app.project.save(tmp_path.div("out.aep"));
    const app2 = parse_aep(tmp_path.div("out.aep"));
    const comp2 = app2.project.compositions[0];

    expect(len(comp2.layers)).toBe(1);
    const lyr2 = comp2.layers[0];
    expect(lyr2.id).toBe(layer_id);
    expect(lyr2 instanceof AVLayer).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Mixed creation
// ---------------------------------------------------------------------------

describe("TestMixedLayerCreation", () => {
  test("test_multiple_types_in_one_comp", () => {
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];

    const null_ = comp.addNull();
    const solid = comp.addSolid([1.0, 0.0, 0.0], "Red", 100, 100);
    const cam = comp.addCamera("Cam", [50, 50]);
    const light = comp.addLight("Light", [50, 50]);
    const shape = comp.addShape();

    expect(len(comp.layers)).toBe(5);
    // Newest at top
    expect(comp.layers[0]).toBe(shape);
    expect(comp.layers[1]).toBe(light);
    expect(comp.layers[2]).toBe(cam);
    expect(comp.layers[3]).toBe(solid);
    expect(comp.layers[4]).toBe(null_);
  });

  test("test_unique_ids", () => {
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const layers = [
      comp.addNull(),
      comp.addSolid([0.0, 0.0, 0.0], "Black", 100, 100),
      comp.addCamera("Cam", [50, 50]),
      comp.addLight("Light", [50, 50]),
      comp.addShape(),
    ];
    const ids = layers.map((lyr) => lyr.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("test_multiple_types_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];

    const null_ = comp.addNull();
    const solid = comp.addSolid([1.0, 0.0, 0.0], "Red", 100, 100);
    const cam = comp.addCamera("Cam", [50, 50]);
    const light = comp.addLight("Light", [50, 50]);
    const shape = comp.addShape();

    const ids = [shape.id, light.id, cam.id, solid.id, null_.id];

    app.project.save(tmp_path.div("out.aep"));
    const app2 = parse_aep(tmp_path.div("out.aep"));
    const comp2 = app2.project.compositions[0];

    expect(len(comp2.layers)).toBe(5);
    const roundtrip_ids = comp2.layers.map((lyr) => lyr.id);
    expect(py_eq(roundtrip_ids, ids)).toBe(true);
  });

  test("test_add_to_comp_with_existing_layers", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(SAMPLES_DIR.div("layer", "layer_misc.aep"));
    const comp = app.project.compositions[0];
    const original_count = len(comp.layers);
    expect(original_count).toBe(1);

    const new_layer = comp.addNull();
    expect(len(comp.layers)).toBe(2);
    expect(comp.layers[0]).toBe(new_layer);

    app.project.save(tmp_path.div("out.aep"));
    const app2 = parse_aep(tmp_path.div("out.aep"));
    const comp2 = app2.project.compositions[0];
    expect(len(comp2.layers)).toBe(2);
    expect(comp2.layers[0].nullLayer).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// add_text
// ---------------------------------------------------------------------------

describe("TestAddText", () => {
  test("test_returns_text_layer", () => {
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const layer = comp.addText("Hello");
    expect(layer instanceof TextLayer).toBe(true);
  });

  test("test_text_content", () => {
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const layer = comp.addText("Hello World");
    py_assert(layer.text != null);
    const st = layer.text.property("ADBE Text Document");
    expect(st instanceof Property).toBe(true);
    expect(st.value != null).toBe(true);
    expect(st.value.text).toBe("Hello World");
  });

  test("test_auto_name_when_empty", () => {
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const t1 = comp.addText();
    const t2 = comp.addText();
    expect(t1.name).toBe("Text 1");
    expect(t2.name).toBe("Text 2");
  });

  test("test_name_from_text", () => {
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const layer = comp.addText("My Title");
    expect(layer.name).toBe("My Title");
  });

  test("test_default_font_size", () => {
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const layer = comp.addText("Test");
    py_assert(layer.text != null);
    const st = layer.text.property("ADBE Text Document");
    expect(approx(st.value.fontSize, 36.0)).toBe(true);
  });

  test("test_custom_font_size", () => {
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const layer = comp.addText("Big Text");
    py_assert(layer.text != null);
    const st = layer.text.property("ADBE Text Document");
    const td = st.value;
    td.fontSize = 72.0;
    expect(approx(st.value.fontSize, 72.0)).toBe(true);
  });

  test("test_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const layer = comp.addText("Hello World");
    const layer_id = layer.id;

    app.project.save(tmp_path.div("out.aep"));
    const app2 = parse_aep(tmp_path.div("out.aep"));
    const comp2 = app2.project.compositions[0];

    expect(len(comp2.layers)).toBe(1);
    const lyr2 = comp2.layers[0];
    expect(lyr2.id).toBe(layer_id);
    expect(lyr2 instanceof TextLayer).toBe(true);
    py_assert(lyr2.text != null);
    const st = lyr2.text.property("ADBE Text Document");
    expect(st.value.text).toBe("Hello World");
  });

  test("test_roundtrip_custom_font_size", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const layer = comp.addText("Sized");
    py_assert(layer.text != null);
    const st = layer.text.property("ADBE Text Document");
    const td = st.value;
    td.fontSize = 48.0;

    app.project.save(tmp_path.div("out.aep"));
    const app2 = parse_aep(tmp_path.div("out.aep"));
    const comp2 = app2.project.compositions[0];

    const text2 = comp2.layers[0].text;
    py_assert(text2 != null);
    const st2 = text2.property("ADBE Text Document");
    expect(approx(st2.value.fontSize, 48.0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// add_box_text
// ---------------------------------------------------------------------------

describe("TestAddBoxText", () => {
  test("test_returns_text_layer", () => {
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const layer = comp.addBoxText([400, 200], "Box");
    expect(layer instanceof TextLayer).toBe(true);
  });

  test("test_text_content", () => {
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const layer = comp.addBoxText([400, 200], "Paragraph Text");
    py_assert(layer.text != null);
    const st = layer.text.property("ADBE Text Document");
    expect(st.value.text).toBe("Paragraph Text");
  });

  test("test_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const layer = comp.addBoxText([400, 200], "Box Text");
    const layer_id = layer.id;

    app.project.save(tmp_path.div("out.aep"));
    const app2 = parse_aep(tmp_path.div("out.aep"));
    const comp2 = app2.project.compositions[0];

    expect(len(comp2.layers)).toBe(1);
    const lyr2 = comp2.layers[0];
    expect(lyr2.id).toBe(layer_id);
    expect(lyr2 instanceof TextLayer).toBe(true);
    py_assert(lyr2.text != null);
    const st = lyr2.text.property("ADBE Text Document");
    expect(st.value.text).toBe("Box Text");
  });
});

// ---------------------------------------------------------------------------
// add_vertical_text
// ---------------------------------------------------------------------------

describe("TestAddVerticalText", () => {
  test("test_returns_text_layer", () => {
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const layer = comp.addVerticalText("Hello");
    expect(layer instanceof TextLayer).toBe(true);
  });

  test("test_orientation_and_point_text", () => {
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const layer = comp.addVerticalText("Hello");
    py_assert(layer.text != null);
    const td = layer.text.property("ADBE Text Document").value;
    expect(td.text).toBe("Hello");
    expect(td.lineOrientation).toBe(LineOrientation.VERTICAL_RIGHT_TO_LEFT);
    expect(td.pointText).toBe(true);
  });

  test("test_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const layer = comp.addVerticalText("Vertical");
    const layer_id = layer.id;

    app.project.save(tmp_path.div("out.aep"));
    const app2 = parse_aep(tmp_path.div("out.aep"));
    const comp2 = app2.project.compositions[0];

    expect(len(comp2.layers)).toBe(1);
    const lyr2 = comp2.layers[0];
    expect(lyr2.id).toBe(layer_id);
    expect(lyr2 instanceof TextLayer).toBe(true);
    py_assert(lyr2.text != null);
    const td = lyr2.text.property("ADBE Text Document").value;
    expect(td.text).toBe("Vertical");
    expect(td.lineOrientation).toBe(LineOrientation.VERTICAL_RIGHT_TO_LEFT);
  });
});

// ---------------------------------------------------------------------------
// add_vertical_box_text
// ---------------------------------------------------------------------------

describe("TestAddVerticalBoxText", () => {
  test("test_returns_text_layer", () => {
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const layer = comp.addVerticalBoxText([400, 200], "VBox");
    expect(layer instanceof TextLayer).toBe(true);
  });

  test("test_orientation_and_box_text", () => {
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const layer = comp.addVerticalBoxText([400, 200], "VBox");
    py_assert(layer.text != null);
    const td = layer.text.property("ADBE Text Document").value;
    expect(td.text).toBe("VBox");
    expect(td.lineOrientation).toBe(LineOrientation.VERTICAL_RIGHT_TO_LEFT);
    expect(td.boxText).toBe(true);
    expect(py_eq(td.boxTextSize, [400.0, 200.0])).toBe(true);
  });

  test("test_roundtrip", () => {
    const tmp_path = make_tmp_path();
    const app = parse_aep(EMPTY_COMP_AEP);
    const comp = app.project.compositions[0];
    const layer = comp.addVerticalBoxText([400, 200], "VBox Text");
    const layer_id = layer.id;

    app.project.save(tmp_path.div("out.aep"));
    const app2 = parse_aep(tmp_path.div("out.aep"));
    const comp2 = app2.project.compositions[0];

    expect(len(comp2.layers)).toBe(1);
    const lyr2 = comp2.layers[0];
    expect(lyr2.id).toBe(layer_id);
    expect(lyr2 instanceof TextLayer).toBe(true);
    py_assert(lyr2.text != null);
    const td = lyr2.text.property("ADBE Text Document").value;
    expect(td.text).toBe("VBox Text");
    expect(td.lineOrientation).toBe(LineOrientation.VERTICAL_RIGHT_TO_LEFT);
    expect(td.boxText).toBe(true);
  });
});
