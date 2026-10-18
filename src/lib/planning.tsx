import { createContext, useContext, useState, type ReactNode } from "react";
import { YEAR } from "./format";

interface PlanningState {
  unitId: string | null;
  setUnitId: (id: string) => void;
  scenarioId: string | null;
  setScenarioId: (id: string) => void;
  year: number;
}

const PlanningContext = createContext<PlanningState | null>(null);

export function PlanningProvider({ children }: { children: ReactNode }) {
  const [unitId, setUnitId] = useState<string | null>(null);
  const [scenarioId, setScenarioId] = useState<string | null>(null);
  return (
    <PlanningContext.Provider value={{ unitId, setUnitId, scenarioId, setScenarioId, year: YEAR }}>
      {children}
    </PlanningContext.Provider>
  );
}

export function usePlanning(): PlanningState {
  const ctx = useContext(PlanningContext);
  if (!ctx) throw new Error("usePlanning fora do PlanningProvider");
  return ctx;
}
