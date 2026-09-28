"use client";

import { useToast } from "./Toast";
import { RevealText, ScrollWords, delay } from "./Reveal";

const navy = { stroke: "#1a1150", strokeWidth: 2 };
const purple = { stroke: "#4b33b0" };
const label = { fill: "#fff", fontFamily: "Instrument Sans,Arial,sans-serif" };

export default function Articles() {
  const toast = useToast();
  const open = (e: React.MouseEvent) => {
    e.preventDefault();
    toast("Articles aren't part of this prototype.");
  };

  return (
    <section className="articles" id="articles" aria-labelledby="ar-title">
      <div className="wrap">
        <span className="pill on-dark" data-reveal="up">Article</span>
        <RevealText as="h2" className="ar-title" id="ar-title" d={0.08}>About Cryptocurrencies</RevealText>
        <ScrollWords className="ar-sub">We examine the fundamental principles, emerging trends, and transformative potential that define the world of digital assets</ScrollWords>

        <div className="ar-grid">
          <a data-reveal="up" style={delay(0)} className="ar-card" href="#" onClick={open}>
            <div className="ar-ill">
              <svg className="ill" viewBox="0 0 333 228" aria-hidden="true">
                <rect className="ms" x="10" y="12" width="190" height="10" rx="3" />
                <rect className="wh" x="16" y="22" width="178" height="126" rx="4" />
                <rect className="or" x="38" y="38" width="88" height="10" rx="5" />
                <rect className="nv" x="38" y="62" width="72" height="3" /><rect className="nv" x="38" y="74" width="72" height="3" /><rect className="nv" x="38" y="86" width="72" height="3" />
                <circle className="nv" cx="120" cy="63.5" r="1.6" /><circle className="nv" cx="120" cy="75.5" r="1.6" /><circle className="nv" cx="120" cy="87.5" r="1.6" />
                <circle className="wh" cx="64" cy="118" r="21" style={navy} />
                <path className="or" d="M64 118V97A21 21 0 0 1 85 118Z" /><path className="pp" d="M64 118H85A21 21 0 0 1 64 139Z" /><path className="nv" d="M64 118V139A21 21 0 0 1 43 118Z" />
                <rect className="nv" x="108" y="126" width="66" height="2.5" />
                <rect className="pp" x="114" y="108" width="12" height="18" /><rect className="pd" x="132" y="96" width="12" height="30" /><rect className="pp" x="150" y="82" width="12" height="44" />
                <rect className="or" x="126" y="134" width="52" height="3" /><rect className="or" x="126" y="141" width="52" height="3" />
                <path className="pp" d="M232 118Q262 104 300 118Q324 132 324 204L226 204Q222 152 232 118Z" />
                <path className="wh" d="M256 112L274 112L278 204L254 204Z" />
                <path className="ln" d="M236 134Q214 142 202 162" style={{ ...purple, strokeWidth: 15 }} />
                <path className="wh" d="M150 140L198 128L208 186L160 198Z" style={{ stroke: "#d9d5ee", strokeWidth: 2 }} />
                <path className="ln" d="M246 124Q216 108 186 100" style={{ ...purple, strokeWidth: 15 }} />
                <circle className="sk" cx="181" cy="98" r="7" />
                <circle className="sk" cx="268" cy="80" r="22" />
                <path className="or" d="M244 78Q243 54 270 55Q294 57 291 80Q277 67 259 72Q250 74 244 78Z" />
                <circle className="or" cx="293" cy="57" r="12" />
                <circle className="ln" cx="259" cy="84" r="7" style={navy} /><circle className="ln" cx="277" cy="84" r="7" style={navy} /><path className="ln" d="M266 84h4" style={navy} />
              </svg>
            </div>
            <div className="ar-txt"><h3>Study Crypto. Master The Future</h3><p>Hit the books on everything from blockchain fundamentals, to advanced trading techniques, to on-chain analysis.</p></div>
          </a>

          <a data-reveal="up" style={delay(0.12)} className="ar-card" href="#" onClick={open}>
            <div className="ar-ill">
              <svg className="ill" viewBox="0 0 333 228" aria-hidden="true">
                <path className="ln" d="M104 222H148V196H182V168H212V138H258V112H296" style={{ ...purple, strokeWidth: 3 }} />
                <path className="or" d="M93.8 193.5L106.2 206.5L202.2 114.5L211.2 123.8L224.8 80.4L180.8 92.2L189.8 101.5Z" />
                <circle className="or" cx="262" cy="54" r="31" />
                <circle className="ln" cx="262" cy="54" r="25" style={{ stroke: "#fff", strokeWidth: 2.5 }} />
                <text x="262" y="66" textAnchor="middle" fontSize="36" fontWeight="700" style={label}>$</text>
                <path className="ln" d="M116 122L112 192" style={{ stroke: "#fff", strokeWidth: 17 }} />
                <path className="ln" d="M132 122L166 146L158 174" style={{ stroke: "#fff", strokeWidth: 17 }} />
                <path className="ln" d="M102 198L124 200" style={{ ...purple, strokeWidth: 9 }} />
                <path className="ln" d="M150 180L174 182" style={{ ...purple, strokeWidth: 9 }} />
                <path className="pp" d="M102 76L140 76L146 126L108 126Z" />
                <path className="ln" d="M138 84L192 66" style={{ stroke: "#fff", strokeWidth: 12 }} />
                <circle className="sk" cx="196" cy="65" r="6.5" />
                <path className="ln" d="M108 84L86 106" style={{ stroke: "#fff", strokeWidth: 12 }} />
                <circle className="sk" cx="84" cy="108" r="6.5" />
                <circle className="sk" cx="122" cy="58" r="14" />
                <path className="nv" d="M107 57Q107 42 123 42Q137 44 136 58Q126 52 107 57Z" />
              </svg>
            </div>
            <div className="ar-txt"><h3>How do I use Stop orders in spot trading?</h3><p>In spot trading, stop orders can be used as both standalone and complementary orders...</p></div>
          </a>

          <a data-reveal="up" style={delay(0.24)} className="ar-card" href="#" onClick={open}>
            <div className="ar-ill">
              <svg className="ill" viewBox="0 0 333 228" aria-hidden="true">
                <path className="pp" d="M56 84L122 88L132 196L48 196Q38 140 56 84Z" />
                <circle className="sk" cx="88" cy="52" r="21" />
                <path className="nv" d="M65 50Q64 26 90 28Q110 31 108 52Q99 43 84 42Q72 42 65 50Z" />
                <circle className="wh" cx="82" cy="56" r="2.6" style={{ fill: "#1a1150" }} /><circle className="wh" cx="97" cy="57" r="2.6" style={{ fill: "#1a1150" }} />
                <path className="ln" d="M222 84H162A43 43 0 0 0 162 170H222" style={{ stroke: "#f1eefb", strokeWidth: 30 }} />
                <rect className="pd" x="210" y="69" width="30" height="30" />
                <rect className="or" x="210" y="155" width="30" height="30" />
                <path className="ln" d="M64 100Q42 138 66 176" style={{ stroke: "#fff", strokeWidth: 22 }} />
                <path className="ln" d="M104 96L170 72" style={{ stroke: "#fff", strokeWidth: 16 }} />
                <circle className="sk" cx="178" cy="70" r="8" />
                <circle className="sk" cx="118" cy="196" r="8" />
                <ellipse className="or" cx="284" cy="126" rx="24" ry="42" />
                <ellipse className="ln" cx="284" cy="126" rx="18" ry="35" style={{ stroke: "#fff", strokeWidth: 2 }} />
                <text x="284" y="140" textAnchor="middle" fontSize="40" fontWeight="700" style={label}>$</text>
                <path className="ln" d="M312 102H330M314 114H330M314 132H330M310 146H326" style={{ stroke: "#d9d5ee", strokeWidth: 2 }} />
              </svg>
            </div>
            <div className="ar-txt"><h3>What is shorting in the financial market?</h3><p>When the stock market became more accessible to curious participants in the early 20th Century...</p></div>
          </a>
        </div>
      </div>
    </section>
  );
}
