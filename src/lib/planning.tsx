import { createContext, useContext, type ReactNode } from "react";
import type { Scenario, Unit, Version } from "./catalog";
import type { SubmissionStatus } from "./submissions";

/** Unit / version / scenario selected in the header. Kept in the URL by the app shell. */
export interface PlanningState {
  unitId: string | null;
  unit: Unit | null;
  versionId: string | null;
  version: Version | null;
  scenarioId: string | null;
  scenario: Scenario | null;
  year: number | null;
  /** Status de envio da unidade na versão. */
  submissionStatus: SubmissionStatus;
  /** O usuário pode lançar valores (não folha) nesta unidade e versão agora. */
  canEdit: boolean;
  /** Mensagem explicando por que não pode editar, quando canEdit = false. */
  lockReason: string | null;
  setUnitId: (id: string) => void;
  setVersionId: (id: string) => void;
  setScenarioId: (id: string) => void;
}

const PlanningContext = createContext<PlanningState | null>(null);

export function PlanningProvider({
  value,
  children,
}: {
  value: PlanningState;
  children: ReactNode;
}) {
  return <PlanningContext.Provider value={value}>{children}</PlanningContext.Provider>;
}

export function usePlanning(): PlanningState {
  const ctx = useContext(PlanningContext);
  if (!ctx) throw new Error("usePlanning fora do PlanningProvider");
  return ctx;
}
