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
  pyBool,
  repr,
  round,
  str,
  jsonDumps,
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
export function buildProjectNode(app: Application, includeProperties: boolean = true): Node {
  const project = app.project;
  const attrs: Map<string, AttrValue> = new Map<string, AttrValue>([
    ["version", app.version],
    ["build_number", app.buildNumber],
    ["bits_per_channel", BitsPerChannel.nameOf(project.bitsPerChannel)],
    ["expression_engine", project.expressionEngine],
  ]);
  if (project.effectNames?.length > 0) attrs.set("effects_used", project.effectNames.length);

  const children: Node[] = [];
  const root = project.rootFolder;
  for (const item of root) {
    children.push(buildItemNode(item, project, includeProperties));
  }

  // Add render queue if it has items
  if (project.renderQueue == null) {
    throw new RuntimeError("Project renderQueue should not be null");
  }
  if (project.renderQueue.items?.length > 0) {
    children.push(buildRenderQueueNode(project));
  }

  return {
    type: "Project",
    name: new Path(project.file).name,
    attrs,
    children,
  };
}

/** Build a node for any item type. */
export function buildItemNode(item: Item, project: Project, includeProperties: boolean = true): Node {
  if (item instanceof FolderItem) {
    return buildFolderNode(item, project, includeProperties);
  } else if (item instanceof CompItem) {
    return buildCompNode(item, project, includeProperties);
  } else if (item instanceof FootageItem) {
    return buildFootageNode(item);
  } else {
    return {
      type: "Item",
      name: item.name,
      attrs: new Map<string, AttrValue>([["typeName", item.typeName]]),
      children: [],
    };
  }
}

/** Build a folder node with its children. */
export function buildFolderNode(folder: FolderItem, project: Project, includeProperties: boolean = true): Node {
  const children: Node[] = [];
  for (const item of folder) {
    children.push(buildItemNode(item, project, includeProperties));
  }

  return {
    type: "Folder",
    name: folder.name,
    attrs: new Map<string, AttrValue>([
      ["label", folder.label !== 0 ? Label.nameOf(folder.label).toLowerCase() : null],
    ]),
    children,
  };
}

/** Build a composition node with layers. */
export function buildCompNode(comp: CompItem, project: Project, includeProperties: boolean = true): Node {
  const attrs: Map<string, AttrValue> = new Map<string, AttrValue>([
    ["size", `${comp.width}x${comp.height}`],
    ["duration", `${format(comp.duration, ".2f")}s`],
    ["frame_rate", pyfloat(comp.frameRate)],
    ["layers_count", comp.layers.length],
  ]);
  if (comp.markers?.length > 0) attrs.set("markers", comp.markers.length);

  const children: Node[] = [];
  for (const layer of comp.layers) {
    children.push(buildLayerNode(layer, project, includeProperties));
  }

  return {
    type: "Composition",
    name: comp.name,
    attrs,
    children,
  };
}

/** Build a footage item node. */
export function buildFootageNode(footage: FootageItem): Node {
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
export function buildLayerNode(layer: Layer, project: Project, includeProperties: boolean = true): Node {
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
  if (includeProperties) {
    // Transform properties
    if (layer.transform.length > 0) children.push(buildPropertyGroupNode(layer.transform));

    // Effects
    const effects = layer.effects;
    if (effects != null && effects.length > 0) children.push(buildPropertyGroupNode(effects));

    // Text properties
    if (layer.text instanceof PropertyGroup) children.push(buildPropertyGroupNode(layer.text));
  }

  return {
    type: "Layer",
    name: layer.name || "(unnamed)",
    attrs,
    children,
  };
}

/** Build a property group node. */
export function buildPropertyGroupNode(group: PropertyGroup): Node {
  const attrs: Map<string, boolean> = new Map<string, boolean>();
  if (group.isEffect) attrs.set("effect", true);

  const children = group.properties.map((p) => buildPropertyOrGroupNode(p));

  return {
    type: "PropertyGroup",
    name: group.name,
    attrs,
    children,
  };
}

/** Build a property or property group node. */
export function buildPropertyOrGroupNode(prop: Property | PropertyGroup): Node {
  if (prop instanceof PropertyGroup) return buildPropertyGroupNode(prop);
  return buildPropertyNode(prop);
}

/** Build a property node. */
export function buildPropertyNode(prop: Property): Node {
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
export function buildRenderQueueNode(project: Project): Node {
  if (project.renderQueue == null) {
    throw new RuntimeError("Project renderQueue should not be null");
  }
  const attrs: Map<string, AttrValue> = new Map<string, AttrValue>([["items", project.renderQueue.items.length]]);

  const children: Node[] = [];
  for (const [i, item] of project.renderQueue.items.entries()) {
    children.push(buildRenderQueueItemNode(item, i + 1, project));
  }

  return {
    type: "RenderQueue",
    name: "Render Queue",
    attrs,
    children,
  };
}

/** Build a render queue item node with output modules. */
export function buildRenderQueueItemNode(item: RenderQueueItem, index: number, project: Project): Node {
  const attrs: Map<string, AttrValue> = new Map<string, AttrValue>([["outputModules", item.outputModules.length]]);

  // Try to find the comp name
  const comp = item.comp;
  attrs.set("comp", comp?.name ?? null);

  const children: Node[] = [];
  for (const om of item.outputModules) {
    children.push(buildOutputModuleNode(om));
  }

  return {
    type: "RenderQueueItem",
    name: `Item ${index}`,
    attrs,
    children,
  };
}

/** Build an output module node. */
export function buildOutputModuleNode(om: OutputModule): Node {
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
export function formatText(
  node: Node,
  output: TextIO,
  prefix: string = "",
  isLast: boolean = true,
  maxDepth: number | null = null,
  currentDepth: number = 0,
): void {
  if (maxDepth != null && currentDepth > maxDepth) return;

  // Determine connector
  let connector = isLast ? "└── " : "├── ";
  if (currentDepth === 0) connector = "";

  // Format node line
  const typeIcon = new Map<string, string>([
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
  const icon = typeIcon.get(node.type) ?? "•";

  let attrsStr = "";
  if (node.attrs?.size > 0) {
    // Filter out None values
    const filtered = new Map<string, AttrValue>([...node.attrs].filter(([, v]) => v != null));
    if (filtered.size > 0) {
      attrsStr = " " + repr(filtered);
    }
  }

  output.write(`${prefix}${connector}${icon} ${node.name}${attrsStr}\n`);

  // Process children
  const children = node.children;
  let childPrefix = prefix + (isLast ? "    " : "│   ");
  if (currentDepth === 0) childPrefix = "";

  for (const [i, child] of children.entries()) {
    const isLastChild = i === children.length - 1;
    formatText(child, output, childPrefix, isLastChild, maxDepth, currentDepth + 1);
  }
}

/** Output as Graphviz DOT format. */
export function formatDot(node: Node, output: TextIO, maxDepth: number | null = null): void {
  output.write("digraph AEProject {\n");
  output.write("    rankdir=TB;\n");
  output.write('    node [shape=record, fontname="Helvetica", fontsize=10];\n');
  output.write("    edge [fontsize=8];\n");
  output.write("\n");

  const nodeId = [0]; // Use array for mutable counter in nested function

  function getNodeId(): string {
    nodeId[0] += 1;
    return `n${nodeId[0]}`;
  }

  /** Escape special characters for DOT labels. */
  function escapeDot(s: string): string {
    return s.replaceAll('"', '\\"').replaceAll("<", "\\<").replaceAll(">", "\\>").replaceAll("|", "\\|");
  }

  function writeNode(n: Node, parentId: string | null = null, depth: number = 0): string {
    if (maxDepth != null && depth > maxDepth) return "";

    const nid = getNodeId();

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
    const name = escapeDot(n.name);
    const attrs = n.attrs;
    const attrsLines: string[] = [];
    for (const [k, v] of attrs) {
      if (v != null) attrsLines.push(`${k}: ${escapeDot(str(v))}`);
    }

    let label: string;
    if (attrsLines.length > 0) {
      label = "{{" + n.type + "|" + name + "|" + attrsLines.join("\\l") + "\\l}}";
    } else {
      label = "{{" + n.type + "|" + name + "}}";
    }

    output.write(`    ${nid} [label="${label}", style=filled, fillcolor="${color}"];\n`);

    if (parentId) {
      output.write(`    ${parentId} -> ${nid};\n`);
    }

    for (const child of n.children) {
      writeNode(child, nid, depth + 1);
    }

    return nid;
  }

  writeNode(node);
  output.write("}\n");
}

/** Output as Mermaid flowchart. */
export function formatMermaid(node: Node, output: TextIO, maxDepth: number | null = null): void {
  output.write("```mermaid\nflowchart TD\n");

  const nodeId = [0];

  function getNodeId(): string {
    nodeId[0] += 1;
    return `n${nodeId[0]}`;
  }

  /** Escape special characters for Mermaid. */
  function escapeMermaid(s: string): string {
    return s.replaceAll('"', "'").replaceAll("<", "‹").replaceAll(">", "›");
  }

  function writeNode(n: Node, parentId: string | null = null, depth: number = 0): string {
    if (maxDepth != null && depth > maxDepth) return "";

    const nid = getNodeId();
    const name = escapeMermaid(n.name);
    const nodeType = n.type;

    // Different shapes for different types
    let shape: string;
    if (nodeType === "Project") {
      shape = `${nid}[["🎬 ${name}"]]`;
    } else if (nodeType === "Folder") {
      shape = `${nid}[/"📁 ${name}"/]`;
    } else if (nodeType === "Composition") {
      shape = `${nid}[("🎬 ${name}")]`;
    } else if (nodeType === "Footage") {
      shape = `${nid}[("🎞️ ${name}")]`;
    } else if (nodeType === "Layer") {
      shape = `${nid}["📄 ${name}"]`;
    } else {
      shape = `${nid}("${name}")`;
    }

    output.write(`    ${shape}\n`);

    if (parentId) {
      output.write(`    ${parentId} --> ${nid}\n`);
    }

    for (const child of n.children) {
      writeNode(child, nid, depth + 1);
    }

    return nid;
  }

  writeNode(node);
  output.write("```\n");
}

/** A {@link Node} as {@link formatJson} emits it: children past `maxDepth` collapse to a summary string. */
type JsonNode = Omit<Node, "children"> & { children: JsonNode[] | string };

/** Output as JSON. */
export function formatJson(node: Node, output: TextIO, maxDepth: number | null = null): void {
  function filterDepth(n: Node, depth: number = 0): JsonNode {
    if (maxDepth != null && depth >= maxDepth) {
      const result: JsonNode = { ...n };
      if (n.children.length > 0) {
        result.children = `[${n.children.length} children omitted]`;
      }
      return result;
    }

    const result: JsonNode = { ...n };
    if (n.children.length > 0) {
      result.children = n.children.map((c) => filterDepth(c, depth + 1));
    }
    return result;
  }

  const filtered = filterDepth(node);
  output.write(jsonDumps(filtered, { indent: 2, default_: str }));
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
  aepFile: string;
  format: string;
  depth: number | null;
  noProperties: boolean;
  output: string | null;
};

/** The long options, in argparse's registration order (which orders an ambiguity error's matches). */
export const LONG_OPTIONS = ["--help", "--format", "--depth", "--no-properties", "--output"];

/**
 * argparse's `parseArgs` for exactly the options this CLI declares: long and
 * short forms, unambiguous long-option prefixes, `--opt=value`, `-fVALUE`, `--`.
 *
 * TODO(port): no argparse shim. HELP/USAGE are argparse's layout for its default 80-column
 * (non-tty) width (argparse wraps to COLUMNS or the terminal width), and an unrecognized option
 * or extra positional errors at once where argparse first reports a missing aep_file.
 */
export function parseArgs(argv: string[]): Args {
  const fail = (msg: string): never => {
    process.stderr.write(`${USAGE}${PROG}: error: ${msg}\n`);
    process.exit(2);
  };

  const choices = ["text", "dot", "mermaid", "json"];
  const args: Args = { aepFile: "", format: "text", depth: null, noProperties: false, output: null };
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
  let onlyPositional = false;
  const takeValue = (label: string, inline: string | null): string => {
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
    if (!onlyPositional && a === "--") {
      onlyPositional = true;
    } else if (!onlyPositional && a.startsWith("--")) {
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
        args.noProperties = true;
      } else if (flag === "--format") {
        apply("--format", takeValue("--format/-f", inline));
      } else if (flag === "--depth") {
        apply("--depth", takeValue("--depth/-d", inline));
      } else if (flag === "--output") {
        apply("--output", takeValue("--output/-o", inline));
      } else {
        fail(`unrecognized arguments: ${a}`);
      }
    } else if (!onlyPositional && a.length > 1 && a.startsWith("-") && !/^-\d/.test(a)) {
      const flag = a.slice(0, 2);
      const rest = a.slice(2);
      if (flag === "-h") {
        process.stdout.write(HELP);
        process.exit(0);
      } else if (flag === "-f") {
        apply("--format", takeValue("--format/-f", rest.length ? rest : null));
      } else if (flag === "-d") {
        apply("--depth", takeValue("--depth/-d", rest.length ? rest : null));
      } else if (flag === "-o") {
        apply("--output", takeValue("--output/-o", rest.length ? rest : null));
      } else {
        fail(`unrecognized arguments: ${a}`);
      }
    } else {
      positionals.push(a);
    }
  }

  if (positionals.length === 0) fail("the following arguments are required: aep_file");
  if (positionals.length > 1) fail(`unrecognized arguments: ${positionals.slice(1).join(" ")}`);
  args.aepFile = positionals[0];
  return args;
}

/** CLI entry point for aep-visualize command. */
export function main(): number {
  const args = parseArgs(process.argv.slice(2));

  const aepPath = new Path(args.aepFile);
  if (!aepPath.exists()) {
    process.stderr.write(`Error: File not found: ${aepPath}\n`);
    return 1;
  }

  const app = parse(aepPath);

  const includeProperties = !args.noProperties;
  const rootNode = buildProjectNode(app, includeProperties);

  // Output using context manager (get_output): a file when --output is given, else stdout.
  const outputPath = args.output ? new Path(args.output) : null;

  // @contextlib.contextmanager: returns [output, close] (the `with` enter/exit pair).
  function getOutput(): [TextIO, () => void] {
    if (outputPath) {
      const fd = host.fs.openSync(outputPath.path, "w");
      return [{ write: (s: string) => host.fs.writeSync(fd, s) }, () => host.fs.closeSync(fd)];
    }
    return [{ write: (s: string) => process.stdout.write(s) }, () => {}];
  }

  const [output, closeOutput] = getOutput();
  try {
    if (args.format === "text") {
      formatText(rootNode, output, undefined, undefined, args.depth);
    } else if (args.format === "dot") {
      formatDot(rootNode, output, args.depth);
    } else if (args.format === "mermaid") {
      formatMermaid(rootNode, output, args.depth);
    } else if (args.format === "json") {
      formatJson(rootNode, output, args.depth);
    }
  } finally {
    closeOutput();
  }

  return 0;
}

// Python's `if __name__ == "__main__": sys.exit(main())`.
if (import.meta.main) {
  process.exitCode = main();
}
