import Hero from "@/components/landing/Hero";
import Opportunity from "@/components/landing/Opportunity";
import MarketsPreview from "@/components/landing/MarketsPreview";
import Community from "@/components/landing/Community";
import Articles from "@/components/landing/Articles";
import Subscribe from "@/components/landing/Subscribe";
import LandingFooter from "@/components/landing/LandingFooter";

export default function LandingPage() {
  return (
    <>
      <Hero />
      <Opportunity />
      <MarketsPreview />
      <Community />
      <Articles />
      <Subscribe />
      <LandingFooter />
    </>
  );
}
