import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const KILL_SWITCH_REFUSAL_PREFIX = 'KILL_SWITCH_ACTIVE';

export type KillSwitchId =
  | 'checkout_pause'
  | 'proof_release_hold'
  | 'owner_print_go_hold'
  | 'marketing_hold'
  | 'provider_hold'
  | 'print_provider_hold';

export type KillSwitchMode = 'enforced' | 'manual';

export interface KillSwitchDefinition {
  id: KillSwitchId;
  label: string;
  mode: KillSwitchMode;
  summary: string;
  enforcement: string;
}

export interface KillSwitchState {
  active: boolean;
  reason: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface KillSwitchEvent extends KillSwitchState {
  id: KillSwitchId;
}

export interface KillSwitchSnapshotItem extends KillSwitchDefinition, KillSwitchState {}

export interface KillSwitchSnapshot {
  switches: KillSwitchSnapshotItem[];
  history: KillSwitchEvent[];
  generatedAt: string;
}

export interface UpdateKillSwitchInput {
  id: KillSwitchId;
  active: boolean;
  reason?: string | null;
  updatedBy: string;
  now?: string;
}

interface KillSwitchStore {
  states: Partial<Record<KillSwitchId, KillSwitchState>>;
  history: KillSwitchEvent[];
}

export const KILL_SWITCH_DEFINITIONS: KillSwitchDefinition[] = [
  {
    id: 'checkout_pause',
    label: 'KS-1 Checkout pause',
    mode: 'enforced',
    summary: 'Refuses new checkout requests before form parsing, uploads, or Stripe session creation.',
    enforcement: '/api/order returns 503 before customer data is processed.',
  },
  {
    id: 'proof_release_hold',
    label: 'KS-2 Proof release hold',
    mode: 'enforced',
    summary: 'Blocks QA pass from releasing digital delivery or proof-ready customer email.',
    enforcement: 'releaseOrderAfterQa refuses before release lock, state advance, or email transport.',
  },
  {
    id: 'owner_print_go_hold',
    label: 'KS-3 Owner print-go hold',
    mode: 'enforced',
    summary: 'Blocks owner print-go before the durable print intent lock is acquired.',
    enforcement: 'recordOwnerPrintGo / submitPrintAfterOwnerGo refuse before lock or provider side effect.',
  },
  {
    id: 'marketing_hold',
    label: 'KS-4 Marketing hold',
    mode: 'manual',
    summary: 'Manual traffic/creator/gifting/social stop flag for operator visibility.',
    enforcement: 'Status-only: no automated marketing integrations are wired in this app.',
  },
  {
    id: 'provider_hold',
    label: 'KS-5 Provider hold',
    mode: 'manual',
    summary: 'Manual generation/provider stop flag for operator visibility.',
    enforcement: 'Status-only: generation routing has policy guards but no single provider toggle here.',
  },
  {
    id: 'print_provider_hold',
    label: 'KS-6 Print-provider hold',
    mode: 'enforced',
    summary: 'Blocks Lulu/RPI print submission after owner print-go but before provider call.',
    enforcement: 'runPrintProduction refuses before submitting_to_print and before submitPrintJob.',
  },
];

const IDS = new Set<KillSwitchId>(KILL_SWITCH_DEFINITIONS.map((item) => item.id));

export function isKillSwitchId(value: unknown): value is KillSwitchId {
  return typeof value === 'string' && IDS.has(value as KillSwitchId);
}

export function killSwitchStatePath(): string {
  return process.env.HSB_KILL_SWITCH_STATE_PATH
    || path.join(/* turbopackIgnore: true */ process.cwd(), 'ops', 'state', 'hsb-kill-switches.json');
}

function emptyState(): KillSwitchState {
  return { active: false, reason: null, updatedBy: null, updatedAt: null };
}

async function readStore(): Promise<KillSwitchStore> {
  try {
    const raw = await readFile(killSwitchStatePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<KillSwitchStore>;
    return {
      states: parsed.states ?? {},
      history: Array.isArray(parsed.history) ? parsed.history.filter((event) => isKillSwitchId(event.id)) : [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { states: {}, history: [] };
    }
    throw error;
  }
}

async function writeStore(store: KillSwitchStore): Promise<void> {
  const file = killSwitchStatePath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

export async function getKillSwitchSnapshot(): Promise<KillSwitchSnapshot> {
  const store = await readStore();
  const switches = KILL_SWITCH_DEFINITIONS.map((definition) => ({
    ...definition,
    ...(store.states[definition.id] ?? emptyState()),
  }));
  return {
    switches,
    history: store.history.slice(-50).reverse(),
    generatedAt: new Date().toISOString(),
  };
}

export async function updateKillSwitch(input: UpdateKillSwitchInput): Promise<KillSwitchSnapshotItem> {
  if (!isKillSwitchId(input.id)) {
    throw new Error('UNKNOWN_KILL_SWITCH');
  }
  const updatedBy = input.updatedBy.trim().slice(0, 120);
  if (!updatedBy) {
    throw new Error('UPDATED_BY_REQUIRED');
  }
  const reason = (input.reason ?? '').trim().slice(0, 500);
  if (input.active && !reason) {
    throw new Error('REASON_REQUIRED_WHEN_ACTIVE');
  }

  const now = input.now ?? new Date().toISOString();
  const nextState: KillSwitchState = {
    active: input.active,
    reason: reason || null,
    updatedBy,
    updatedAt: now,
  };
  const store = await readStore();
  store.states[input.id] = nextState;
  store.history = [
    ...(store.history ?? []),
    { id: input.id, ...nextState },
  ].slice(-200);
  await writeStore(store);

  const definition = KILL_SWITCH_DEFINITIONS.find((item) => item.id === input.id);
  if (!definition) throw new Error('UNKNOWN_KILL_SWITCH');
  return { ...definition, ...nextState };
}

export async function isKillSwitchActive(id: KillSwitchId): Promise<boolean> {
  const store = await readStore();
  return store.states[id]?.active === true;
}

export function killSwitchRefusal(id: KillSwitchId, label: string): string {
  return `${KILL_SWITCH_REFUSAL_PREFIX}: ${label} is active`;
}
