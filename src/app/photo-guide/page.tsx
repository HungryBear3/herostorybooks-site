import type { Metadata } from "next";

import { PhotoSubmissionGuide } from "@/components/photo-submission-guide";
import { EditorialPageShell } from "@/components/editorial-site";

export const metadata: Metadata = {
  title: "Photo Guide for Personalized Storybooks | HeroStoryBooks",
  description:
    "See which child, family, and pet photos work best for a personalized HeroStoryBooks story and how private proof approval works.",
  alternates: { canonical: "/photo-guide" },
};

export default function PhotoGuidePage() {
  return (
    <EditorialPageShell>
      <PhotoSubmissionGuide showGuideLink={false} />
    </EditorialPageShell>
  );
}
