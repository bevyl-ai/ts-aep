// Tests assert on warnings through `warns()`; keep the rest off stderr.
import { setWarningHandler } from "../src/pyrt/errors.ts";

setWarningHandler(() => {});
