import { describe, expect, it } from "vitest";
import { adjustFrom, monthRange } from "./plan-data";

describe("helpers da grade", () => {
  it("monthRange corta em dezembro", () => {
    expect(monthRange(1, 3)).toEqual([1, 2, 3]);
    expect(monthRange(11, 6)).toEqual([11, 12]);
    expect(monthRange(5, 0)).toEqual([]);
  });
  it("adjustFrom reajusta só a partir do mês", () => {
    const values = new Map([
      [1, 100],
      [6, 100],
      [7, 200],
    ]);
    expect(adjustFrom(values, 6, 0.1)).toEqual([
      { month: 6, amount: 110 },
      { month: 7, amount: 220 },
    ]);
  });
});
