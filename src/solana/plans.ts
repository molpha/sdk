/** On-chain subscription plan (`PlanType` in the Molpha program IDL). */
export enum PlanType {
  Basic = 0,
  Standard = 1,
  Professional = 2,
  Enterprise = 3,
}

/** Numeric plan index used for PDA derivation and on-chain reads. */
export type PlanId = 0 | 1 | 2 | 3;

const PLAN_VARIANTS = [
  { basic: {} },
  { standard: {} },
  { professional: {} },
  { enterprise: {} },
] as const;

export function planVariant(planId: PlanId): (typeof PLAN_VARIANTS)[number] {
  return PLAN_VARIANTS[planId];
}

export function planIdFromVariant(variant: Record<string, unknown>): PlanId {
  const key = Object.keys(variant)[0]?.toLowerCase();
  const idx = ["basic", "standard", "professional", "enterprise"].indexOf(key ?? "");
  if (idx < 0) throw new Error(`Unknown plan variant: ${JSON.stringify(variant)}`);
  return idx as PlanId;
}
