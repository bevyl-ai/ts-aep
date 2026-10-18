/** Tests for AE preference file parsing and the Preferences model. */

import { describe, expect, test } from "bun:test";

import "../../src/py_aep/binary/_register.ts";
import type { Path } from "../../src/pyrt/index.ts";
import { BytesIO, KeyError, ValueError, getOrThrow, assert, truthy, valueEquals, compositeKey } from "../../src/pyrt/index.ts";
import { approx, makeTmpPath, raises } from "../../src/pyrt/pytest.ts";
import * as py_aep from "../../src/py_aep/index.ts";
import { BitsPerChannel, PREFType } from "../../src/py_aep/enums/index.ts";
import { psdCompLayerStyles, psdFootageDimensions, psdFootageLayerStyles } from "../../src/py_aep/models/preferences.ts";
import { recursiveFind } from "../../src/py_aep/binary/utils.ts";
import { IdtaChunk } from "../../src/py_aep/binary/item_chunks.ts";
import { AVItem } from "../../src/py_aep/models/items/av_item.ts";
import type { Layer } from "../../src/py_aep/models/layers/layer.ts";
import { asInstance } from "../helpers.ts";
import { _RESIZE_TO_STRINGS, buildResizeToStrings } from "../../src/py_aep/models/renderqueue/settings.ts";
import { PrefsFile, decodePrefBool, decodePrefNumber, decodePrefString, findPrefsFile } from "../../src/py_aep/parsers/prefs.ts";

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
function prefsDirFixture(tmpPath: Path): Path {
  tmpPath.div("Adobe After Effects 26.0 Prefs.txt").writeText(_MACHINE_PREFS);
  tmpPath.div("Adobe After Effects 26.0 Prefs-indep-general.txt").writeText(_INDEP_PREFS);
  tmpPath.div("Adobe After Effects 26.0 Prefs-indep-composition.txt").writeText(_INDEP_COMP_PREFS);
  return tmpPath;
}

describe("TestPrefsFileParsing", () => {
  test("test_sections_and_keys", () => {
    const prefs = PrefsFile.fromText(_MACHINE_PREFS);
    expect(prefs.getRaw("Renderer Preference Section", "New Composition Default")).toBe('"ADBE Calder"');
    expect(prefs.getRaw("Numbers Section", "Raw Byte")).toBe("01");
  });

  test("test_missing_returns_none", () => {
    const prefs = PrefsFile.fromText(_MACHINE_PREFS);
    expect(prefs.getRaw("Numbers Section", "Nope") == null).toBe(true);
    expect(prefs.getRaw("Nope Section", "Quoted Int") == null).toBe(true);
  });

  test("test_continuation_lines", () => {
    const prefs = PrefsFile.fromText(_INDEP_PREFS);
    const raw = prefs.getRaw("Strings Section", "Long Value");
    expect(raw != null).toBe(true);
    if (raw == null) throw new Error("no raw 'Long Value' pref");
    expect(decodePrefString(raw)).toBe("part one and part two");
  });

  test("test_find_prefs_file", () => {
    const tmpPath = makeTmpPath();
    const prefsDir = prefsDirFixture(tmpPath);
    const machine = findPrefsFile(prefsDir, MACHINE);
    expect(machine != null && machine.name.endsWith(" Prefs.txt")).toBe(true);
    const indep = findPrefsFile(prefsDir, INDEP);
    expect(indep != null && indep.name.endsWith("-indep-general.txt")).toBe(true);
    expect(findPrefsFile(prefsDir, PREFType.PREF_Type_MACHINE_SPECIFIC_TEXT) == null).toBe(true);
  });
});

describe("TestValueDecoding", () => {
  test("test_number_forms", () => {
    expect(decodePrefNumber('"999"')).toBe(999);
    // NOTE(port): int/float — integral values are plain numbers by design (RULEBOOK §4); this isinstance(int) check cannot distinguish 999 from 999.0.
    expect(typeof decodePrefNumber('"999"') === "number" && Number.isInteger(decodePrefNumber('"999"'))).toBe(true);
    expect(approx(decodePrefNumber('"30.000000"'), 30.0)).toBe(true);
    expect(decodePrefNumber("01")).toBe(1);
    expect(decodePrefNumber("00FF")).toBe(255);
  });

  test("test_bool_forms", () => {
    expect(decodePrefBool("01")).toBe(true);
    expect(decodePrefBool("00")).toBe(false);
    expect(decodePrefBool('"1"')).toBe(true);
    expect(decodePrefBool('"0"')).toBe(false);
  });

  test("test_string_hex_escapes", () => {
    // AE writes non-ASCII characters as hex escapes outside quotes.
    expect(decodePrefString('"HD  "E280A2"  1920x1080"')).toBe("HD  •  1920x1080");
  });

  test("test_string_backslashes_preserved", () => {
    expect(decodePrefString('"C:\\Users\\test\\Documents"')).toBe("C:\\Users\\test\\Documents");
  });
});

describe("TestPreferences", () => {
  test("test_get_number", () => {
    const prefsDir = prefsDirFixture(makeTmpPath());
    const prefs = new py_aep.Preferences(prefsDir);
    expect(prefs.getPrefAsNumber("Numbers Section", "Quoted Int")).toBe(999);
    expect(
      approx(
        prefs.getPrefAsNumber("Import Options Preference Section", "Import Options Default Sequence FPS", INDEP),
        25.0,
      ),
    ).toBe(true);
  });

  test("test_get_bool", () => {
    const prefsDir = prefsDirFixture(makeTmpPath());
    const prefs = new py_aep.Preferences(prefsDir);
    const section = "Import Options Preference Section";
    expect(prefs.getPrefAsBool(section, "Quoted True", INDEP)).toBe(true);
    expect(prefs.getPrefAsBool(section, "Quoted False", INDEP)).toBe(false);
    expect(prefs.getPrefAsBool(section, "Import Options Default NTSC Dropframe", INDEP)).toBe(true);
    expect(prefs.getPrefAsBool(section, "Off Flag", INDEP)).toBe(false);
  });

  test("test_get_string", () => {
    const prefsDir = prefsDirFixture(makeTmpPath());
    const prefs = new py_aep.Preferences(prefsDir);
    expect(prefs.getPrefAsString("Renderer Preference Section", "New Composition Default")).toBe("ADBE Calder");
    expect(prefs.getPrefAsString("Auto Save", "Auto Save Folder", INDEP)).toBe("C:\\Users\\test\\Documents");
  });

  test("test_pref_type_routing", () => {
    const prefsDir = prefsDirFixture(makeTmpPath());
    const prefs = new py_aep.Preferences(prefsDir);
    // The key exists in the composition file only.
    expect(
      truthy(
        prefs.getPrefAsBool(
          "Composition Pref Section",
          "Composition Settings - Constrain Proportions",
          INDEP_COMP,
        ),
      ),
    ).toBe(true);
    raises(KeyError, () =>
      prefs.getPrefAsBool(
        "Composition Pref Section",
        "Composition Settings - Constrain Proportions",
        MACHINE,
      ),
    );
  });

  test("test_missing_key_raises_or_defaults", () => {
    const prefsDir = prefsDirFixture(makeTmpPath());
    const prefs = new py_aep.Preferences(prefsDir);
    raises(KeyError, () => prefs.getPrefAsNumber("Numbers Section", "Nope"));
    expect(prefs.getPrefAsNumber("Numbers Section", "Nope", undefined, { default: 7 })).toBe(7);
    expect(prefs.getPrefAsString("Numbers Section", "Nope", undefined, { default: "x" })).toBe("x");
    expect(prefs.getPrefAsBool("Numbers Section", "Nope", undefined, { default: true })).toBe(true);
  });

  test("test_have_pref", () => {
    const prefsDir = prefsDirFixture(makeTmpPath());
    const prefs = new py_aep.Preferences(prefsDir);
    expect(prefs.havePref("Numbers Section", "Quoted Int")).toBe(true);
    expect(prefs.havePref("Numbers Section", "Nope")).toBe(false);
  });

  test("test_no_prefs_dir", () => {
    const prefs = new py_aep.Preferences();
    raises(KeyError, () => prefs.getPrefAsNumber("Numbers Section", "Quoted Int"));
    expect(prefs.getPrefAsNumber("A", "B", undefined, { default: 5 })).toBe(5);
    expect(prefs.havePref("A", "B")).toBe(false);
    // Overrides work without any preference files.
    prefs.setPrefAsNumber("A", "B", 12);
    expect(prefs.getPrefAsNumber("A", "B")).toBe(12);
  });

  test("test_overrides_take_precedence", () => {
    const prefsDir = prefsDirFixture(makeTmpPath());
    const prefs = new py_aep.Preferences(prefsDir);
    prefs.setPrefAsNumber("Numbers Section", "Quoted Int", 5);
    expect(prefs.getPrefAsNumber("Numbers Section", "Quoted Int")).toBe(5);
    prefs.setPrefAsString("Renderer Preference Section", "New Composition Default", "ADBE Escher");
    expect(prefs.getPrefAsString("Renderer Preference Section", "New Composition Default")).toBe("ADBE Escher");
    prefs.setPrefAsBool("Numbers Section", "Raw Byte", false);
    expect(prefs.getPrefAsBool("Numbers Section", "Raw Byte")).toBe(false);
  });

  test("test_override_cross_type_reads", () => {
    const prefsDir = prefsDirFixture(makeTmpPath());
    const prefs = new py_aep.Preferences(prefsDir);
    prefs.setPrefAsNumber("Numbers Section", "Quoted Int", 5);
    expect(prefs.getPrefAsString("Numbers Section", "Quoted Int")).toBe("5");
    expect(prefs.getPrefAsBool("Numbers Section", "Quoted Int")).toBe(true);
  });

  test("test_overrides_never_touch_disk", () => {
    const prefsDir = prefsDirFixture(makeTmpPath());
    const target = prefsDir.div("Adobe After Effects 26.0 Prefs.txt");
    const before = target.readBytes();
    const prefs = new py_aep.Preferences(prefsDir);
    prefs.setPrefAsNumber("Numbers Section", "Quoted Int", 5);
    prefs.deletePref("Numbers Section", "Raw Byte");
    expect(valueEquals(target.readBytes(), before)).toBe(true);
  });

  test("test_delete_pref_masks_file_value", () => {
    const prefsDir = prefsDirFixture(makeTmpPath());
    const prefs = new py_aep.Preferences(prefsDir);
    prefs.deletePref("Numbers Section", "Quoted Int");
    expect(prefs.havePref("Numbers Section", "Quoted Int")).toBe(false);
    raises(KeyError, () => prefs.getPrefAsNumber("Numbers Section", "Quoted Int"));
    expect(prefs.getPrefAsNumber("Numbers Section", "Quoted Int", undefined, { default: 1 })).toBe(1);
  });

  test("test_reload_discards_overrides", () => {
    const prefsDir = prefsDirFixture(makeTmpPath());
    const prefs = new py_aep.Preferences(prefsDir);
    prefs.setPrefAsNumber("Numbers Section", "Quoted Int", 5);
    prefs.deletePref("Numbers Section", "Raw Byte");
    prefs.reload();
    expect(prefs.getPrefAsNumber("Numbers Section", "Quoted Int")).toBe(999);
    expect(prefs.getPrefAsNumber("Numbers Section", "Raw Byte")).toBe(1);
  });

  test("test_validation", () => {
    const prefsDir = prefsDirFixture(makeTmpPath());
    const prefs = new py_aep.Preferences(prefsDir);
    raises(ValueError, () => prefs.getPrefAsNumber("", "Quoted Int"));
    // @ts-expect-error deliberately passes a number that is not a PREFType to check runtime validation
    raises(ValueError, () => prefs.getPrefAsNumber("Numbers Section", "Quoted Int", 1234));
    // @ts-expect-error deliberately passes a non-bool to check runtime validation
    raises(TypeError, () => prefs.setPrefAsBool("A", "B", 1));
    // @ts-expect-error deliberately passes a non-string to check runtime validation
    raises(TypeError, () => prefs.setPrefAsString("A", "B", 5));
    // @ts-expect-error deliberately passes a non-number to check runtime validation
    raises(TypeError, () => prefs.setPrefAsNumber("A", "B", "5"));
  });
});

describe("TestApplicationPreferences", () => {
  test("test_app_preferences_object", () => {
    const prefsDir = prefsDirFixture(makeTmpPath());
    const app = py_aep.newProject(undefined, { aePreferencesDir: prefsDir });
    expect(app.preferences instanceof py_aep.Preferences).toBe(true);
    expect(app.preferences).toBe(app.project._preferences);
  });
});

/** Creation defaults resolve from prefs, with AE factory fallbacks. */
describe("TestCreationWiring", () => {
  test("test_labels_from_prefs", () => {
    const prefsDir = prefsDirFixture(makeTmpPath());
    const app = py_aep.newProject(undefined, { aePreferencesDir: prefsDir });
    const comp = app.project.rootFolder.addComp("C", 100, 100, 1.0, 1.0, 25.0);
    expect(asInstance(comp._idta, IdtaChunk).label).toBe(9);
    expect(asInstance(app.project.rootFolder.addFolder("F")._idta, IdtaChunk).label).toBe(12);
    const solid = comp.addSolid([1.0, 0.0, 0.0]);
    expect(solid._ldta.label).toBe(4);
    expect(asInstance(asInstance(solid.source, AVItem)._idta, IdtaChunk).label).toBe(4);
    expect(comp.addNull()._ldta.label).toBe(6);
    expect(comp.addText("hi")._ldta.label).toBe(3);
    expect(comp.addShape()._ldta.label).toBe(13);
    expect(comp.addCamera("cam", [50.0, 50.0])._ldta.label).toBe(10);
    expect(comp.addLight("light", [50.0, 50.0])._ldta.label).toBe(11);
  });

  test("test_labels_factory_defaults", () => {
    // Probed in AE 2026 with factory label preferences.
    const app = py_aep.newProject();
    const comp = app.project.rootFolder.addComp("C", 100, 100, 1.0, 1.0, 25.0);
    expect(asInstance(comp._idta, IdtaChunk).label).toBe(15);
    expect(asInstance(app.project.rootFolder.addFolder("F")._idta, IdtaChunk).label).toBe(2);
    const solid = comp.addSolid([1.0, 0.0, 0.0]);
    expect(solid._ldta.label).toBe(1);
    expect(asInstance(asInstance(solid.source, AVItem)._idta, IdtaChunk).label).toBe(1);
    expect(comp.addNull()._ldta.label).toBe(1);
    expect(comp.addText("hi")._ldta.label).toBe(1);
    expect(comp.addShape()._ldta.label).toBe(8);
    expect(comp.addCamera("cam", [50.0, 50.0])._ldta.label).toBe(4);
    expect(comp.addLight("light", [50.0, 50.0])._ldta.label).toBe(6);
  });

  test("test_label_override", () => {
    const prefsDir = prefsDirFixture(makeTmpPath());
    const app = py_aep.newProject(undefined, { aePreferencesDir: prefsDir });
    app.preferences.setPrefAsNumber("Label Preference Indices Section 5", "Comp Label Index 2", 16, INDEP);
    const comp = app.project.rootFolder.addComp("C", 100, 100, 1.0, 1.0, 25.0);
    expect(asInstance(comp._idta, IdtaChunk).label).toBe(16);
  });

  test("test_solids_folder_name_from_prefs", () => {
    const prefsDir = prefsDirFixture(makeTmpPath());
    const app = py_aep.newProject(undefined, { aePreferencesDir: prefsDir });
    expect(app.project._solidsFolderName).toBe("Solides");
    const comp = app.project.rootFolder.addComp("C", 100, 100, 1.0, 1.0, 25.0);
    comp.addSolid([1.0, 0.0, 0.0]);
    expect(valueEquals(app.project.rootFolder.folders.map((f) => f.name), ["Solides"])).toBe(true);
  });

  test("test_solids_folder_name_stamped_in_saved_file", () => {
    // The pref is stamped into the sfnm chunk at new(); a fresh parse
    // (without any prefs dir) reads the stored name back.
    const tmpPath = makeTmpPath();
    const prefsDir = prefsDirFixture(tmpPath);
    const app = py_aep.newProject(undefined, { aePreferencesDir: prefsDir });
    const out = tmpPath.div("out.aep");
    app.project.save(out);
    const reparsed = py_aep.parse(out);
    expect(reparsed.project._solidsFolderName).toBe("Solides");
  });

  test("test_solids_folder_name_factory_default", () => {
    const app = py_aep.newProject();
    expect(app.project._solidsFolderName).toBe("Solids");
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
    expect(psdCompLayerStyles(prefs) == null).toBe(true);
    expect(psdFootageLayerStyles(prefs) == null).toBe(true);
    expect(psdFootageDimensions(prefs) == null).toBe(true);
  });

  test("test_comp_layer_styles_mapping", () => {
    const prefs = new py_aep.Preferences();
    prefs.setPrefAsNumber(SECTION, "PSD Comp Layer Styles Option v2", 0);
    expect(psdCompLayerStyles(prefs)).toBe("editable");
    prefs.setPrefAsNumber(SECTION, "PSD Comp Layer Styles Option v2", 1);
    expect(psdCompLayerStyles(prefs)).toBe("merge");
  });

  test("test_footage_layer_styles_mapping", () => {
    const prefs = new py_aep.Preferences();
    prefs.setPrefAsNumber(SECTION, "PSD Footage Layer Styles Option", 0);
    expect(psdFootageLayerStyles(prefs)).toBe("merge");
    prefs.setPrefAsNumber(SECTION, "PSD Footage Layer Styles Option", 1);
    expect(psdFootageLayerStyles(prefs)).toBe("ignore");
  });

  test("test_footage_dimensions_mapping", () => {
    const prefs = new py_aep.Preferences();
    prefs.setPrefAsNumber(SECTION, "PSD Dimensions Popup", 0);
    expect(psdFootageDimensions(prefs)).toBe("layer");
    prefs.setPrefAsNumber(SECTION, "PSD Dimensions Popup", 1);
    expect(psdFootageDimensions(prefs)).toBe("document");
  });

  test("test_unknown_index_returns_none", () => {
    const prefs = new py_aep.Preferences();
    prefs.setPrefAsNumber(SECTION, "PSD Dimensions Popup", 7);
    expect(psdFootageDimensions(prefs) == null).toBe(true);
  });
});

/** Composition presets parsed from the AE preferences, and the New Composition helpers. */
describe("TestCompositionPresets", () => {
  test("test_parse_presets", () => {
    const prefsDir = prefsDirFixture(makeTmpPath());
    const presets = new py_aep.Preferences(prefsDir).compositionPresets();
    // The "-" separator entry is skipped.
    expect(presets.length).toBe(3);
    const [hd24, hd2997, hdv] = presets;
    expect(hd24.name.includes("1920x1080") && hd24.name.includes("24 fps")).toBe(true);
    expect(valueEquals([hd24.width, hd24.height], [1920, 1080])).toBe(true);
    expect(approx(hd24.frameRate, 24.0)).toBe(true);
    expect(approx(hd24.pixelAspect, 1.0)).toBe(true);
    expect(approx(hd2997.frameRate, 29.97, { abs: 1e-3 })).toBe(true);
    expect(valueEquals([hdv.width, hdv.height], [1440, 1080])).toBe(true);
    expect(approx(hdv.frameRate, 25.0)).toBe(true);
    expect(approx(hdv.pixelAspect, 4 / 3)).toBe(true);
  });

  test("test_no_prefs_dir", () => {
    expect(valueEquals(new py_aep.Preferences().compositionPresets(), [])).toBe(true);
  });

  test("test_add_comp_from_preset", () => {
    const prefsDir = prefsDirFixture(makeTmpPath());
    const app = py_aep.newProject(undefined, { aePreferencesDir: prefsDir });
    const comp = app.project.rootFolder.addCompFromPreset("C", "1440x1080", 5.0);
    expect(valueEquals([comp.width, comp.height], [1440, 1080])).toBe(true);
    expect(approx(comp.pixelAspect, 4 / 3)).toBe(true);
    expect(approx(comp.frameRate, 25.0)).toBe(true);
    expect(approx(comp.duration, 5.0)).toBe(true);
    expect(comp.name).toBe("C");
  });

  test("test_add_comp_from_preset_ntsc_rate", () => {
    const prefsDir = prefsDirFixture(makeTmpPath());
    const app = py_aep.newProject(undefined, { aePreferencesDir: prefsDir });
    const comp = app.project.rootFolder.addCompFromPreset("C", "29.97", 5.0);
    expect(approx(comp.frameRate, 29.97, { abs: 1e-3 })).toBe(true);
  });

  test("test_add_comp_from_preset_ambiguous", () => {
    const prefsDir = prefsDirFixture(makeTmpPath());
    const app = py_aep.newProject(undefined, { aePreferencesDir: prefsDir });
    raises(ValueError, () => app.project.rootFolder.addCompFromPreset("C", "1920x1080", 5.0), "matched 2");
  });

  test("test_add_comp_from_preset_unknown", () => {
    const prefsDir = prefsDirFixture(makeTmpPath());
    const app = py_aep.newProject(undefined, { aePreferencesDir: prefsDir });
    raises(ValueError, () => app.project.rootFolder.addCompFromPreset("C", "8K", 5.0), "matched 0");
  });

  test("test_add_comp_from_preset_without_prefs", () => {
    const app = py_aep.newProject();
    raises(ValueError, () => app.project.rootFolder.addCompFromPreset("C", "HD", 5.0), "no composition presets");
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
    const prefsDir = prefsDirFixture(makeTmpPath());
    // Fixture presets: HD 1920x1080 @ 24 and @ 29.97 - lowest wins.
    const resize = buildResizeToStrings(new py_aep.Preferences(prefsDir));
    expect(getOrThrow(resize, compositeKey(1920, 1080))).toBe("HD  •  1920x1080 • 24 fps");
    expect(getOrThrow(resize, compositeKey(1440, 1080))).toBe("HDV  •  1440x1080 (1.33) • 25 fps");
  });

  test("test_tie_break_prefers_later_preset", () => {
    const tmpPath = makeTmpPath();
    const prefs = tmpPath.div("prefs");
    prefs.mkdir();
    prefs.div("Adobe After Effects 26.0 Prefs-indep-composition.txt").writeText(_TIE_COMP_PREFS);
    const resize = buildResizeToStrings(new py_aep.Preferences(prefs));
    expect(getOrThrow(resize, compositeKey(1440, 1080))).toBe("Second  •  1440x1080 • 25 fps");
  });

  test("test_fallback_without_prefs", () => {
    expect(buildResizeToStrings(new py_aep.Preferences()) === _RESIZE_TO_STRINGS).toBe(true);
  });

  test("test_fallback_holds_ae_verified_collision_labels", () => {
    // AE 2026 getSetting("Resize to") ground truth for factory presets.
    expect(getOrThrow(_RESIZE_TO_STRINGS, compositeKey(1920, 1080))).toBe("HD  •  1920x1080 • 24 fps");
    expect(getOrThrow(_RESIZE_TO_STRINGS, compositeKey(3840, 2160))).toBe("UHD (4K)  •  3840x2160 • 23.976 fps");
  });
});

describe("TestOutputNameTemplatePresets", () => {
  test("test_parse", () => {
    const prefsDir = prefsDirFixture(makeTmpPath());
    const presets = new py_aep.Preferences(prefsDir).outputNameTemplatePresets();
    expect(
      valueEquals(
        presets,
        new Map([
          ["Comp Name", "[compName].[fileExtension]"],
          ["Comp Folder and Name", "[compName]/[compName].[fileExtension]"],
        ]),
      ),
    ).toBe(true);
  });

  test("test_no_prefs_dir", () => {
    expect(valueEquals(new py_aep.Preferences().outputNameTemplatePresets(), new Map())).toBe(true);
  });
});

/** newProject() inherits the last-used Project Settings preferences. */
describe("TestNewProjectSettings", () => {
  test("test_depth_and_time_display_from_prefs", () => {
    const prefsDir = prefsDirFixture(makeTmpPath());
    const project = py_aep.newProject(undefined, { aePreferencesDir: prefsDir }).project;
    expect(project.bitsPerChannel).toBe(BitsPerChannel.SIXTEEN);
    for (const chunk of [project._nnhd, project._nhed]) {
      expect(chunk.timeDisplayType).toBe(1);
      expect(chunk.footageTimecodeDisplayStartType).toBe(0);
      expect(truthy(chunk.framesUseFeetFrames)).toBe(true);
      expect(chunk.timecodeDefaultBase).toBe(24);
      expect(chunk.framesCountType).toBe(1);
    }
  });

  test("test_factory_defaults_without_prefs", () => {
    const project = py_aep.newProject().project;
    expect(project.bitsPerChannel).toBe(BitsPerChannel.EIGHT);
    for (const chunk of [project._nnhd, project._nhed]) {
      expect(chunk.timeDisplayType).toBe(0);
      expect(chunk.timecodeDefaultBase).toBe(30);
      expect(chunk.framesCountType).toBe(2);
    }
  });
});

/** The "Create New Layers At Time Zero" preference (off in the fixture). */
describe("TestCreateLayersAtCurrentTime", () => {
  test("test_layers_anchor_at_comp_time", () => {
    // AE 2026 probed: start = in = comp.time, out shifted by the same
    // amount, for every scripted layer-creation method.
    const prefsDir = prefsDirFixture(makeTmpPath());
    const app = py_aep.newProject(undefined, { aePreferencesDir: prefsDir });
    const comp = app.project.rootFolder.addComp("C", 100, 100, 1.0, 5.0, 25.0);
    comp.time = 2.0;
    const solid = comp.addSolid([1.0, 0.0, 0.0]);
    expect(approx(solid.startTime, 2.0)).toBe(true);
    expect(approx(solid.inPoint, 2.0)).toBe(true);
    expect(approx(solid.outPoint, 7.0)).toBe(true);
    const text = comp.addText("hi");
    expect(approx(text.startTime, 2.0)).toBe(true);
  });

  test("test_no_shift_at_time_zero", () => {
    const prefsDir = prefsDirFixture(makeTmpPath());
    const app = py_aep.newProject(undefined, { aePreferencesDir: prefsDir });
    const comp = app.project.rootFolder.addComp("C", 100, 100, 1.0, 5.0, 25.0);
    const solid = comp.addSolid([1.0, 0.0, 0.0]);
    expect(approx(solid.startTime, 0.0)).toBe(true);
  });

  test("test_pref_on_keeps_layers_at_zero", () => {
    // Factory default (no prefs dir): layers start at time zero.
    const app = py_aep.newProject();
    const comp = app.project.rootFolder.addComp("C", 100, 100, 1.0, 5.0, 25.0);
    comp.time = 2.0;
    const solid = comp.addSolid([1.0, 0.0, 0.0]);
    expect(approx(solid.startTime, 0.0)).toBe(true);
  });

  test("test_duplicate_keeps_source_timing", () => {
    // AE 2026 probed: duplicate() keeps the source layer's timing and
    // does not re-anchor at the current time.
    const prefsDir = prefsDirFixture(makeTmpPath());
    const app = py_aep.newProject(undefined, { aePreferencesDir: prefsDir });
    const comp = app.project.rootFolder.addComp("C", 100, 100, 1.0, 5.0, 25.0);
    comp.time = 2.0;
    const solid = comp.addSolid([1.0, 0.0, 0.0]);
    comp.time = 4.0;
    const dup = solid.duplicate();
    expect(approx(dup.startTime, 2.0)).toBe(true);
  });
});

/**
 * The still/synthetic default out-point preferences (probed in AE
 * 2026: value/scale seconds; solids, nulls, text, shape, camera and
 * light follow the synthetic preference).
 */
describe("TestDefaultOutPoints", () => {
  /** Fixture `outpoint_prefs_dir`. */
  function outpointPrefsDir(tmpPath: Path): Path {
    tmpPath
      .div("Adobe After Effects 26.0 Prefs-indep-general.txt")
      .writeText(
        '["Main Pref Section v2"]\n' +
          '\t"Pref_DEFAULT_STILL_OUT_POINT v2" = "75/25"\n' +
          '\t"Pref_DEFAULT_SYNTHETIC_OUT_POINT v2" = "50/25"\n',
      );
    return tmpPath;
  }

  test("test_synthetic_layers_follow_pref", () => {
    const outpointPrefs = outpointPrefsDir(makeTmpPath());
    const app = py_aep.newProject(undefined, { aePreferencesDir: outpointPrefs });
    const comp = app.project.rootFolder.addComp("C", 100, 100, 1.0, 5.0, 25.0);
    expect(approx(comp.addSolid([1.0, 0.0, 0.0]).outPoint, 2.0)).toBe(true);
    expect(approx(comp.addNull().outPoint, 2.0)).toBe(true);
    expect(approx(comp.addText("x").outPoint, 2.0)).toBe(true);
    expect(approx(comp.addShape().outPoint, 2.0)).toBe(true);
    expect(approx(comp.addCamera("c", [50.0, 50.0]).outPoint, 2.0)).toBe(true);
    expect(approx(comp.addLight("l", [50.0, 50.0]).outPoint, 2.0)).toBe(true);
  });

  test("test_solid_duration_arg_honored", () => {
    // py_aep honors an explicit duration argument, overriding the
    // synthetic out-point preference (AE's addSolid ignores it).
    const outpointPrefs = outpointPrefsDir(makeTmpPath());
    const app = py_aep.newProject(undefined, { aePreferencesDir: outpointPrefs });
    const comp = app.project.rootFolder.addComp("C", 100, 100, 1.0, 5.0, 25.0);
    const solid = comp.addSolid([1.0, 0.0, 0.0], undefined, undefined, undefined, undefined, 8.0);
    expect(approx(solid.outPoint, 8.0)).toBe(true);
  });

  test("test_factory_defaults_span_comp_duration", () => {
    const app = py_aep.newProject();
    const comp = app.project.rootFolder.addComp("C", 100, 100, 1.0, 5.0, 25.0);
    // No preferences and no explicit duration: the default span is the
    // composition duration.
    expect(approx(comp.addSolid([1.0, 0.0, 0.0]).outPoint, 5.0)).toBe(true);
    expect(approx(comp.addText("x").outPoint, 5.0)).toBe(true);
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

function _textStyleDir(tmpPath: Path, sheet: string): Path {
  const prefs = tmpPath.div("prefs");
  prefs.mkdir({ existOk: true });
  prefs.div("Adobe After Effects 26.0 Prefs-text.txt").writeText(sheet);
  return prefs;
}

function _btdkBytes(layer: Layer): Uint8Array {
  const matches = recursiveFind(layer._layerList.chunks, undefined, "btdk");
  assert(matches.length === 1);
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
    const tmpPath = makeTmpPath();
    const prefs = _textStyleDir(tmpPath, _CUSTOM_TEXT_STYLE);
    const app = py_aep.newProject(undefined, { aePreferencesDir: prefs });
    const comp = app.project.rootFolder.addComp("C", 100, 100, 1.0, 5.0, 25.0);
    const text = comp.addText("probe").text;
    if (text == null) throw new Error("text layer has no text group");
    const td = text.property("ADBE Text Document").value;
    expect(td.font).toBe("ArialMT");
    expect(approx(td.fontSize, 48.0)).toBe(true);
    expect(approx(td.fillColor, [0.25, 0.5, 0.75])).toBe(true);
    expect(approx(td.tracking, 50.0)).toBe(true);
    expect(approx(td.baselineShift, 5.0)).toBe(true);
    expect(td.applyStroke).toBe(true);
    expect(approx(td.strokeWidth, 5.0)).toBe(true);
    expect(approx(td.strokeColor, [0.1, 0.2, 0.0])).toBe(true);
  });

  test("test_no_prefs_is_byte_identical_to_template", () => {
    // Without a prefs dir, add_text must not change a single byte of
    // the baked COS template (btdk is byte-format-sensitive).
    const app = py_aep.newProject();
    const comp = app.project.rootFolder.addComp("C", 100, 100, 1.0, 5.0, 25.0);
    const layerBytes = _btdkBytes(comp.addText("probe"));
    const buf = new BytesIO();
    new py_aep.TextDocument("probe")._btdkBody.write(buf);
    expect(valueEquals(layerBytes, buf.getvalue())).toBe(true);
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
    const tmpPath = makeTmpPath();
    const prefs = _textStyleDir(tmpPath, sheet);
    const appPrefs = py_aep.newProject(undefined, { aePreferencesDir: prefs });
    const compPrefs = appPrefs.project.rootFolder.addComp("C", 100, 100, 1.0, 5.0, 25.0);
    const appPlain = py_aep.newProject();
    const compPlain = appPlain.project.rootFolder.addComp("C", 100, 100, 1.0, 5.0, 25.0);
    expect(valueEquals(_btdkBytes(compPrefs.addText("probe")), _btdkBytes(compPlain.addText("probe")))).toBe(true);
  });

  test("test_factory_sheet_matches_ae_addtext", () => {
    // The template now matches AE 2026's own factory addText output
    // (MyriadPro-Regular, size 36, fill 0.921569, no stroke), so
    // applying the factory sheet is a no-op that stays on AE's values.
    const tmpPath = makeTmpPath();
    const prefs = _textStyleDir(tmpPath, _FACTORY_TEXT_STYLE);
    const app = py_aep.newProject(undefined, { aePreferencesDir: prefs });
    const comp = app.project.rootFolder.addComp("C", 100, 100, 1.0, 5.0, 25.0);
    const text = comp.addText("probe").text;
    if (text == null) throw new Error("text layer has no text group");
    const td = text.property("ADBE Text Document").value;
    expect(td.font).toBe("MyriadPro-Regular");
    expect(approx(td.fontSize, 36.0)).toBe(true);
    expect(approx(td.fillColor, [0.921569, 0.921569, 0.921569], { abs: 1e-5 })).toBe(true);
    expect(!truthy(td.applyStroke)).toBe(true);
  });

  test("test_box_text_honors_style_sheet", () => {
    const tmpPath = makeTmpPath();
    const prefs = _textStyleDir(tmpPath, _CUSTOM_TEXT_STYLE);
    const app = py_aep.newProject(undefined, { aePreferencesDir: prefs });
    const comp = app.project.rootFolder.addComp("C", 100, 100, 1.0, 5.0, 25.0);
    const text = comp.addBoxText([80.0, 40.0], "boxed").text;
    if (text == null) throw new Error("text layer has no text group");
    const td = text.property("ADBE Text Document").value;
    expect(td.font).toBe("ArialMT");
    expect(approx(td.fontSize, 48.0)).toBe(true);
  });
});
