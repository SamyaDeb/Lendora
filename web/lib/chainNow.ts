"use client";
import {useEffect, useState} from "react";

/** Chain time: the API's snapshot time plus the time since it was fetched (anvil and testnets run ahead of the wall clock). */
export function useChainNow(asOfTime: string | undefined, fetchedAt: number) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  if (!asOfTime || !fetchedAt) return now;
  return Math.floor(Date.parse(asOfTime) / 1000 + (now * 1000 - fetchedAt) / 1000);
}
