"use client";

import { useToast } from "./Toast";
import WorldMap from "./WorldMap";
import { RevealText, ScrollWords, delay } from "./Reveal";

export default function Community() {
  const toast = useToast();

  return (
    <section className="community" id="community" aria-labelledby="cm-title">
      <div className="wrap">
        <div className="cm-head">
          <span className="pill on-dark" data-reveal="up">Community</span>
          <RevealText as="h2" className="cm-title" id="cm-title" d={0.08}>We&apos;ve navigated various paths</RevealText>
          <ScrollWords className="cm-sub">Lendora has been innovating since 2016, and remains a trusted guide in the crypto space</ScrollWords>
        </div>

        <div className="cm-grid">
          <article className="cm-join" data-reveal="up">
            <h3>Become a<br />member of a global<br />community</h3>
            <p>More than six million crypto enthusiasts around the world have accessed our award-winning ecosystem.</p>
            <a
              className="join-btn"
              href="#"
              onClick={(e) => {
                e.preventDefault();
                toast("Membership sign-up isn't part of this prototype.");
              }}
            >
              Join Lendora
            </a>
          </article>

          <article className="cm-card cm-reg" data-reveal="up" style={delay(0.12)}>
            <h3>Fully regulated<br />and audited</h3>
            <p>We work closely with regulators around the globe to ensure our services are properly vetted and pride ourselves on taking the next step when it comes to user protections.</p>
            <div className="mock" aria-hidden="true">
              <div className="mock-back"><div className="bar"></div><p>Keep your information up-to-date</p></div>
              <div className="mock-front">
                <span className="hexicon"><svg viewBox="0 0 24 24"><circle cx="7.5" cy="12" r="3.6" /><path d="M11 12h10M18 12v3.2M21 12v2.4" /></svg></span>
                <p>Set up Authenticator</p>
              </div>
            </div>
          </article>

          <article className="cm-card cm-map-card" data-reveal="up" style={delay(0.24)}>
            <h3>Global availability</h3>
            <p>Our community of six million global users enjoy peace of mind across multiple jurisdictions. Lendora has offices in Singapore, Malaysia and Lithuania.</p>
            <div className="map"><WorldMap /></div>
          </article>
        </div>
      </div>
    </section>
  );
}
