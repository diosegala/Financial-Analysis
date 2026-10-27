import { describe, expect, it } from "vitest";
import { buildBoard, supportShares, type BoardUnit } from "./board";
import type { Unit } from "./catalog";

const unit = (id: string, kind: string): Unit =>
  ({ id, name: id, kind, active: true }) as unknown as Unit;
const months = (v: number) => Array(12).fill(v) as number[];

describe("supportShares", () => {
  it("usa o critério gravado antes da meta e da receita", () => {
    const r = supportShares(
      ["a", "b"],
      new Map([["a", 0.3]]),
      new Map([["b", 1]]),
      new Map([["a", 10]]),
    );
    expect(r.basis).toBe("criterio");
    expect(r.shares.get("a")).toBe(1);
    expect(r.shares.get("b")).toBe(0);
  });

  it("sem critério, usa a meta normalizada; sem meta, a receita; sem nada, partes iguais", () => {
    const meta = supportShares(
      ["a", "b"],
      new Map(),
      new Map([
        ["a", 0.2],
        ["b", 0.6],
      ]),
      new Map(),
    );
    expect(meta.basis).toBe("meta");
    expect(meta.shares.get("a")).toBeCloseTo(0.25);
    const rec = supportShares(
      ["a", "b"],
      new Map(),
      new Map(),
      new Map([
        ["a", 30],
        ["b", 10],
      ]),
    );
    expect(rec.basis).toBe("receita");
    expect(rec.shares.get("a")).toBeCloseTo(0.75);
    expect(supportShares(["a", "b"], new Map(), new Map(), new Map()).shares.get("b")).toBe(0.5);
  });
});

describe("buildBoard", () => {
  it("rateia o resultado do apoio e fecha com o total da empresa", () => {
    const board = buildBoard({
      units: [unit("neg1", "negocio"), unit("neg2", "negocio"), unit("rh", "apoio")],
      revenue: new Map([
        ["neg1", months(300)],
        ["neg2", months(100)],
      ]),
      recurring: new Map([["neg1", months(100)]]),
      result: new Map([
        ["neg1", months(120)],
        ["neg2", months(40)],
        ["rh", months(-80)],
      ]),
      target: new Map(),
      custom: new Map(),
      targetShares: new Map(),
    });
    expect(board.basis).toBe("receita");
    const [n1, n2] = board.units as [BoardUnit, BoardUnit];
    expect(n1.support[0]).toBeCloseTo(-60);
    expect(n2.support[0]).toBeCloseTo(-20);
    const after = board.units.reduce((a, u) => a + (u.result[0] ?? 0) + (u.support[0] ?? 0), 0);
    expect(after).toBeCloseTo(120 + 40 - 80);
  });
});
