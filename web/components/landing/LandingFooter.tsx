"use client";

import { delay } from "./Reveal";

const COLS = [
  { title: "Product", links: [["Markets", "/markets"], ["Portfolio", "/portfolio"], ["Short-interest data", "/data"], ["Alerts", "/alerts"]] },
  { title: "Developers", links: [["Public API", "/data"], ["System status", "/status"]] },
  { title: "Legal", links: [["Terms and risks", "/terms"]] },
];

export default function Footer() {
  return (
    <footer className="site-footer">
      <div className="wrap">
        <div className="ft-grid">
          <div className="ft-intro" data-reveal="up">
            <a className="ft-brand" href="/" aria-label="Lendora home">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3h13l-3.4 5.2H4.6z" /><path d="M16 15.8H3l3.4-5.2h13z" /><path d="M6 21h11l-2.6-3.6H3.4z" opacity=".55" /></svg>
              Lendora
            </a>
            <p className="ft-about">A lending market for Stock Tokens on Robinhood Chain, built on Morpho Blue, with live public short-interest data.</p>
          </div>
          {COLS.map((c, i) => (
            <nav className="ft-col" aria-label={c.title} key={c.title} data-reveal="up" style={delay(0.1 * (i + 1))}>
              <h3>{c.title}</h3>
              <ul>
                {c.links.map(([l, h]) => (
                  <li key={l}><a href={h}>{l}</a></li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
        <p className="ft-legal">
          Not an offer of securities and not investment advice. Rates and APYs are variable. Borrowed positions can be liquidated. Not available in the United States, Canada, the United Kingdom, Switzerland, the UAE or sanctioned regions.
        </p>
      </div>
    </footer>
  );
}
