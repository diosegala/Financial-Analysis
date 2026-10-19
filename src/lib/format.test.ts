import { describe, expect, it } from "vitest";
import { fmtInput, parseNum } from "./format";

describe("parseNum", () => {
  it.each([
    ["1.234,56", 1234.56],
    ["1234,56", 1234.56],
    ["7,6", 7.6],
    ["1234.56", 1234.56],
    ["1,234.56", 1234.56],
    ["7.6", 7.6],
    ["2.5", 2.5],
    ["0.125", 0.125],
    ["1.234", 1234],
    ["1.234.567", 1234567],
    ["1,234,567", 1234567],
    ["R$ 1.500,00", 1500],
    ["15%", 15],
    ["-10", -10],
    ["(1.000,00)", -1000],
    ["  42  ", 42],
    ["", 0],
  ])("%s → %d", (input, expected) => {
    expect(parseNum(input)).toBeCloseTo(expected);
  });

  it.each(["abc", "1,2,3x", "--", "1.2.3,4,5"])("rejeita %s", (input) => {
    expect(parseNum(input)).toBeNull();
  });
});

describe("fmtInput", () => {
  it("não mostra ruído de ponto flutuante", () => {
    expect(fmtInput(0.07 * 100)).toBe("7");
    expect(fmtInput(12.5)).toBe("12,5");
    expect(fmtInput(1234.5)).toBe("1234,5");
  });
});
