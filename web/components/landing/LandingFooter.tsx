"use client";

import { useToast } from "./Toast";
import { delay } from "./Reveal";

const COLS = [
  { title: "Contact & About", label: "Contact and about", links: ["Contact", "Book a demo", "About Us", "Get a quote", "Reviews", "Team", "Industries"] },
  { title: "Technical", label: "Technical", links: ["Release Notes", "Service Status", "Sitemap"] },
  { title: "Terms & Conditions", label: "Terms and conditions", links: ["Terms & Conditions", "Service Level Agreement", "Cookie Policy", "Privacy Policy"] },
];

export default function Footer() {
  const toast = useToast();
  const open = (e: React.MouseEvent) => {
    e.preventDefault();
    toast("That page isn't part of this prototype.");
  };

  return (
    <footer className="site-footer">
      <div className="wrap">
        <div className="ft-grid">
          <div className="ft-intro" data-reveal="up">
            <a className="ft-brand" href="#" aria-label="Lendora home" onClick={open}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3h13l-3.4 5.2H4.6z" /><path d="M16 15.8H3l3.4-5.2h13z" /><path d="M6 21h11l-2.6-3.6H3.4z" opacity=".55" /></svg>
              Lendora
            </a>
            <p className="ft-about">Our analysis provides valuable insights for investors and enthusiasts, guiding them through the complexities of the crypto market</p>
          </div>
          {COLS.map((c, i) => (
            <nav className="ft-col" aria-label={c.label} key={c.title} data-reveal="up" style={delay(0.1 * (i + 1))}>
              <h3>{c.title}</h3>
              <ul>
                {c.links.map((l) => (
                  <li key={l}><a href="#" onClick={open}>{l}</a></li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
      </div>
    </footer>
  );
}
