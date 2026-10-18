/** Tests for AE preference file parsing and the Preferences model. */

import { describe, expect, test } from "bun:test";

import "../../src/py_aep/binary/_register.ts";
import type { Path } from "../../src/pyrt/index.ts";
import { BytesIO, KeyError, TypeError_, ValueError, getitem, py_assert, py_bool, py_eq, tkey } from "../../src/pyrt/index.ts";
import { approx, make_tmp_path, raises } from "../../src/pyrt/pytest.ts";
import * as py_aep from "../../src/py_aep/index.ts";
import { BitsPerChannel, PREFType } from "../../src/py_aep/enums/index.ts";
import { psd_comp_layer_styles, psd_footage_dimensions, psd_footage_layer_styles } from "../../src/py_aep/models/preferences.ts";
import { recursive_find } from "../../src/py_aep/binary/utils.ts";
import { IdtaChunk } from "../../src/py_aep/binary/item_chunks.ts";
import { AVItem } from "../../src/py_aep/models/items/av_item.ts";
import type { Layer } from "../../src/py_aep/models/layers/layer.ts";
import { as_instance } from "../helpers.ts";
import { _RESIZE_TO_STRINGS, build_resize_to_strings } from "../../src/py_aep/models/renderqueue/settings.ts";
import { PrefsFile, decode_pref_bool, decode_pref_number, decode_pref_string, find_prefs_file } from "../../src/py_aep/parsers/prefs.ts";

const MACHINE = PREFType.PREF_Type_MACHINE_SPECIFIC;
const INDEP = PREFType.PREF_Type_MACHINE_INDEPENDENT;
const INDEP_COMP = PREFType.PREF_Type_MACHINE_INDEPENDENT_COMPOSITION;

const _MACHINE_PREFS = `# Text File Version 1.1
# After Effects Preferences

["Numbers Section"]
\t"Quoted Float" = "30.000000"
\t"Quoted Int" = "999"
\t"Raw Byte" = 01
\t"Raw Word" = 00FF

["Output File Name Template Presets Section v6"]
\t"000" = "Comp Name"00"[compName].[fileExtension]"00
\t"001" = "Comp Folder and Name"00"[compName]/[compName].[fileExtension]"00

["Project Pref Section"]
\t"Project Settings Depth" = "1"
\t"Project Settings Time Display Format" = 01000101180000001000000001000000

["Renderer Preference Section"]
\t"New Composition Default" = "ADBE Calder"
`;

const _INDEP_PREFS = `# Text File Version 1.1
# After Effects Preferences

["Auto Save"]
\t"Auto Save Folder" = "C:\\Users\\test\\Documents"

["General Section"]
\t"Create New Layers At Time Zero" = 00

["Import Options Preference Section"]
\t"Import Options Default NTSC Dropframe" = 01
\t"Import Options Default Sequence FPS" = "25.000000"
\t"Off Flag" = 00
\t"Quoted False" = "0"
\t"Quoted True" = "1"

["Label Preference Indices Section 5"]
\t"Camera Label Index 2" = "10"
\t"Comp Label Index 2" = "9"
\t"Folder Label Index 2" = "12"
\t"Light Label Index 2" = "11"
\t"Null Label Index" = "6"
\t"Shape Label Index 2" = "13"
\t"Solid Label Index 2" = "4"
\t"Text Label Index" = "3"
\t"Video Label Index 2" = "7"

["Strings Section"]
\t"Bullet" = "HD  "E280A2"  1920x1080"
\t"Long Value" = "part one"\\
\t\t" and part two"

["Template Project"]
\t"New Project Solids Folder" = "Solides"
`;

const _INDEP_COMP_PREFS = `# Text File Version 1.1
# After Effects Preferences

["Composition Pref Section"]
\t"Composition Settings - Constrain Proportions" = 01
\t"New Composition - Start Timecode Scale" = "2997.000000"

["Composition Preset Names Section v11"]
\t"000" = "HD  "E280A2"  1920x1080 "E280A2" 24 fps"
\t"001" = "-"
\t"002" = "HD  "E280A2"  1920x1080 "E280A2" 29.97 fps"
\t"003" = "HDV  "E280A2"  1440x1080 (1.33) "E280A2" 25 fps"

["Composition Presets Section v11"]
\t"000" = 078004"8"001800000000000100000001
\t"001" = 00000000000000000000000000000000
\t"002" = 078004"8"001DF8"R"0000000100000001
\t"003" = 05A004"8"001900000000000400000003
`;

/** Fixture `prefs_dir`: writes the three preference files into `tmp_path`. */
function prefs_dir_fixture(tmp_path: Path): Path {
  tmp_path.div("Adobe After Effects 26.0 Prefs.txt").write_text(_MACHINE_PREFS);
  tmp_path.div("Adobe After Effects 26.0 Prefs-indep-general.txt").write_text(_INDEP_PREFS);
  tmp_path.div("Adobe After Effects 26.0 Prefs-indep-composition.txt").write_text(_INDEP_COMP_PREFS);
  return tmp_path;
}

describe("TestPrefsFileParsing", () => {
  test("test_sections_and_keys", () => {
    const prefs = PrefsFile.from_text(_MACHINE_PREFS);
    expect(prefs.get_raw("Renderer Preference Section", "New Composition Default")).toBe('"ADBE Calder"');
    expect(prefs.get_raw("Numbers Section", "Raw Byte")).toBe("01");
  });

  test("test_missing_returns_none", () => {
    const prefs = PrefsFile.from_text(_MACHINE_PREFS);
    expect(prefs.get_raw("Numbers Section", "Nope") == null).toBe(true);
    expect(prefs.get_raw("Nope Section", "Quoted Int") == null).toBe(true);
  });

  test("test_continuation_lines", () => {
    const prefs = PrefsFile.from_text(_INDEP_PREFS);
    const raw = prefs.get_raw("Strings Section", "Long Value");
    expect(raw != null).toBe(true);
    if (raw == null) throw new Error("no raw 'Long Value' pref");
    expect(decode_pref_string(raw)).toBe("part one and part two");
  });

  test("test_find_prefs_file", () => {
    const tmp_path = make_tmp_path();
    const prefs_dir = prefs_dir_fixture(tmp_path);
    const machine = find_prefs_file(prefs_dir, MACHINE);
    expect(machine != null && machine.name.endsWith(" Prefs.txt")).toBe(true);
    const indep = find_prefs_file(prefs_dir, INDEP);
    expect(indep != null && indep.name.endsWith("-indep-general.txt")).toBe(true);
    expect(find_prefs_file(prefs_dir, PREFType.PREF_Type_MACHINE_SPECIFIC_TEXT) == null).toBe(true);
  });
});

describe("TestValueDecoding", () => {
  test("test_number_forms", () => {
    expect(decode_pref_number('"999"')).toBe(999);
    // NOTE(port): int/float — integral values are plain numbers by design (RULEBOOK §4); this isinstance(int) check cannot distinguish 999 from 999.0.
    expect(typeof decode_pref_number('"999"') === "number" && Number.isInteger(decode_pref_number('"999"'))).toBe(true);
    expect(approx(decode_pref_number('"30.000000"'), 30.0)).toBe(true);
    expect(decode_pref_number("01")).toBe(1);
    expect(decode_pref_number("00FF")).toBe(255);
  });

  test("test_bool_forms", () => {
    expect(decode_pref_bool("01")).toBe(true);
    expect(decode_pref_bool("00")).toBe(false);
    expect(decode_pref_bool('"1"')).toBe(true);
    expect(decode_pref_bool('"0"')).toBe(false);
  });

  test("test_string_hex_escapes", () => {
    // AE writes non-ASCII characters as hex escapes outside quotes.
    expect(decode_pref_string('"HD  "E280A2"  1920x1080"')).toBe("HD  •  1920x1080");
  });

  test("test_string_backslashes_preserved", () => {
    expect(decode_pref_string('"C:\\Users\\test\\Documents"')).toBe("C:\\Users\\test\\Documents");
  });
});

describe("TestPreferences", () => {
  test("test_get_number", () => {
    const prefs_dir = prefs_dir_fixture(make_tmp_path());
    const prefs = new py_aep.Preferences(prefs_dir);
    expect(prefs.get_pref_as_number("Numbers Section", "Quoted Int")).toBe(999);
    expect(
      approx(
        prefs.get_pref_as_number("Import Options Preference Section", "Import Options Default Sequence FPS", INDEP),
        25.0,
      ),
    ).toBe(true);
  });

  test("test_get_bool", () => {
    const prefs_dir = prefs_dir_fixture(make_tmp_path());
    const prefs = new py_aep.Preferences(prefs_dir);
    const section = "Import Options Preference Section";
    expect(prefs.get_pref_as_bool(section, "Quoted True", INDEP)).toBe(true);
    expect(prefs.get_pref_as_bool(section, "Quoted False", INDEP)).toBe(false);
    expect(prefs.get_pref_as_bool(section, "Import Options Default NTSC Dropframe", INDEP)).toBe(true);
    expect(prefs.get_pref_as_bool(section, "Off Flag", INDEP)).toBe(false);
  });

  test("test_get_string", () => {
    const prefs_dir = prefs_dir_fixture(make_tmp_path());
    const prefs = new py_aep.Preferences(prefs_dir);
    expect(prefs.get_pref_as_string("Renderer Preference Section", "New Composition Default")).toBe("ADBE Calder");
    expect(prefs.get_pref_as_string("Auto Save", "Auto Save Folder", INDEP)).toBe("C:\\Users\\test\\Documents");
  });

  test("test_pref_type_routing", () => {
    const prefs_dir = prefs_dir_fixture(make_tmp_path());
    const prefs = new py_aep.Preferences(prefs_dir);
    // The key exists in the composition file only.
    expect(
      py_bool(
        prefs.get_pref_as_bool(
          "Composition Pref Section",
          "Composition Settings - Constrain Proportions",
          INDEP_COMP,
        ),
      ),
    ).toBe(true);
    raises(KeyError, () =>
      prefs.get_pref_as_bool(
        "Composition Pref Section",
        "Composition Settings - Constrain Proportions",
        MACHINE,
      ),
    );
  });

  test("test_missing_key_raises_or_defaults", () => {
    const prefs_dir = prefs_dir_fixture(make_tmp_path());
    const prefs = new py_aep.Preferences(prefs_dir);
    raises(KeyError, () => prefs.get_pref_as_number("Numbers Section", "Nope"));
    expect(prefs.get_pref_as_number("Numbers Section", "Nope", undefined, { default: 7 })).toBe(7);
    expect(prefs.get_pref_as_string("Numbers Section", "Nope", undefined, { default: "x" })).toBe("x");
    expect(prefs.get_pref_as_bool("Numbers Section", "Nope", undefined, { default: true })).toBe(true);
  });

  test("test_have_pref", () => {
    const prefs_dir = prefs_dir_fixture(make_tmp_path());
    const prefs = new py_aep.Preferences(prefs_dir);
    expect(prefs.have_pref("Numbers Section", "Quoted Int")).toBe(true);
    expect(prefs.have_pref("Numbers Section", "Nope")).toBe(false);
  });

  test("test_no_prefs_dir", () => {
    const prefs = new py_aep.Preferences();
    raises(KeyError, () => prefs.get_pref_as_number("Numbers Section", "Quoted Int"));
    expect(prefs.get_pref_as_number("A", "B", undefined, { default: 5 })).toBe(5);
    expect(prefs.have_pref("A", "B")).toBe(false);
    // Overrides work without any preference files.
    prefs.set_pref_as_number("A", "B", 12);
    expect(prefs.get_pref_as_number("A", "B")).toBe(12);
  });

  test("test_overrides_take_precedence", () => {
    const prefs_dir = prefs_dir_fixture(make_tmp_path());
    const prefs = new py_aep.Preferences(prefs_dir);
    prefs.set_pref_as_number("Numbers Section", "Quoted Int", 5);
    expect(prefs.get_pref_as_number("Numbers Section", "Quoted Int")).toBe(5);
    prefs.set_pref_as_string("Renderer Preference Section", "New Composition Default", "ADBE Escher");
    expect(prefs.get_pref_as_string("Renderer Preference Section", "New Composition Default")).toBe("ADBE Escher");
    prefs.set_pref_as_bool("Numbers Section", "Raw Byte", false);
    expect(prefs.get_pref_as_bool("Numbers Section", "Raw Byte")).toBe(false);
  });

  test("test_override_cross_type_reads", () => {
    const prefs_dir = prefs_dir_fixture(make_tmp_path());
    const prefs = new py_aep.Preferences(prefs_dir);
    prefs.set_pref_as_number("Numbers Section", "Quoted Int", 5);
    expect(prefs.get_pref_as_string("Numbers Section", "Quoted Int")).toBe("5");
    expect(prefs.get_pref_as_bool("Numbers Section", "Quoted Int")).toBe(true);
  });

  test("test_overrides_never_touch_disk", () => {
    const prefs_dir = prefs_dir_fixture(make_tmp_path());
    const target = prefs_dir.div("Adobe After Effects 26.0 Prefs.txt");
    const before = target.read_bytes();
    const prefs = new py_aep.Preferences(prefs_dir);
    prefs.set_pref_as_number("Numbers Section", "Quoted Int", 5);
    prefs.delete_pref("Numbers Section", "Raw Byte");
    expect(py_eq(target.read_bytes(), before)).toBe(true);
  });

  test("test_delete_pref_masks_file_value", () => {
    const prefs_dir = prefs_dir_fixture(make_tmp_path());
    const prefs = new py_aep.Preferences(prefs_dir);
    prefs.delete_pref("Numbers Section", "Quoted Int");
    expect(prefs.have_pref("Numbers Section", "Quoted Int")).toBe(false);
    raises(KeyError, () => prefs.get_pref_as_number("Numbers Section", "Quoted Int"));
    expect(prefs.get_pref_as_number("Numbers Section", "Quoted Int", undefined, { default: 1 })).toBe(1);
  });

  test("test_reload_discards_overrides", () => {
    const prefs_dir = prefs_dir_fixture(make_tmp_path());
    const prefs = new py_aep.Preferences(prefs_dir);
    prefs.set_pref_as_number("Numbers Section", "Quoted Int", 5);
    prefs.delete_pref("Numbers Section", "Raw Byte");
    prefs.reload();
    expect(prefs.get_pref_as_number("Numbers Section", "Quoted Int")).toBe(999);
    expect(prefs.get_pref_as_number("Numbers Section", "Raw Byte")).toBe(1);
  });

  test("test_validation", () => {
    const prefs_dir = prefs_dir_fixture(make_tmp_path());
    const prefs = new py_aep.Preferences(prefs_dir);
    raises(ValueError, () => prefs.get_pref_as_number("", "Quoted Int"));
    // @ts-expect-error deliberately passes a number that is not a PREFType to check runtime validation
    raises(ValueError, () => prefs.get_pref_as_number("Numbers Section", "Quoted Int", 1234));
    // @ts-expect-error deliberately passes a non-bool to check runtime validation
    raises(TypeError_, () => prefs.set_pref_as_bool("A", "B", 1));
    // @ts-expect-error deliberately passes a non-string to check runtime validation
    raises(TypeError_, () => prefs.set_pref_as_string("A", "B", 5));
    // @ts-expect-error deliberately passes a non-number to check runtime validation
    raises(TypeError_, () => prefs.set_pref_as_number("A", "B", "5"));
  });
});

describe("TestApplicationPreferences", () => {
  test("test_app_preferences_object", () => {
    const prefs_dir = prefs_dir_fixture(make_tmp_path());
    const app = py_aep.new(undefined, { ae_preferences_dir: prefs_dir });
    expect(app.preferences instanceof py_aep.Preferences).toBe(true);
    expect(app.preferences).toBe(app.project._preferences);
  });
});

/** Creation defaults resolve from prefs, with AE factory fallbacks. */
describe("TestCreationWiring", () => {
  test("test_labels_from_prefs", () => {
    const prefs_dir = prefs_dir_fixture(make_tmp_path());
    const app = py_aep.new(undefined, { ae_preferences_dir: prefs_dir });
    const comp = app.project.root_folder.add_comp("C", 100, 100, 1.0, 1.0, 25.0);
    expect(as_instance(comp._idta, IdtaChunk).label).toBe(9);
    expect(as_instance(app.project.root_folder.add_folder("F")._idta, IdtaChunk).label).toBe(12);
    const solid = comp.add_solid([1.0, 0.0, 0.0]);
    expect(solid._ldta.label).toBe(4);
    expect(as_instance(as_instance(solid.source, AVItem)._idta, IdtaChunk).label).toBe(4);
    expect(comp.add_null()._ldta.label).toBe(6);
    expect(comp.add_text("hi")._ldta.label).toBe(3);
    expect(comp.add_shape()._ldta.label).toBe(13);
    expect(comp.add_camera("cam", [50.0, 50.0])._ldta.label).toBe(10);
    expect(comp.add_light("light", [50.0, 50.0])._ldta.label).toBe(11);
  });

  test("test_labels_factory_defaults", () => {
    // Probed in AE 2026 with factory label preferences.
    const app = py_aep.new();
    const comp = app.project.root_folder.add_comp("C", 100, 100, 1.0, 1.0, 25.0);
    expect(as_instance(comp._idta, IdtaChunk).label).toBe(15);
    expect(as_instance(app.project.root_folder.add_folder("F")._idta, IdtaChunk).label).toBe(2);
    const solid = comp.add_solid([1.0, 0.0, 0.0]);
    expect(solid._ldta.label).toBe(1);
    expect(as_instance(as_instance(solid.source, AVItem)._idta, IdtaChunk).label).toBe(1);
    expect(comp.add_null()._ldta.label).toBe(1);
    expect(comp.add_text("hi")._ldta.label).toBe(1);
    expect(comp.add_shape()._ldta.label).toBe(8);
    expect(comp.add_camera("cam", [50.0, 50.0])._ldta.label).toBe(4);
    expect(comp.add_light("light", [50.0, 50.0])._ldta.label).toBe(6);
  });

  test("test_label_override", () => {
    const prefs_dir = prefs_dir_fixture(make_tmp_path());
    const app = py_aep.new(undefined, { ae_preferences_dir: prefs_dir });
    app.preferences.set_pref_as_number("Label Preference Indices Section 5", "Comp Label Index 2", 16, INDEP);
    const comp = app.project.root_folder.add_comp("C", 100, 100, 1.0, 1.0, 25.0);
    expect(as_instance(comp._idta, IdtaChunk).label).toBe(16);
  });

  test("test_solids_folder_name_from_prefs", () => {
    const prefs_dir = prefs_dir_fixture(make_tmp_path());
    const app = py_aep.new(undefined, { ae_preferences_dir: prefs_dir });
    expect(app.project._solids_folder_name).toBe("Solides");
    const comp = app.project.root_folder.add_comp("C", 100, 100, 1.0, 1.0, 25.0);
    comp.add_solid([1.0, 0.0, 0.0]);
    expect(py_eq(app.project.root_folder.folders.map((f) => f.name), ["Solides"])).toBe(true);
  });

  test("test_solids_folder_name_stamped_in_saved_file", () => {
    // The pref is stamped into the sfnm chunk at new(); a fresh parse
    // (without any prefs dir) reads the stored name back.
    const tmp_path = make_tmp_path();
    const prefs_dir = prefs_dir_fixture(tmp_path);
    const app = py_aep.new(undefined, { ae_preferences_dir: prefs_dir });
    const out = tmp_path.div("out.aep");
    app.project.save(out);
    const reparsed = py_aep.parse(out);
    expect(reparsed.project._solids_folder_name).toBe("Solides");
  });

  test("test_solids_folder_name_factory_default", () => {
    const app = py_aep.new();
    expect(app.project._solids_folder_name).toBe("Solids");
  });
});

/**
 * PSD import-dialog sticky choices - popup indices probed in AE 2026, not
 * the sspc c9 byte enum (footage merge/ignore is reversed there).
 */
describe("TestImportChoicePrefs", () => {
  const SECTION = "Choose Layer Dialog";

  test("test_unset_returns_none", () => {
    const prefs = new py_aep.Preferences();
    expect(psd_comp_layer_styles(prefs) == null).toBe(true);
    expect(psd_footage_layer_styles(prefs) == null).toBe(true);
    expect(psd_footage_dimensions(prefs) == null).toBe(true);
  });

  test("test_comp_layer_styles_mapping", () => {
    const prefs = new py_aep.Preferences();
    prefs.set_pref_as_number(SECTION, "PSD Comp Layer Styles Option v2", 0);
    expect(psd_comp_layer_styles(prefs)).toBe("editable");
    prefs.set_pref_as_number(SECTION, "PSD Comp Layer Styles Option v2", 1);
    expect(psd_comp_layer_styles(prefs)).toBe("merge");
  });

  test("test_footage_layer_styles_mapping", () => {
    const prefs = new py_aep.Preferences();
    prefs.set_pref_as_number(SECTION, "PSD Footage Layer Styles Option", 0);
    expect(psd_footage_layer_styles(prefs)).toBe("merge");
    prefs.set_pref_as_number(SECTION, "PSD Footage Layer Styles Option", 1);
    expect(psd_footage_layer_styles(prefs)).toBe("ignore");
  });

  test("test_footage_dimensions_mapping", () => {
    const prefs = new py_aep.Preferences();
    prefs.set_pref_as_number(SECTION, "PSD Dimensions Popup", 0);
    expect(psd_footage_dimensions(prefs)).toBe("layer");
    prefs.set_pref_as_number(SECTION, "PSD Dimensions Popup", 1);
    expect(psd_footage_dimensions(prefs)).toBe("document");
  });

  test("test_unknown_index_returns_none", () => {
    const prefs = new py_aep.Preferences();
    prefs.set_pref_as_number(SECTION, "PSD Dimensions Popup", 7);
    expect(psd_footage_dimensions(prefs) == null).toBe(true);
  });
});

/** Composition presets parsed from the AE preferences, and the New Composition helpers. */
describe("TestCompositionPresets", () => {
  test("test_parse_presets", () => {
    const prefs_dir = prefs_dir_fixture(make_tmp_path());
    const presets = new py_aep.Preferences(prefs_dir).composition_presets();
    // The "-" separator entry is skipped.
    expect(presets.length).toBe(3);
    const [hd24, hd2997, hdv] = presets;
    expect(hd24.name.includes("1920x1080") && hd24.name.includes("24 fps")).toBe(true);
    expect(py_eq([hd24.width, hd24.height], [1920, 1080])).toBe(true);
    expect(approx(hd24.frame_rate, 24.0)).toBe(true);
    expect(approx(hd24.pixel_aspect, 1.0)).toBe(true);
    expect(approx(hd2997.frame_rate, 29.97, { abs: 1e-3 })).toBe(true);
    expect(py_eq([hdv.width, hdv.height], [1440, 1080])).toBe(true);
    expect(approx(hdv.frame_rate, 25.0)).toBe(true);
    expect(approx(hdv.pixel_aspect, 4 / 3)).toBe(true);
  });

  test("test_no_prefs_dir", () => {
    expect(py_eq(new py_aep.Preferences().composition_presets(), [])).toBe(true);
  });

  test("test_add_comp_from_preset", () => {
    const prefs_dir = prefs_dir_fixture(make_tmp_path());
    const app = py_aep.new(undefined, { ae_preferences_dir: prefs_dir });
    const comp = app.project.root_folder.add_comp_from_preset("C", "1440x1080", 5.0);
    expect(py_eq([comp.width, comp.height], [1440, 1080])).toBe(true);
    expect(approx(comp.pixel_aspect, 4 / 3)).toBe(true);
    expect(approx(comp.frame_rate, 25.0)).toBe(true);
    expect(approx(comp.duration, 5.0)).toBe(true);
    expect(comp.name).toBe("C");
  });

  test("test_add_comp_from_preset_ntsc_rate", () => {
    const prefs_dir = prefs_dir_fixture(make_tmp_path());
    const app = py_aep.new(undefined, { ae_preferences_dir: prefs_dir });
    const comp = app.project.root_folder.add_comp_from_preset("C", "29.97", 5.0);
    expect(approx(comp.frame_rate, 29.97, { abs: 1e-3 })).toBe(true);
  });

  test("test_add_comp_from_preset_ambiguous", () => {
    const prefs_dir = prefs_dir_fixture(make_tmp_path());
    const app = py_aep.new(undefined, { ae_preferences_dir: prefs_dir });
    raises(ValueError, () => app.project.root_folder.add_comp_from_preset("C", "1920x1080", 5.0), "matched 2");
  });

  test("test_add_comp_from_preset_unknown", () => {
    const prefs_dir = prefs_dir_fixture(make_tmp_path());
    const app = py_aep.new(undefined, { ae_preferences_dir: prefs_dir });
    raises(ValueError, () => app.project.root_folder.add_comp_from_preset("C", "8K", 5.0), "matched 0");
  });

  test("test_add_comp_from_preset_without_prefs", () => {
    const app = py_aep.new();
    raises(ValueError, () => app.project.root_folder.add_comp_from_preset("C", "HD", 5.0), "no composition presets");
  });
});

// Two presets tie at 1440x1080 @ 25 fps ("First" then "Second"), plus a
// 60 fps entry; the resize label must pick the lowest fps, later on tie.
const _TIE_COMP_PREFS = `# Text File Version 1.1
# After Effects Preferences

["Composition Preset Names Section v11"]
\t"000" = "First  "E280A2"  1440x1080 "E280A2" 25 fps"
\t"001" = "Second  "E280A2"  1440x1080 "E280A2" 25 fps"
\t"002" = "Fast  "E280A2"  1440x1080 "E280A2" 60 fps"

["Composition Presets Section v11"]
\t"000" = 05A004"8"001900000000000400000003
\t"001" = 05A004"8"001900000000000400000003
\t"002" = 05A004"8"003C00000000000400000003
`;

/**
 * The "Resize to" label map derives from comp presets (lowest fps
 * per resolution, later preset on tie), probed in AE 2026; the hardcoded
 * table is the factory fallback when no preferences dir is provided.
 */
describe("TestResizeToStrings", () => {
  test("test_derives_lowest_fps_per_resolution", () => {
    const prefs_dir = prefs_dir_fixture(make_tmp_path());
    // Fixture presets: HD 1920x1080 @ 24 and @ 29.97 - lowest wins.
    const resize = build_resize_to_strings(new py_aep.Preferences(prefs_dir));
    expect(getitem(resize, tkey(1920, 1080))).toBe("HD  •  1920x1080 • 24 fps");
    expect(getitem(resize, tkey(1440, 1080))).toBe("HDV  •  1440x1080 (1.33) • 25 fps");
  });

  test("test_tie_break_prefers_later_preset", () => {
    const tmp_path = make_tmp_path();
    const prefs = tmp_path.div("prefs");
    prefs.mkdir();
    prefs.div("Adobe After Effects 26.0 Prefs-indep-composition.txt").write_text(_TIE_COMP_PREFS);
    const resize = build_resize_to_strings(new py_aep.Preferences(prefs));
    expect(getitem(resize, tkey(1440, 1080))).toBe("Second  •  1440x1080 • 25 fps");
  });

  test("test_fallback_without_prefs", () => {
    expect(build_resize_to_strings(new py_aep.Preferences()) === _RESIZE_TO_STRINGS).toBe(true);
  });

  test("test_fallback_holds_ae_verified_collision_labels", () => {
    // AE 2026 getSetting("Resize to") ground truth for factory presets.
    expect(getitem(_RESIZE_TO_STRINGS, tkey(1920, 1080))).toBe("HD  •  1920x1080 • 24 fps");
    expect(getitem(_RESIZE_TO_STRINGS, tkey(3840, 2160))).toBe("UHD (4K)  •  3840x2160 • 23.976 fps");
  });
});

describe("TestOutputNameTemplatePresets", () => {
  test("test_parse", () => {
    const prefs_dir = prefs_dir_fixture(make_tmp_path());
    const presets = new py_aep.Preferences(prefs_dir).output_name_template_presets();
    expect(
      py_eq(
        presets,
        new Map([
          ["Comp Name", "[compName].[fileExtension]"],
          ["Comp Folder and Name", "[compName]/[compName].[fileExtension]"],
        ]),
      ),
    ).toBe(true);
  });

  test("test_no_prefs_dir", () => {
    expect(py_eq(new py_aep.Preferences().output_name_template_presets(), new Map())).toBe(true);
  });
});

/** py_aep.new() inherits the last-used Project Settings preferences. */
describe("TestNewProjectSettings", () => {
  test("test_depth_and_time_display_from_prefs", () => {
    const prefs_dir = prefs_dir_fixture(make_tmp_path());
    const project = py_aep.new(undefined, { ae_preferences_dir: prefs_dir }).project;
    expect(project.bits_per_channel).toBe(BitsPerChannel.SIXTEEN);
    for (const chunk of [project._nnhd, project._nhed]) {
      expect(chunk.time_display_type).toBe(1);
      expect(chunk.footage_timecode_display_start_type).toBe(0);
      expect(py_bool(chunk.frames_use_feet_frames)).toBe(true);
      expect(chunk.timecode_default_base).toBe(24);
      expect(chunk.frames_count_type).toBe(1);
    }
  });

  test("test_factory_defaults_without_prefs", () => {
    const project = py_aep.new().project;
    expect(project.bits_per_channel).toBe(BitsPerChannel.EIGHT);
    for (const chunk of [project._nnhd, project._nhed]) {
      expect(chunk.time_display_type).toBe(0);
      expect(chunk.timecode_default_base).toBe(30);
      expect(chunk.frames_count_type).toBe(2);
    }
  });
});

/** The "Create New Layers At Time Zero" preference (off in the fixture). */
describe("TestCreateLayersAtCurrentTime", () => {
  test("test_layers_anchor_at_comp_time", () => {
    // AE 2026 probed: start = in = comp.time, out shifted by the same
    // amount, for every scripted layer-creation method.
    const prefs_dir = prefs_dir_fixture(make_tmp_path());
    const app = py_aep.new(undefined, { ae_preferences_dir: prefs_dir });
    const comp = app.project.root_folder.add_comp("C", 100, 100, 1.0, 5.0, 25.0);
    comp.time = 2.0;
    const solid = comp.add_solid([1.0, 0.0, 0.0]);
    expect(approx(solid.start_time, 2.0)).toBe(true);
    expect(approx(solid.in_point, 2.0)).toBe(true);
    expect(approx(solid.out_point, 7.0)).toBe(true);
    const text = comp.add_text("hi");
    expect(approx(text.start_time, 2.0)).toBe(true);
  });

  test("test_no_shift_at_time_zero", () => {
    const prefs_dir = prefs_dir_fixture(make_tmp_path());
    const app = py_aep.new(undefined, { ae_preferences_dir: prefs_dir });
    const comp = app.project.root_folder.add_comp("C", 100, 100, 1.0, 5.0, 25.0);
    const solid = comp.add_solid([1.0, 0.0, 0.0]);
    expect(approx(solid.start_time, 0.0)).toBe(true);
  });

  test("test_pref_on_keeps_layers_at_zero", () => {
    // Factory default (no prefs dir): layers start at time zero.
    const app = py_aep.new();
    const comp = app.project.root_folder.add_comp("C", 100, 100, 1.0, 5.0, 25.0);
    comp.time = 2.0;
    const solid = comp.add_solid([1.0, 0.0, 0.0]);
    expect(approx(solid.start_time, 0.0)).toBe(true);
  });

  test("test_duplicate_keeps_source_timing", () => {
    // AE 2026 probed: duplicate() keeps the source layer's timing and
    // does not re-anchor at the current time.
    const prefs_dir = prefs_dir_fixture(make_tmp_path());
    const app = py_aep.new(undefined, { ae_preferences_dir: prefs_dir });
    const comp = app.project.root_folder.add_comp("C", 100, 100, 1.0, 5.0, 25.0);
    comp.time = 2.0;
    const solid = comp.add_solid([1.0, 0.0, 0.0]);
    comp.time = 4.0;
    const dup = solid.duplicate();
    expect(approx(dup.start_time, 2.0)).toBe(true);
  });
});

/**
 * The still/synthetic default out-point preferences (probed in AE
 * 2026: value/scale seconds; solids, nulls, text, shape, camera and
 * light follow the synthetic preference).
 */
describe("TestDefaultOutPoints", () => {
  /** Fixture `outpoint_prefs_dir`. */
  function outpoint_prefs_dir(tmp_path: Path): Path {
    tmp_path
      .div("Adobe After Effects 26.0 Prefs-indep-general.txt")
      .write_text(
        '["Main Pref Section v2"]\n' +
          '\t"Pref_DEFAULT_STILL_OUT_POINT v2" = "75/25"\n' +
          '\t"Pref_DEFAULT_SYNTHETIC_OUT_POINT v2" = "50/25"\n',
      );
    return tmp_path;
  }

  test("test_synthetic_layers_follow_pref", () => {
    const outpoint_prefs = outpoint_prefs_dir(make_tmp_path());
    const app = py_aep.new(undefined, { ae_preferences_dir: outpoint_prefs });
    const comp = app.project.root_folder.add_comp("C", 100, 100, 1.0, 5.0, 25.0);
    expect(approx(comp.add_solid([1.0, 0.0, 0.0]).out_point, 2.0)).toBe(true);
    expect(approx(comp.add_null().out_point, 2.0)).toBe(true);
    expect(approx(comp.add_text("x").out_point, 2.0)).toBe(true);
    expect(approx(comp.add_shape().out_point, 2.0)).toBe(true);
    expect(approx(comp.add_camera("c", [50.0, 50.0]).out_point, 2.0)).toBe(true);
    expect(approx(comp.add_light("l", [50.0, 50.0]).out_point, 2.0)).toBe(true);
  });

  test("test_solid_duration_arg_honored", () => {
    // py_aep honors an explicit duration argument, overriding the
    // synthetic out-point preference (AE's addSolid ignores it).
    const outpoint_prefs = outpoint_prefs_dir(make_tmp_path());
    const app = py_aep.new(undefined, { ae_preferences_dir: outpoint_prefs });
    const comp = app.project.root_folder.add_comp("C", 100, 100, 1.0, 5.0, 25.0);
    const solid = comp.add_solid([1.0, 0.0, 0.0], undefined, undefined, undefined, undefined, 8.0);
    expect(approx(solid.out_point, 8.0)).toBe(true);
  });

  test("test_factory_defaults_span_comp_duration", () => {
    const app = py_aep.new();
    const comp = app.project.root_folder.add_comp("C", 100, 100, 1.0, 5.0, 25.0);
    // No preferences and no explicit duration: the default span is the
    // composition duration.
    expect(approx(comp.add_solid([1.0, 0.0, 0.0]).out_point, 5.0)).toBe(true);
    expect(approx(comp.add_text("x").out_point, 5.0)).toBe(true);
  });
});

const _CUSTOM_TEXT_STYLE = `# Text File Version 1.1
# After Effects Preferences

["Text Style Sheet"]
\t"Baseline Shift" = "5.000000"
\t"Fill Blue" = "0.750000"
\t"Fill Green" = "0.500000"
\t"Fill Red" = "0.250000"
\t"Font Family Name" = "Arial"
\t"Font PostScript Name" = "ArialMT"
\t"Font Style Name" = "Regular"
\t"Render Fill" = 01
\t"Render Stroke" = 01
\t"Size" = "48.000000"
\t"Stroke Blue" = "0.000000"
\t"Stroke Green" = "0.200000"
\t"Stroke Red" = "0.100000"
\t"Stroke Width" = "5.000000"
\t"Tracking" = "50"
`;

// A factory AE 2026 style sheet (matches the baked COS template).
const _FACTORY_TEXT_STYLE = `# Text File Version 1.1
# After Effects Preferences

["Text Style Sheet"]
\t"Baseline Shift" = "0.000000"
\t"Fill Blue" = "0.921569"
\t"Fill Green" = "0.921569"
\t"Fill Red" = "0.921569"
\t"Font Family Name" = "Myriad Pro"
\t"Font PostScript Name" = "MyriadPro-Regular"
\t"Font Style Name" = "Regular"
\t"Render Fill" = 01
\t"Render Stroke" = 00
\t"Size" = "36.000000"
\t"Stroke Blue" = "0.000000"
\t"Stroke Green" = "0.000000"
\t"Stroke Red" = "0.000000"
\t"Stroke Width" = "1.000000"
\t"Tracking" = "0"
`;

function _text_style_dir(tmp_path: Path, sheet: string): Path {
  const prefs = tmp_path.div("prefs");
  prefs.mkdir({ exist_ok: true });
  prefs.div("Adobe After Effects 26.0 Prefs-text.txt").write_text(sheet);
  return prefs;
}

function _btdk_bytes(layer: Layer): Uint8Array {
  const matches = recursive_find(layer._layer_list.chunks, undefined, "btdk");
  py_assert(matches.length === 1);
  const buf = new BytesIO();
  matches[0].write(buf);
  return buf.getvalue();
}

/**
 * Scripted addText honors the character-level Text Style Sheet
 * (probed in AE 2026; read at AE startup, paragraph sheet not applied).
 */
describe("TestTextStyleSheet", () => {
  test("test_add_text_honors_style_sheet", () => {
    const tmp_path = make_tmp_path();
    const prefs = _text_style_dir(tmp_path, _CUSTOM_TEXT_STYLE);
    const app = py_aep.new(undefined, { ae_preferences_dir: prefs });
    const comp = app.project.root_folder.add_comp("C", 100, 100, 1.0, 5.0, 25.0);
    const text = comp.add_text("probe").text;
    if (text == null) throw new Error("text layer has no text group");
    const td = text.property("ADBE Text Document").value;
    expect(td.font).toBe("ArialMT");
    expect(approx(td.font_size, 48.0)).toBe(true);
    expect(approx(td.fill_color, [0.25, 0.5, 0.75])).toBe(true);
    expect(approx(td.tracking, 50.0)).toBe(true);
    expect(approx(td.baseline_shift, 5.0)).toBe(true);
    expect(td.apply_stroke).toBe(true);
    expect(approx(td.stroke_width, 5.0)).toBe(true);
    expect(approx(td.stroke_color, [0.1, 0.2, 0.0])).toBe(true);
  });

  test("test_no_prefs_is_byte_identical_to_template", () => {
    // Without a prefs dir, add_text must not change a single byte of
    // the baked COS template (btdk is byte-format-sensitive).
    const app = py_aep.new();
    const comp = app.project.root_folder.add_comp("C", 100, 100, 1.0, 5.0, 25.0);
    const layer_bytes = _btdk_bytes(comp.add_text("probe"));
    const buf = new BytesIO();
    new py_aep.TextDocument("probe")._btdk_body.write(buf);
    expect(py_eq(layer_bytes, buf.getvalue())).toBe(true);
  });

  test("test_identity_fields_are_not_rewritten", () => {
    // Sheet values matching the template (size/tracking/baseline/
    // stroke flags) must not be rewritten. Font/Fill are excluded here
    // only to keep the assertion clear of the fill's sub-1e-6
    // serialization boundary; they are exercised elsewhere.
    const sheet = _FACTORY_TEXT_STYLE.replace(/\n$/, "")
      .split("\n")
      .filter((line) => !line.includes("Font") && !line.includes("Fill"))
      .join("\n");
    const tmp_path = make_tmp_path();
    const prefs = _text_style_dir(tmp_path, sheet);
    const app_prefs = py_aep.new(undefined, { ae_preferences_dir: prefs });
    const comp_prefs = app_prefs.project.root_folder.add_comp("C", 100, 100, 1.0, 5.0, 25.0);
    const app_plain = py_aep.new();
    const comp_plain = app_plain.project.root_folder.add_comp("C", 100, 100, 1.0, 5.0, 25.0);
    expect(py_eq(_btdk_bytes(comp_prefs.add_text("probe")), _btdk_bytes(comp_plain.add_text("probe")))).toBe(true);
  });

  test("test_factory_sheet_matches_ae_addtext", () => {
    // The template now matches AE 2026's own factory addText output
    // (MyriadPro-Regular, size 36, fill 0.921569, no stroke), so
    // applying the factory sheet is a no-op that stays on AE's values.
    const tmp_path = make_tmp_path();
    const prefs = _text_style_dir(tmp_path, _FACTORY_TEXT_STYLE);
    const app = py_aep.new(undefined, { ae_preferences_dir: prefs });
    const comp = app.project.root_folder.add_comp("C", 100, 100, 1.0, 5.0, 25.0);
    const text = comp.add_text("probe").text;
    if (text == null) throw new Error("text layer has no text group");
    const td = text.property("ADBE Text Document").value;
    expect(td.font).toBe("MyriadPro-Regular");
    expect(approx(td.font_size, 36.0)).toBe(true);
    expect(approx(td.fill_color, [0.921569, 0.921569, 0.921569], { abs: 1e-5 })).toBe(true);
    expect(!py_bool(td.apply_stroke)).toBe(true);
  });

  test("test_box_text_honors_style_sheet", () => {
    const tmp_path = make_tmp_path();
    const prefs = _text_style_dir(tmp_path, _CUSTOM_TEXT_STYLE);
    const app = py_aep.new(undefined, { ae_preferences_dir: prefs });
    const comp = app.project.root_folder.add_comp("C", 100, 100, 1.0, 5.0, 25.0);
    const text = comp.add_box_text([80.0, 40.0], "boxed").text;
    if (text == null) throw new Error("text layer has no text group");
    const td = text.property("ADBE Text Document").value;
    expect(td.font).toBe("ArialMT");
    expect(approx(td.font_size, 48.0)).toBe(true);
  });
});
