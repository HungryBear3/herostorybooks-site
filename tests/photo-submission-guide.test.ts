import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const guideSource = readFileSync("src/components/photo-submission-guide.tsx", "utf8");
const checkoutSource = readFileSync("src/app/checkout/checkout-form.tsx", "utf8");
const homeSource = readFileSync("src/components/editorial-site.tsx", "utf8");
const pageSource = readFileSync("src/app/photo-guide/page.tsx", "utf8");

test("photo guide gives honest full-body, group, and likeness guidance", () => {
  assert.match(guideSource, /Full-body or group photos/);
  assert.match(guideSource, /tell us who to use and where they are/i);
  assert.match(guideSource, /separate clear face photo for each important character/i);
  assert.match(guideSource, /not a guarantee of an exact photographic likeness/i);
  assert.doesNotMatch(guideSource, /guarantee an exact likeness/i);
});

test("walkthrough is optional before checkout photo upload", () => {
  const photoSection = checkoutSource.slice(
    checkoutSource.indexOf("{/* ── 3. Hero photo ── */}"),
    checkoutSource.indexOf("{/* ── 4. Format + Delivery ── */}"),
  );
  const guideIndex = photoSection.indexOf("See which photos work best");
  const uploadIndex = photoSection.indexOf("Use camera roll");
  assert.ok(guideIndex > -1);
  assert.ok(uploadIndex > -1);
  assert.ok(guideIndex < uploadIndex);
  assert.match(checkoutSource, /<details className="group/);
  assert.match(checkoutSource, /<PhotoSubmissionGuide compact showCta=\{false\}/);
});

test("homepage and dedicated guide expose the same walkthrough", () => {
  assert.match(homeSource, /<PhotoSubmissionGuide \/>/);
  assert.match(pageSource, /canonical: "\/photo-guide"/);
  assert.match(pageSource, /<PhotoSubmissionGuide showGuideLink=\{false\} \/>/);
});

test("walkthrough media is local and privacy-safe", () => {
  assert.ok(existsSync("public/assets/photo-guide/photo-submission-walkthrough.mp4"));
  assert.ok(existsSync("public/assets/photo-guide/walkthrough-poster.png"));
  assert.match(guideSource, /private digital proof/i);
});
