"use client";

import { useState } from "react";
import { RevealText, ScrollWords, delay } from "./Reveal";

export default function Subscribe() {
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState("");
  const [invalid, setInvalid] = useState(false);

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) {
      setInvalid(true);
      setMsg(v ? "That email doesn't look right. Use the format name@example.com." : "Enter your email address to subscribe.");
      (e.currentTarget.elements.namedItem("email") as HTMLInputElement | null)?.focus();
      return;
    }
    setInvalid(false);
    setEmail("");
    setMsg("You're on the list. This is a prototype, so nothing was sent.");
  };

  return (
    <section className="subscribe" id="subscribe" aria-labelledby="sb-title">
      <div className="wrap">
        <div className="sb-head">
          <span className="pill on-dark" data-reveal="up">Subscribe</span>
          <RevealText as="h2" className="sb-title" id="sb-title" d={0.08}>Stay ahead and immerse yourself in a<br className="br-wide" /> world of cutting-edge information</RevealText>
          <ScrollWords className="sb-sub">By subscribing to Lendora, you'll receive a selection of interesting information delivered straight to your inbox. Our updates are designed to keep you informed.</ScrollWords>
        </div>
        <form className="sb-form" id="sb-form" noValidate onSubmit={onSubmit} data-reveal="up" style={delay(0.15)}>
          <label className="sr-only" htmlFor="sb-email">Email address</label>
          <input
            className="sb-input"
            id="sb-email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="Example@gmail.com"
            aria-describedby="sb-msg"
            aria-invalid={invalid || undefined}
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (invalid) { setInvalid(false); setMsg(""); }
            }}
          />
          <button className="sb-btn" type="submit">Subscribe</button>
        </form>
        <p className="sb-msg" id="sb-msg" role="status" aria-live="polite">{msg}</p>
      </div>
    </section>
  );
}
