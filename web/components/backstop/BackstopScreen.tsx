"use client";
import {FX_BACKSTOP} from "@/lib/fixtures";
import {useSession} from "@/components/shell/SessionBar";
import {BackstopView} from "./BackstopView";

export function BackstopScreen() {
  const {now} = useSession();
  return <BackstopView b={FX_BACKSTOP} now={now} />;
}
