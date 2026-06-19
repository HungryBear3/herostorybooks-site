import { lukasDinoArtDirectionFixture } from './lukas-dino-valid.ts';

export const lukasDinoMissingContinuityFixture = structuredClone(lukasDinoArtDirectionFixture) as any;

delete lukasDinoMissingContinuityFixture.storyboard.entries[1].continuity_callback;
delete lukasDinoMissingContinuityFixture.storyboard.entries[1].required_recurring_objects;
