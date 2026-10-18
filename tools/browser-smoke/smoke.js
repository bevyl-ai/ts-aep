// Shared by index.html (browser) and run.ts (hostless run under Bun):
// load each sample into memfs, parse, save, and compare the bytes.
export async function smoke(py_aep, fetch_bytes, samples, log) {
  py_aep.useMemoryFs();
  let identical = 0;
  const problems = [];
  for (const [i, name] of samples.entries()) {
    try {
      py_aep.memfs.clear();
      const input = await fetch_bytes(name);
      py_aep.memfs.write("/in.aep", input);
      py_aep.parse("/in.aep").project.save("/out/saved.aep");
      const output = py_aep.memfs.read("/out/saved.aep");
      const same = output.length === input.length && output.every((v, j) => v === input[j]);
      if (same) identical++;
      else problems.push(`DIFF ${name}`);
      log(`${i + 1}/${samples.length} ${same ? "identical" : "DIFF"} ${name}`);
    } catch (e) {
      problems.push(`FAIL ${name}: ${e?.constructor?.name}: ${e?.message}`);
      log(`${i + 1}/${samples.length} FAIL ${name}: ${e?.message}`);
    }
  }
  return { backend: py_aep.fsBackend(), total: samples.length, identical, problems };
}
