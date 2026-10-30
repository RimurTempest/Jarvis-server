import test from "node:test";
import assert from "node:assert";
import { searchNewsArticles } from "./news-search.mjs";

test("searchNewsArticles constructs valid query payload", () => {
  const result = searchNewsArticles({
    source: "The New York Times",
    politicalFigure: "Jane Doe",
    startDate: "2023-01-01",
    endDate: "2023-01-31",
    maxResults: 10,
  });

  assert.strictEqual(result.query, "Jane Doe");
  assert.strictEqual(result.filterQuery, 'source:("The New York Times")');
  assert.deepStrictEqual(result.dateRange, { start: "2023-01-01", end: "2023-01-31" });
  assert.strictEqual(result.maxResults, 10);
});

test("searchNewsArticles rejects invalid date range", () => {
  assert.throws(() => {
    searchNewsArticles({
      source: "The New York Times",
      politicalFigure: "Jane Doe",
      startDate: "2023-02-01",
      endDate: "2023-01-01",
    });
  }, RangeError);
});
