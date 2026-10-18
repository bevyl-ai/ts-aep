/**
 * Behaviors where the port once differed from py-aep, checked against values
 * py-aep (CPython 3.12) returns for the same input.
 *
 * Port-only: these pin Python stdlib behavior the shims reproduce.
 */

import { expect, test } from "bun:test";
import { ByteStream, encode } from "../../src/pyrt/index.ts";

import { _probeMgjson } from "../../src/py_aep/resolvers/media_probe.ts";
import { raises } from "../support/pytest.ts";

function mgjson(times: string[]): ByteStream {
  const doc = { dataDynamicSamples: [{ samples: times.map((time) => ({ time })) }] };
  return new ByteStream(encode(JSON.stringify(doc), "utf-8"));
}

test.each<[string[], number]>([
  // datetime.fromisoformat: basic format and ISO week dates.
  [["20200101T000000", "2020-W01-3T00:00:10"], 10.033333333333333],
  // Aware datetimes (an offset the trailing-offset strip leaves) compare in UTC.
  [["2020-01-01T00:00:00+05", "2020-01-01T00:00:00+04"], 3600.0333333333333],
])("test_mgjson_sample_times[%#]", (times, duration) => {
  expect(_probeMgjson(mgjson(times)).duration).toBe(duration);
});

test("test_mgjson_naive_and_aware_times", () => {
  raises(TypeError, () => _probeMgjson(mgjson(["2020-01-01T00:00:00", "2020-01-01T00:00:01+05"])), "can't compare offset-naive and offset-aware datetimes");
});
