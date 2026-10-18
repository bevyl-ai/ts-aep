/**
 * Visualize an After Effects project structure.
 *
 * Supports multiple output formats:
 * - text: ASCII tree in terminal
 * - dot: Graphviz DOT format (can be rendered with `dot -Tpng output.dot -o output.png`)
 * - mermaid: Mermaid flowchart (embeddable in markdown)
 * - json: JSON hierarchy (for custom processing)
 *
 * Usage:
 *     aep-visualize project.aep
 *     aep-visualize project.aep --format dot \> project.dot
 *     aep-visualize project.aep --format mermaid
 *     aep-visualize project.aep --depth 2
 *     aep-visualize project.aep --no-properties
 */

import * as host from "../../pyrt/host.ts";

import { parse } from "../index.ts";

import { CompItem } from "../models/items/composition.ts";
import { FolderItem } from "../models/items/folder.ts";
import { FootageItem } from "../models/items/footage.ts";
import { PropertyGroup } from "../models/properties/property_group.ts";
import { BitsPerChannel, Label } from "../enums/index.ts";
import {
  Path,
  RuntimeError,
  format,
  int,
  len,
  py_bool,
  repr,
  round,
  str,
  json_dumps,
  pyfloat,
  type PyFloat,
} from "../../pyrt/index.ts";

import type { Application } from "../models/application.ts";
import type { Item } from "../models/items/item.ts";
import type { Layer } from "../models/layers/layer.ts";
import type { Project } from "../models/project.ts";
import type { Property } from "../models/properties/property.ts";
import type { OutputModule } from "../models/renderqueue/output_module.ts";
import type { RenderQueueItem } from "../models/renderqueue/render_queue_item.ts";

/** `TextIO` as used by the formatters: anything with `write(str)`. */
export type TextIO = { write(s: string): void };

/** A node attribute value: scalars, floats or small arrays; `null` entries are skipped when printing. */
export type AttrValue = string | number | boolean | null | PyFloat | readonly number[];

/** A node of the uniform tree the formatters consume (a `Map` of attributes plus children). */
export type Node = {
  type: string;
  name: string;
  /** A Map so that insertion order and Python repr hold. */
  attrs: Map<string, AttrValue>;
  children: Node[];
};

// =============================================================================
// Node builders - Convert model objects to a uniform tree structure
// =============================================================================

/** Build the root project node. */
export function build_project_node(app: Application, include_properties: boolean = true): Node {
  const project = app.project;
  const attrs: Map<string, AttrValue> = new Map<string, AttrValue>([
    ["version", app.version],
    ["build_number", app.buildNumber],
    ["bits_per_channel", BitsPerChannel.name_of(project.bitsPerChannel)],
    ["expression_engine", project.expressionEngine],
  ]);
  if (project.effectNames?.length > 0) attrs.set("effects_used", project.effectNames.length);

  const children: Node[] = [];
  const root = project.rootFolder;
  for (const item of root) {
    children.push(build_item_node(item, project, include_properties));
  }

  // Add render queue if it has items
  if (project.renderQueue == null) {
    throw new RuntimeError("Project renderQueue should not be None");
  }
  if (project.renderQueue.items?.length > 0) {
    children.push(build_render_queue_node(project));
  }

  return {
    type: "Project",
    name: new Path(project.file).name,
    attrs,
    children,
  };
}

/** Build a node for any item type. */
export function build_item_node(item: Item, project: Project, include_properties: boolean = true): Node {
  if (item instanceof FolderItem) {
    return build_folder_node(item, project, include_properties);
  } else if (item instanceof CompItem) {
    return build_comp_node(item, project, include_properties);
  } else if (item instanceof FootageItem) {
    return build_footage_node(item);
  } else {
    return {
      type: "Item",
      name: item.name,
      attrs: new Map<string, AttrValue>([["type_name", item.typeName]]),
      children: [],
    };
  }
}

/** Build a folder node with its children. */
export function build_folder_node(folder: FolderItem, project: Project, include_properties: boolean = true): Node {
  const children: Node[] = [];
  for (const item of folder) {
    children.push(build_item_node(item, project, include_properties));
  }

  return {
    type: "Folder",
    name: folder.name,
    attrs: new Map<string, AttrValue>([
      ["label", folder.label !== 0 ? Label.name_of(folder.label).toLowerCase() : null],
    ]),
    children,
  };
}

/** Build a composition node with layers. */
export function build_comp_node(comp: CompItem, project: Project, include_properties: boolean = true): Node {
  const attrs: Map<string, AttrValue> = new Map<string, AttrValue>([
    ["size", `${comp.width}x${comp.height}`],
    ["duration", `${format(comp.duration, ".2f")}s`],
    ["frame_rate", pyfloat(comp.frameRate)],
    ["layers_count", comp.layers.length],
  ]);
  if (comp.markers?.length > 0) attrs.set("markers", comp.markers.length);

  const children: Node[] = [];
  for (const layer of comp.layers) {
    children.push(build_layer_node(layer, project, include_properties));
  }

  return {
    type: "Composition",
    name: comp.name,
    attrs,
    children,
  };
}

/** Build a footage item node. */
export function build_footage_node(footage: FootageItem): Node {
  const attrs: Map<string, AttrValue> = new Map<string, AttrValue>([
    ["asset_type", footage.assetType],
    ["size", `${footage.width}x${footage.height}`],
  ]);
  if (footage.duration > 0) attrs.set("duration", `${format(footage.duration, ".2f")}s`);
  if (footage.file) attrs.set("file", new Path(footage.file).name);

  return {
    type: "Footage",
    name: footage.name,
    attrs,
    children: [],
  };
}

/** Build a layer node with properties. */
export function build_layer_node(layer: Layer, project: Project, include_properties: boolean = true): Node {
  const attrs: Map<string, AttrValue> = new Map<string, AttrValue>([
    ["type", layer.layerType],
    ["enabled", layer.enabled],
  ]);
  if (!layer.enabled) attrs.set("enabled", false);
  if (layer.nullLayer) attrs.set("null", true);
  const parent = layer.parent;
  if (parent != null && parent.length > 0) attrs.set("parent", parent.name);
  if (layer.markers?.length > 0) attrs.set("markers", layer.markers.length);

  const children: Node[] = [];
  if (include_properties) {
    // Transform properties
    if (layer.transform.length > 0) children.push(build_property_group_node(layer.transform));

    // Effects
    const effects = layer.effects;
    if (effects != null && effects.length > 0) children.push(build_property_group_node(effects));

    // Text properties
    if (layer.text instanceof PropertyGroup) children.push(build_property_group_node(layer.text));
  }

  return {
    type: "Layer",
    name: layer.name || "(unnamed)",
    attrs,
    children,
  };
}

/** Build a property group node. */
export function build_property_group_node(group: PropertyGroup): Node {
  const attrs: Map<string, boolean> = new Map<string, boolean>();
  if (group.isEffect) attrs.set("effect", true);

  const children = group.properties.map((p) => build_property_or_group_node(p));

  return {
    type: "PropertyGroup",
    name: group.name,
    attrs,
    children,
  };
}

/** Build a property or property group node. */
export function build_property_or_group_node(prop: Property | PropertyGroup): Node {
  if (prop instanceof PropertyGroup) return build_property_group_node(prop);
  return build_property_node(prop);
}

/** Build a property node. */
export function build_property_node(prop: Property): Node {
  const attrs: Map<string, AttrValue> = new Map<string, AttrValue>();
  if (prop._animated) {
    attrs.set("animated", true);
    attrs.set("keyframes", prop.keyframes.length);
  }
  if (prop.expressionEnabled && prop.expression) attrs.set("expression", true);
  if (prop.value != null && !prop._animated) {
    // Format value for display
    if (Array.isArray(prop.value)) {
      if (prop.value.length <= 4) attrs.set("value", prop.value);
    } else if (typeof prop.value === "number") {
      // NOTE(port): int/float — integral values are plain numbers by design (RULEBOOK §4); an integral Python float (100.0) displays as `100` here instead of `100.0`.
      attrs.set("value", round(prop.value, 2));
    } else {
      attrs.set("value", prop.value);
    }
  }

  return {
    type: "Property",
    name: prop.name,
    attrs,
    children: [],
  };
}

/** Build a render queue node with its items. */
export function build_render_queue_node(project: Project): Node {
  if (project.renderQueue == null) {
    throw new RuntimeError("Project renderQueue should not be None");
  }
  const attrs: Map<string, AttrValue> = new Map<string, AttrValue>([["items", project.renderQueue.items.length]]);

  const children: Node[] = [];
  for (const [i, item] of project.renderQueue.items.entries()) {
    children.push(build_render_queue_item_node(item, i + 1, project));
  }

  return {
    type: "RenderQueue",
    name: "Render Queue",
    attrs,
    children,
  };
}

/** Build a render queue item node with output modules. */
export function build_render_queue_item_node(item: RenderQueueItem, index: number, project: Project): Node {
  const attrs: Map<string, AttrValue> = new Map<string, AttrValue>([["output_modules", item.outputModules.length]]);

  // Try to find the comp name
  const comp = item.comp;
  attrs.set("comp", comp?.name ?? null);

  const children: Node[] = [];
  for (const om of item.outputModules) {
    children.push(build_output_module_node(om));
  }

  return {
    type: "RenderQueueItem",
    name: `Item ${index}`,
    attrs,
    children,
  };
}

/** Build an output module node. */
export function build_output_module_node(om: OutputModule): Node {
  const attrs: Map<string, AttrValue> = new Map<string, AttrValue>();
  if (om.file) attrs.set("file", new Path(om.file).name);
  if (om.fileTemplate) attrs.set("name_template", om.fileTemplate);

  return {
    type: "OutputModule",
    name: "Output Module",
    attrs,
    children: [],
  };
}

// =============================================================================
// Output formatters
// =============================================================================

/** Output as ASCII tree. */
export function format_text(
  node: Node,
  output: TextIO,
  prefix: string = "",
  is_last: boolean = true,
  max_depth: number | null = null,
  current_depth: number = 0,
): void {
  if (max_depth != null && current_depth > max_depth) return;

  // Determine connector
  let connector = is_last ? "└── " : "├── ";
  if (current_depth === 0) connector = "";

  // Format node line
  const type_icon = new Map<string, string>([
    ["Project", "📦"],
    ["Folder", "📁"],
    ["Composition", "🎬"],
    ["Footage", "🎞️"],
    ["Layer", "📄"],
    ["PropertyGroup", "📂"],
    ["Property", "⚙️"],
    ["Transform", "🔄"],
    ["RenderQueue", "🎯"],
    ["RenderQueueItem", "📋"],
    ["OutputModule", "💾"],
  ]);
  const icon = type_icon.get(node.type) ?? "•";

  let attrs_str = "";
  if (node.attrs?.size > 0) {
    // Filter out None values
    const filtered = new Map<string, AttrValue>([...node.attrs].filter(([, v]) => v != null));
    if (filtered.size > 0) {
      attrs_str = " " + repr(filtered);
    }
  }

  output.write(`${prefix}${connector}${icon} ${node.name}${attrs_str}\n`);

  // Process children
  const children = node.children;
  let child_prefix = prefix + (is_last ? "    " : "│   ");
  if (current_depth === 0) child_prefix = "";

  for (const [i, child] of children.entries()) {
    const is_last_child = i === children.length - 1;
    format_text(child, output, child_prefix, is_last_child, max_depth, current_depth + 1);
  }
}

/** Output as Graphviz DOT format. */
export function format_dot(node: Node, output: TextIO, max_depth: number | null = null): void {
  output.write("digraph AEProject {\n");
  output.write("    rankdir=TB;\n");
  output.write('    node [shape=record, fontname="Helvetica", fontsize=10];\n');
  output.write("    edge [fontsize=8];\n");
  output.write("\n");

  const node_id = [0]; // Use array for mutable counter in nested function

  function get_node_id(): string {
    node_id[0] += 1;
    return `n${node_id[0]}`;
  }

  /** Escape special characters for DOT labels. */
  function escape_dot(s: string): string {
    return s.replaceAll('"', '\\"').replaceAll("<", "\\<").replaceAll(">", "\\>").replaceAll("|", "\\|");
  }

  function write_node(n: Node, parent_id: string | null = null, depth: number = 0): string {
    if (max_depth != null && depth > max_depth) return "";

    const nid = get_node_id();

    // Color based on type
    const colors = new Map<string, string>([
      ["Project", "#4a90d9"],
      ["Folder", "#f5a623"],
      ["Composition", "#7ed321"],
      ["Footage", "#9b59b6"],
      ["Layer", "#3498db"],
      ["PropertyGroup", "#95a5a6"],
      ["Property", "#bdc3c7"],
      ["Transform", "#1abc9c"],
    ]);
    const color = colors.get(n.type) ?? "#cccccc";

    // Build label
    const name = escape_dot(n.name);
    const attrs = n.attrs;
    const attrs_lines: string[] = [];
    for (const [k, v] of attrs) {
      if (v != null) attrs_lines.push(`${k}: ${escape_dot(str(v))}`);
    }

    let label: string;
    if (attrs_lines.length > 0) {
      label = "{{" + n.type + "|" + name + "|" + attrs_lines.join("\\l") + "\\l}}";
    } else {
      label = "{{" + n.type + "|" + name + "}}";
    }

    output.write(`    ${nid} [label="${label}", style=filled, fillcolor="${color}"];\n`);

    if (parent_id) {
      output.write(`    ${parent_id} -> ${nid};\n`);
    }

    for (const child of n.children) {
      write_node(child, nid, depth + 1);
    }

    return nid;
  }

  write_node(node);
  output.write("}\n");
}

/** Output as Mermaid flowchart. */
export function format_mermaid(node: Node, output: TextIO, max_depth: number | null = null): void {
  output.write("```mermaid\nflowchart TD\n");

  const node_id = [0];

  function get_node_id(): string {
    node_id[0] += 1;
    return `n${node_id[0]}`;
  }

  /** Escape special characters for Mermaid. */
  function escape_mermaid(s: string): string {
    return s.replaceAll('"', "'").replaceAll("<", "‹").replaceAll(">", "›");
  }

  function write_node(n: Node, parent_id: string | null = null, depth: number = 0): string {
    if (max_depth != null && depth > max_depth) return "";

    const nid = get_node_id();
    const name = escape_mermaid(n.name);
    const node_type = n.type;

    // Different shapes for different types
    let shape: string;
    if (node_type === "Project") {
      shape = `${nid}[["🎬 ${name}"]]`;
    } else if (node_type === "Folder") {
      shape = `${nid}[/"📁 ${name}"/]`;
    } else if (node_type === "Composition") {
      shape = `${nid}[("🎬 ${name}")]`;
    } else if (node_type === "Footage") {
      shape = `${nid}[("🎞️ ${name}")]`;
    } else if (node_type === "Layer") {
      shape = `${nid}["📄 ${name}"]`;
    } else {
      shape = `${nid}("${name}")`;
    }

    output.write(`    ${shape}\n`);

    if (parent_id) {
      output.write(`    ${parent_id} --> ${nid}\n`);
    }

    for (const child of n.children) {
      write_node(child, nid, depth + 1);
    }

    return nid;
  }

  write_node(node);
  output.write("```\n");
}

/** A {@link Node} as {@link format_json} emits it: children past `max_depth` collapse to a summary string. */
type JsonNode = Omit<Node, "children"> & { children: JsonNode[] | string };

/** Output as JSON. */
export function format_json(node: Node, output: TextIO, max_depth: number | null = null): void {
  function filter_depth(n: Node, depth: number = 0): JsonNode {
    if (max_depth != null && depth >= max_depth) {
      const result: JsonNode = { ...n };
      if (py_bool(n.children)) {
        result.children = `[${len(n.children)} children omitted]`;
      }
      return result;
    }

    const result: JsonNode = { ...n };
    if (py_bool(n.children)) {
      result.children = n.children.map((c) => filter_depth(c, depth + 1));
    }
    return result;
  }

  const filtered = filter_depth(node);
  output.write(json_dumps(filtered, { indent: 2, default_: str }));
  output.write("\n");
}

// =============================================================================
// Main
// =============================================================================

export const PROG = "aep-visualize";

export const USAGE = `usage: aep-visualize [-h] [--format {text,dot,mermaid,json}] [--depth DEPTH]
                     [--no-properties] [--output OUTPUT]
                     aep_file
`;

export const HELP =
  USAGE +
  `
Visualize an After Effects project structure.

positional arguments:
  aep_file              Path to the .aep file

options:
  -h, --help            show this help message and exit
  --format {text,dot,mermaid,json}, -f {text,dot,mermaid,json}
                        Output format (default: text)
  --depth DEPTH, -d DEPTH
                        Maximum depth to display (default: unlimited)
  --no-properties       Exclude layer properties from output
  --output OUTPUT, -o OUTPUT
                        Output file (default: stdout)

Examples:
  aep-visualize project.aep
  aep-visualize project.aep --format dot > project.dot
  aep-visualize project.aep --format mermaid
  aep-visualize project.aep --depth 2 --no-properties
        
`;

export type Args = {
  aep_file: string;
  format: string;
  depth: number | null;
  no_properties: boolean;
  output: string | null;
};

/** The long options, in argparse's registration order (which orders an ambiguity error's matches). */
export const LONG_OPTIONS = ["--help", "--format", "--depth", "--no-properties", "--output"];

/**
 * argparse's `parse_args` for exactly the options this CLI declares: long and
 * short forms, unambiguous long-option prefixes, `--opt=value`, `-fVALUE`, `--`.
 *
 * TODO(port): no argparse shim. HELP/USAGE are argparse's layout for its default 80-column
 * (non-tty) width (argparse wraps to COLUMNS or the terminal width), and an unrecognized option
 * or extra positional errors at once where argparse first reports a missing aep_file.
 */
export function parse_args(argv: string[]): Args {
  const fail = (msg: string): never => {
    process.stderr.write(`${USAGE}${PROG}: error: ${msg}\n`);
    process.exit(2);
  };

  const choices = ["text", "dot", "mermaid", "json"];
  const args: Args = { aep_file: "", format: "text", depth: null, no_properties: false, output: null };
  const positionals: string[] = [];

  const apply = (long: string, value: string): void => {
    if (long === "--format") {
      if (!choices.includes(value)) {
        fail(`argument --format/-f: invalid choice: ${repr(value)} (choose from ${choices.join(", ")})`);
      }
      args.format = value;
    } else if (long === "--depth") {
      try {
        args.depth = int(value);
      } catch (e) {
        fail(`argument --depth/-d: invalid int value: ${repr(value)}`);
      }
    } else {
      args.output = value;
    }
  };

  let i = 0;
  let only_positional = false;
  const take_value = (label: string, inline: string | null): string => {
    if (inline != null) return inline;
    // argparse never takes an option-like string as the value.
    const next = argv[i];
    if (next === undefined || (next.startsWith("-") && next !== "-" && !/^-\d+$|^-\d*\.\d+$/.test(next))) {
      return fail(`argument ${label}: expected one argument`);
    }
    i += 1;
    return next;
  };

  while (i < argv.length) {
    const a = argv[i++];
    if (!only_positional && a === "--") {
      only_positional = true;
    } else if (!only_positional && a.startsWith("--")) {
      const eq = a.indexOf("=");
      const prefix = eq >= 0 ? a.slice(0, eq) : a;
      const inline = eq >= 0 ? a.slice(eq + 1) : null;
      const hits = LONG_OPTIONS.includes(prefix) ? [prefix] : LONG_OPTIONS.filter((o) => o.startsWith(prefix));
      if (hits.length > 1) fail(`ambiguous option: ${a} could match ${hits.join(", ")}`);
      const flag = hits.length === 1 ? hits[0] : prefix;
      if (flag === "--help") {
        process.stdout.write(HELP);
        process.exit(0);
      } else if (flag === "--no-properties") {
        if (inline != null) fail(`argument --no-properties: ignored explicit argument ${repr(inline)}`);
        args.no_properties = true;
      } else if (flag === "--format") {
        apply("--format", take_value("--format/-f", inline));
      } else if (flag === "--depth") {
        apply("--depth", take_value("--depth/-d", inline));
      } else if (flag === "--output") {
        apply("--output", take_value("--output/-o", inline));
      } else {
        fail(`unrecognized arguments: ${a}`);
      }
    } else if (!only_positional && a.length > 1 && a.startsWith("-") && !/^-\d/.test(a)) {
      const flag = a.slice(0, 2);
      const rest = a.slice(2);
      if (flag === "-h") {
        process.stdout.write(HELP);
        process.exit(0);
      } else if (flag === "-f") {
        apply("--format", take_value("--format/-f", rest.length ? rest : null));
      } else if (flag === "-d") {
        apply("--depth", take_value("--depth/-d", rest.length ? rest : null));
      } else if (flag === "-o") {
        apply("--output", take_value("--output/-o", rest.length ? rest : null));
      } else {
        fail(`unrecognized arguments: ${a}`);
      }
    } else {
      positionals.push(a);
    }
  }

  if (positionals.length === 0) fail("the following arguments are required: aep_file");
  if (positionals.length > 1) fail(`unrecognized arguments: ${positionals.slice(1).join(" ")}`);
  args.aep_file = positionals[0];
  return args;
}

/** CLI entry point for aep-visualize command. */
export function main(): number {
  const args = parse_args(process.argv.slice(2));

  const aep_path = new Path(args.aep_file);
  if (!aep_path.exists()) {
    process.stderr.write(`Error: File not found: ${aep_path}\n`);
    return 1;
  }

  const app = parse(aep_path);

  const include_properties = !args.no_properties;
  const root_node = build_project_node(app, include_properties);

  // Output using context manager (get_output): a file when --output is given, else stdout.
  const output_path = args.output ? new Path(args.output) : null;

  // @contextlib.contextmanager: returns [output, close] (the `with` enter/exit pair).
  function get_output(): [TextIO, () => void] {
    if (output_path) {
      const fd = host.fs.openSync(output_path.path, "w");
      return [{ write: (s: string) => host.fs.writeSync(fd, s) }, () => host.fs.closeSync(fd)];
    }
    return [{ write: (s: string) => process.stdout.write(s) }, () => {}];
  }

  const [output, close_output] = get_output();
  try {
    if (args.format === "text") {
      format_text(root_node, output, undefined, undefined, args.depth);
    } else if (args.format === "dot") {
      format_dot(root_node, output, args.depth);
    } else if (args.format === "mermaid") {
      format_mermaid(root_node, output, args.depth);
    } else if (args.format === "json") {
      format_json(root_node, output, args.depth);
    }
  } finally {
    close_output();
  }

  return 0;
}

// Python's `if __name__ == "__main__": sys.exit(main())`.
if (import.meta.main) {
  process.exitCode = main();
}
