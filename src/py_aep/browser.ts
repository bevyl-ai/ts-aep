// Entry for bundled hosts (browsers, Workers): the dependencies Node and Bun load
// on first use are imported here and handed to pyrt.
import * as fontkit from "fontkit";
import * as yaml from "yaml";
import { provideDep } from "../pyrt/deps.ts";

provideDep("fontkit", fontkit);
provideDep("yaml", yaml);

export * from "./index.ts";
