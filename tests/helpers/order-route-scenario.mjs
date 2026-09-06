/**
 * Drives the REAL `/api/order` POST handler for one scenario and prints what
 * happened: the HTTP status, the response body, and the journal of every
 * external surface the route touched.
 *
 * Run in a child process with order-route-register.mjs installed, because the
 * resolve hook must be in place before the route imports anything, and because
 * a child guarantees one scenario's env cannot leak into the next.
 *
 * Everything is synthetic: no store, no Stripe key that resolves to an
 * account, no customer, no network.
 */
import { journal } from './order-route-fakes/journal.mjs';

const scenario = process.argv[2];

const INTAKE_ID = `intake_${'a'.repeat(32)}`;
const HERO_ASSET = `asset_${'b'.repeat(32)}`;
const FAMILY_ASSET = `asset_${'c'.repeat(32)}`;
const CAPABILITY = 'Zm9vYmFyLWNhcGFiaWxpdHktdG9rZW4tdmFsdWUtMDAx';

/** Nana carries no written description; Uncle Bo does. */
function familyCharacters({ withIds = true } = {}) {
  const entries = [
    { id: 'char-nana', role: 'grandparent', name: 'Nana', relationshipLabel: 'grandma', notes: '' },
    { id: 'char-bo', role: 'other', name: 'Uncle Bo', relationshipLabel: 'uncle', notes: 'tall, denim jacket' },
  ];
  return JSON.stringify(entries.map((entry) => {
    const base = {
      role: entry.role,
      name: entry.name,
      relationshipLabel: entry.relationshipLabel,
      pronouns: '',
      notes: entry.notes,
      isGiftRecipient: false,
      appearsInStory: true,
      photoFileName: null,
      mustInclude: [],
      mustIncludeOther: '',
      focusPersonLabel: null,
      cropHint: null,
    };
    return withIds ? { id: entry.id, ...base } : base;
  }));
}

const CASES = {
  // Honest request: Bo uploaded a reference photo, Nana wrote nothing.
  aligned: { declaredIds: ['char-nana', 'char-bo'], boundId: 'char-bo' },
  // Honest request: Nana uploaded, Bo wrote a description. Nothing is missing.
  'aligned-nana-photo': { declaredIds: ['char-nana', 'char-bo'], boundId: 'char-nana' },
  // The attack: the ids arrive reversed so Bo's photo exempts Nana.
  reordered: { declaredIds: ['char-bo', 'char-nana'], boundId: 'char-bo' },
  // A direct request whose characters carry no stable id at all.
  idless: { declaredIds: ['char-nana', 'char-bo'], boundId: 'char-bo', withIds: false },
  // Declared ids that do not describe this character list.
  foreign: { declaredIds: ['char-zed', 'char-bo'], boundId: 'char-bo' },
};

const config = CASES[scenario];
if (!config) throw new Error(`unknown scenario ${scenario}`);

const form = new FormData();
form.set('checkoutAttemptId', 'a'.repeat(32));
form.set('childName', 'Mina');
form.set('email', 'buyer@example.test');
form.set('theme', 'courage');
form.set('bookFormat', 'digital');
form.set('appearanceOptions', JSON.stringify({ description: 'curly hair, red boots' }));
form.set('familyCharacters', familyCharacters({ withIds: config.withIds !== false }));
form.set('checkoutIntakeCapability', CAPABILITY);
form.set('checkoutIntake', JSON.stringify({
  intakeId: INTAKE_ID,
  familyCharacterIds: config.declaredIds,
  selection: {
    primaryHeroPhotoAssetId: HERO_ASSET,
    familyCharacterAssets: [{ assetId: FAMILY_ASSET, familyCharacterId: config.boundId }],
    guidedStillAssetIds: [],
    voiceAssetId: null,
    documentAssetId: null,
  },
}));

const { POST } = await import('../../src/app/api/order/route.ts');
const response = await POST(new Request('https://herostorybooks.com/api/order', {
  method: 'POST',
  body: form,
}));

let body;
try { body = await response.json(); } catch { body = null; }

process.stdout.write(`__SCENARIO_JSON__${JSON.stringify({
  scenario,
  status: response.status,
  body,
  journal,
})}__END__\n`);
